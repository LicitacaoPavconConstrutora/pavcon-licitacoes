// =============================================================================
// Edge Function: orcafascio-cadastrar-orcamento
// =============================================================================
// CRIAÇÃO COMPLETA do orçamento no Orçafascio via API interna /v2023/.
//
// Fluxo:
//   1. Auth web (cookie _orcafascio_session via orcafascio-web-auth helper)
//   2. POST /orc/orcamentos          → cria budget, capta budget_id
//   3. POST /v2023/.../update_bases  → bancos de referência (SINAPI, etc.)
//   4. POST /v2023/.../update_bdi    → BDI extraído da licitação
//   5. POST /v2023/.../update_leis_sociais → encargos sociais
//   6. POST /v2023/bud/budgets/{id}/items/ → BATCH com etapas + composições
//   7. Atualiza orcafascio_orcamento_id na licitação + status=fase1_concluida
//
// Body (JSON):
//   {
//     "licitacao_id": "uuid",       // obrigatório
//     "credential_id": "uuid",       // obrigatório — provider=orcafascio + auth_type=web
//     "trace_id": "uuid"             // opcional
//   }
//
// Resposta 200:
//   {
//     "ok": true,
//     "budget_id": "6a087cb1...",
//     "budget_url": "https://app.orcafascio.com/orc/orcamentos/...",
//     "etapas_criadas": 7,
//     "composicoes_criadas": 16,
//     "trace_id": "..."
//   }
// =============================================================================

import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import {
  getServiceRoleClient,
  HttpError,
  requireAuthenticatedUser,
} from '../_shared/supabase.ts';
import {
  authenticateOrcafascioWeb,
  OrcafascioWebError,
} from '../_shared/orcafascio-web.ts';
import {
  addItemsBatch,
  type BudgetItem,
  createBudget,
  createContext,
  fonteToBase,
  OrcafascioV2023Error,
  updateBases,
  updateBdi,
  updateLeisSociais,
  uuidv4,
} from '../_shared/orcafascio-web-v2023.ts';
import {
  ajustarValorViaProxy,
  AjustarValorProxyError,
} from '../_shared/ajustar-valor-proxy.ts';

interface RequestBody {
  licitacao_id?: string;
  credential_id?: string;
  trace_id?: string;
  /** Se true, força ajustarValor inline (chama dentro deste request).
   * DEFAULT FALSE desde jun/2026 — ajustarValor inline corrompe budgets.
   * Quando false, orçamento sai com total = soma dos items (pode divergir
   * do edital). Usar "Forçar total" do OrçaPav AI pra ajuste manual depois. */
  forcar_total_inline?: boolean;
  /** DEPRECATED — sem efeito desde jun/2026 (default agora é não forçar). */
  pular_forcar_total_edital?: boolean;
  /** Cria uma 2ª versão como PROPOSTA. BDI permanece igual ao edital
   * (regra de licitação: desconto não incide sobre BDI). Pra aplicar o
   * desconto, futuras iterações vão enviar pu_override por item — esta
   * versão da Edge Function ainda não suporta isso (TODO). */
  proposta?: {
    /** Prefixo no título do orçamento. Default: 'PROPOSTA - ' */
    titulo_prefix?: string;
    /** TODO: pu sobrescrito por item_codigo pra aplicar desconto
     * seletivo (não incide sobre mão de obra). */
    pus_override?: Record<string, number>;
  };
}

const ERR_AUTH_TO_HTTP: Record<OrcafascioWebError['code'], number> = {
  credential_not_found: 404,
  credential_inactive: 403,
  credential_wrong_provider: 400,
  credential_no_email: 422,
  credential_wrong_auth_type: 400,
  vault_unreadable: 500,
  csrf_not_found: 502,
  login_rejected: 422,
  login_unreachable: 502,
  login_unexpected: 502,
};

// Bancos suportados pelo Orçafascio /v2023/.../update_bases.
// Inspeção do form real revelou:
// - `has_state: true` → form tem select `{nome}_estado` (precisa enviar)
// - `has_state: false` → estado implícito (NÃO mandar `_estado`, gera 500)
// Nomes seguem EXATAMENTE o que aparece no form HTML (ex: 'SICRO3', não 'SICRO').
const ORCAFASCIO_BANKS: Record<string, { has_state: boolean }> = {
  SINAPI: { has_state: true },
  SBC: { has_state: true },
  SICRO3: { has_state: true },
  SETOP: { has_state: true },
  EMBASA: { has_state: true },
  // Estado implícito (single-state ou regional)
  SIURB: { has_state: false },
  'SIURB INFRA': { has_state: false },
  FDE: { has_state: false },
  CPOS: { has_state: false },
  EMOP: { has_state: false },
  SCO: { has_state: false },
  SUDECAP: { has_state: false },
  IOPES: { has_state: false },
  ORSE: { has_state: false },
  SEINFRA: { has_state: false },
  CAEMA: { has_state: false },
  CAERN: { has_state: false },
  COMPESA: { has_state: false },
  AGESUL: { has_state: false },
  'AGETOP CIVIL': { has_state: false },
  'AGETOP RODOVIARIA': { has_state: false },
  SEDOP: { has_state: false },
  DERPR: { has_state: false },
};

// Extrai data MM/AAAA do data_base_descricao pra um banco específico.
// Estado só é relevante pra bancos com `has_state: true` (SINAPI, SICRO3, etc.).
//
// data_base_descricao costuma ser separado por vírgula com formatos mistos:
//   "SINAPI PI 02/2026, SEINFRA CE 28, ORSE SE 01/2026, SICRO PI 10/2025"
// → SEINFRA: data="28" (não MM/AAAA), ORSE: estado="SE" + data="01/2026"
// Converte nome de mês PT-BR pra "MM/AAAA". Aceita variações comuns vindas
// do LLM: "Janeiro/2026", "jan/26", "fevereiro de 2026", "fev/2026".
function parseMesNomeado(raw: string): string | null {
  const meses: Record<string, string> = {
    jan: '01', janeiro: '01',
    fev: '02', fevereiro: '02',
    mar: '03', marco: '03', março: '03',
    abr: '04', abril: '04',
    mai: '05', maio: '05',
    jun: '06', junho: '06',
    jul: '07', julho: '07',
    ago: '08', agosto: '08',
    set: '09', setembro: '09',
    out: '10', outubro: '10',
    nov: '11', novembro: '11',
    dez: '12', dezembro: '12',
  };
  // Casa "fevereiro/2026", "fev/26", "fevereiro de 2026"
  const m = raw.toLowerCase().match(/([a-zç]+)(?:\s*\/\s*|\s+de\s+)(\d{4}|\d{2})/);
  if (!m) return null;
  const mm = meses[m[1]];
  if (!mm) return null;
  const year = m[2].length === 2 ? `20${m[2]}` : m[2];
  return `${mm}/${year}`;
}

function inferBaseData(
  cabecalho: Record<string, unknown> | null,
  banco: string,
): { estado: string; data: string } {
  const desc = String(cabecalho?.data_base_descricao ?? '');
  const ufLicit = String(cabecalho?.uf ?? 'PI').toUpperCase().slice(0, 2);
  // Split por vírgula: cada token contém info de 1 banco
  const tokens = desc.split(/[,;]/).map((t) => t.trim());
  const variantes = [banco, banco.replace(/3$/, ''), banco + '3'];
  for (const v of variantes) {
    const re = new RegExp(`^\\s*${v}\\b`, 'i');
    const token = tokens.find((t) => re.test(t));
    if (!token) continue;
    const ufMatch = token.match(/\b([A-Z]{2})\b/);
    let data = '';
    // BUG CORRIGIDO (SEINFRA - cooper, jun/2026):
    // Antes a regex `\d{1,2}\/\d{2,4}` aplicada em "2025/12" capturava
    // "25/12" do MEIO da string — gerava data inválida "25/2012" (mês 25
    // não existe, ano 2012 longe demais). Orçafascio configurava bancos
    // com versão fantasma e budget virava 500 ao abrir.
    //
    // Agora detecta AAAA/MM antes de MM/AAAA — ordem importa.
    // (1) AAAA/MM: "2025/12" → "12/2025"
    const anoMesMatch = token.match(/\b(\d{4})\/(\d{1,2})\b/);
    if (anoMesMatch) {
      data = `${anoMesMatch[2].padStart(2, '0')}/${anoMesMatch[1]}`;
    } else {
      // (2) MM/AAAA ou MM/AA: "12/2025", "01/26"
      const mmYy = token.match(/\b(\d{1,2})\/(\d{2,4})\b/);
      if (mmYy) {
        const year = mmYy[2].length === 2 ? `20${mmYy[2]}` : mmYy[2];
        data = `${mmYy[1].padStart(2, '0')}/${year}`;
      } else {
        // (3) Número puro 2-3 dígitos: SEINFRA "028"
        const numero = token.match(/\b(\d{2,3})\b(?![A-Za-z])/);
        if (numero) data = numero[1];
      }
    }
    // Sanity check: ano resultante tem que ser razoável (2020-2030).
    // Se sair fora, descarta — falla pro fallback de "mês passado".
    const yearCheck = data.match(/\/(\d{4})/);
    if (yearCheck) {
      const y = Number(yearCheck[1]);
      if (y < 2020 || y > 2030) data = '';
    }
    // Fallback no token: tenta nome de mês ("Janeiro/2026")
    if (!data) {
      const nomeado = parseMesNomeado(token);
      if (nomeado) data = nomeado;
    }
    if (data) {
      return { estado: (ufMatch?.[1] ?? ufLicit).toUpperCase(), data };
    }
  }
  // Token não casou com nome do banco — quando data_base_descricao traz só
  // a data sem mencionar o banco (ex: "Janeiro/2026"), aplica a todos.
  // Bug observado em "Reforma estádio Batalha": cabecalho = "Janeiro/2026"
  // virava fallback "mês passado" = 04/2026 → Orçafascio rejeitou e ficou
  // com 01/2026 default da empresa, mas os codes modernos do edital
  // (jan/2026) zeravam porque ainda não existem na base antiga.
  const direto = parseMesNomeado(desc);
  if (direto) {
    return { estado: ufLicit, data: direto };
  }
  // Tenta AAAA/MM ou MM/AAAA direto na desc inteira (mesmo fix do bloco acima)
  const anoMesD = desc.match(/\b(\d{4})\/(\d{1,2})\b/);
  if (anoMesD) {
    const year = Number(anoMesD[1]);
    if (year >= 2020 && year <= 2030) {
      return { estado: ufLicit, data: `${anoMesD[2].padStart(2, '0')}/${year}` };
    }
  }
  const dataMatch = desc.match(/\b(\d{1,2})\/(\d{2,4})\b/);
  if (dataMatch) {
    const yy = dataMatch[2];
    const year = yy.length === 2 ? `20${yy}` : yy;
    if (Number(year) >= 2020 && Number(year) <= 2030) {
      return { estado: ufLicit, data: `${dataMatch[1].padStart(2, '0')}/${year}` };
    }
  }
  // Último recurso: mês passado
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const data = `${String(lastMonth.getMonth() + 1).padStart(2, '0')}/${lastMonth.getFullYear()}`;
  return { estado: ufLicit, data };
}

Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return errorResponse(405, 'Método não permitido. Use POST.');
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'JSON inválido no body.');
  }

  const licitacaoId = body.licitacao_id?.trim();
  const credentialId = body.credential_id?.trim();
  if (!licitacaoId) return errorResponse(400, 'licitacao_id é obrigatório.');
  if (!credentialId) return errorResponse(400, 'credential_id é obrigatório (web auth_type=web).');

  const traceId = body.trace_id ?? crypto.randomUUID();
  const isProposta = body.proposta != null;
  const admin = getServiceRoleClient();

  try {
    const user = await requireAuthenticatedUser(req);

    // ---- 1) Carrega licitação + composições -----------------------------------
    const { data: licitacao, error: licErr } = await admin
      .from('licitacoes')
      .select('id, titulo, numero_edital, orgao_licitante, municipio, uf, status, bdi_referencia_edital')
      .eq('id', licitacaoId)
      .maybeSingle();
    if (licErr || !licitacao) {
      return errorResponse(404, 'Licitação não encontrada.', licErr?.message);
    }
    const ALLOWED = new Set([
      'aguardando_revisao_humana',
      'criando_composicoes_edital',
      'criando_orcamento_base',
      'fase1_concluida',
    ]);
    if (!ALLOWED.has(licitacao.status)) {
      return errorResponse(
        409,
        `Licitação está em "${licitacao.status}" — precisa estar em: ${[...ALLOWED].join(', ')}.`,
      );
    }

    // Pega o JSON extraído pra cabecalho (BDI, leis sociais, bases)
    const { data: extr } = await admin
      .from('extracoes_ocr')
      .select('json_corrigido, json_extraido')
      .eq('licitacao_id', licitacaoId)
      .in('status', ['sucesso', 'revisada_humano'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const json = (extr?.json_corrigido ?? extr?.json_extraido) as {
      cabecalho?: Record<string, unknown>;
    } | null;
    const cabecalho = json?.cabecalho ?? null;
    // BDI sempre = BDI do edital (regra de licitação: desconto não incide
    // sobre BDI, ele permanece igual entre edital e proposta).
    const bdiEdital = Number(cabecalho?.bdi_percentual ?? licitacao.bdi_referencia_edital ?? 22);
    const bdiPct = bdiEdital;
    const leisHorista = Number(cabecalho?.leis_sociais_percentual ?? 113.78);
    const comDesoneracao = Boolean(cabecalho?.com_desoneracao);
    const basesUtilizadas = Array.isArray(cabecalho?.bases_utilizadas)
      ? (cabecalho.bases_utilizadas as string[])
      : ['SINAPI'];

    // Pega composições ordenadas
    const { data: comps, error: compErr } = await admin
      .from('composicoes_extraidas')
      .select(
        'id, item_codigo, item_nivel, item_pai_codigo, tipo_linha, codigo, fonte, descricao, quantidade, preco_total, orcafascio_composition_id, ordem',
      )
      .eq('licitacao_id', licitacaoId)
      .order('ordem', { ascending: true });
    if (compErr) {
      return errorResponse(500, 'Falha ao ler composicoes_extraidas.', compErr.message);
    }
    if (!comps || comps.length === 0) {
      return errorResponse(422, 'Nenhuma composição extraída pra cadastrar.');
    }

    // ---- 2) Transição: criando_orcamento_base --------------------------------
    // PROPOSTA: não transiciona status (orçamento base já existe e está fase1_concluida)
    if (!isProposta && ['aguardando_revisao_humana', 'criando_composicoes_edital'].includes(licitacao.status)) {
      // Vai pra criando_composicoes_edital se estiver em aguardando_revisao_humana
      if (licitacao.status === 'aguardando_revisao_humana') {
        await admin.from('licitacoes').update({ status: 'criando_composicoes_edital' }).eq('id', licitacaoId);
      }
      await admin.from('licitacoes').update({ status: 'criando_orcamento_base' }).eq('id', licitacaoId);
    }

    // ---- 3) Auth web no Orçafascio -------------------------------------------
    const session = await authenticateOrcafascioWeb(admin, credentialId, {
      callerUserId: user.id,
      traceId,
      licitacaoId,
    });

    const ctx = await createContext(
      admin, session, credentialId, user.id, licitacaoId, traceId,
      // Recovery: se sessão cacheada expirou silenciosamente no Orçafascio,
      // refaz login (forceRefresh) e tenta de novo o CSRF.
      () => authenticateOrcafascioWeb(admin, credentialId, {
        callerUserId: user.id,
        forceRefresh: true,
        traceId,
        licitacaoId,
      }),
    );

    // ---- 4) Cria o budget ----------------------------------------------------
    // Codigo precisa ser único — adiciona suffix com data+hora pra evitar conflito
    // de unicidade no Orçafascio (caso o orçamentista crie múltiplos pra mesma obra).
    // Inclui segundos no stamp pra evitar colisão quando 2 retries acontecem
    // no mesmo minuto. Bug observado em Batalha: dois POST /orc/orcamentos
    // em 21:40:26 e 21:40:59 geravam o mesmo codigo "BATALHA 2026-06-02 21:40",
    // Rails validava unicidade e redirecionava o segundo pra /orc/orcamentos/new
    // (em vez do /orcamentos/<id>/new_passo_2 esperado), causando o erro
    // "createBudget: não consegui extrair budget_id do redirect".
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const baseCod = (licitacao.municipio ?? 'OBRA').toUpperCase().slice(0, 30);
    const tituloPrefix = body.proposta?.titulo_prefix ?? (isProposta ? 'PROPOSTA - ' : '');
    const codigo = `${isProposta ? 'PROP ' : ''}${baseCod} ${stamp}`.slice(0, 50);
    const descricao = `${tituloPrefix}${licitacao.titulo ?? 'Orçamento gerado pelo bot'}`.slice(0, 250);

    const { budget_id } = await createBudget(ctx, {
      codigo,
      descricao,
      standard_category_name: 'Infraestruturas Esportivas - Reforma',
      licitacao: true,
      version_2023: true,
      mask_itemization: true,
      insumos_zerados: true,
      rounding_option: 1,
    });

    // ---- 5/6/7) Configurações best-effort ------------------------------------
    // Essas chamadas podem falhar individualmente sem matar o fluxo (o crítico
    // é criar o budget + add items, que vem depois). Coletamos warnings.
    const warnings: string[] = [];

    // Normaliza variantes pro nome canônico do Orçafascio.
    // Ex: 'SICRO' → 'SICRO3' (Orçafascio usa SICRO3 oficial).
    function normalizeBanco(b: string): string {
      const u = b.toUpperCase().trim();
      if (u.startsWith('SINAPI')) return 'SINAPI';
      if (u.startsWith('SICRO')) return 'SICRO3'; // SICRO ou SICRO3 → SICRO3
      if (u.startsWith('SEINFRA')) return 'SEINFRA';
      if (u.startsWith('ORSE')) return 'ORSE';
      if (u.startsWith('SBC')) return 'SBC';
      if (u.startsWith('FDE')) return 'FDE';
      if (u.startsWith('SUDECAP')) return 'SUDECAP';
      if (u.startsWith('SETOP')) return 'SETOP';
      if (u.startsWith('EMBASA')) return 'EMBASA';
      if (u.startsWith('CPOS')) return 'CPOS';
      if (u.startsWith('EMOP')) return 'EMOP';
      if (u.startsWith('SCO')) return 'SCO';
      if (u.startsWith('IOPES')) return 'IOPES';
      if (u.startsWith('CAEMA')) return 'CAEMA';
      if (u.startsWith('CAERN')) return 'CAERN';
      if (u.startsWith('COMPESA')) return 'COMPESA';
      if (u.startsWith('AGESUL')) return 'AGESUL';
      if (u.startsWith('SEDOP')) return 'SEDOP';
      if (u.startsWith('DERPR')) return 'DERPR';
      if (u.startsWith('SIURB INFRA')) return 'SIURB INFRA';
      if (u.startsWith('SIURB')) return 'SIURB';
      if (u.startsWith('AGETOP CIVIL')) return 'AGETOP CIVIL';
      if (u.startsWith('AGETOP RODOVIARIA')) return 'AGETOP RODOVIARIA';
      return u;
    }
    // FILTRO DE BANCOS REALMENTE USADOS:
    // Antes enviávamos TODOS os bancos do cabecalho.bases_utilizadas mesmo
    // que nenhum item da licitação usasse aquele banco. Orçafascio ao
    // configurar 8+ bancos junta tudo no renderer e dispara 500
    // "Ocorreu um erro durante esse processo" ao abrir o budget
    // (observado em SEGOV-SLZ, SEFIR Pavussu, etc — todos com 7+ bancos).
    //
    // Fix: cruzar com fontes que realmente aparecem em comps.fonte;
    // bancos "fantasmas" (mencionados no cabecalho mas sem items) são
    // descartados antes mesmo do filtro ORCAFASCIO_BANKS.
    const fontesComItens = new Set(
      (comps as Array<{ fonte: string | null }>)
        .map((c) => normalizeBanco(c.fonte ?? ''))
        .filter((f) => f && f !== 'PROPRIA'),
    );
    const bancos = Array.from(new Set(basesUtilizadas.map(normalizeBanco)))
      .filter((b) => fontesComItens.has(b))
      .filter((b) => b in ORCAFASCIO_BANKS)
      .map((nome) => {
        const meta = ORCAFASCIO_BANKS[nome];
        const { estado, data } = inferBaseData(cabecalho, nome);
        // Só inclui `estado` se o banco tiver select de estado no form.
        // Bancos com estado implícito (ORSE, SEINFRA, etc.) NÃO devem receber
        // _estado — gera 500 no Orçafascio.
        return {
          nome,
          ...(meta.has_state ? { estado } : {}),
          data,
          exibir_relatorio: true,
          // Truncar em 2 casas decimais (regra de licitação: nosso valor
          // NUNCA pode ficar acima do edital — arredondamento half-up pode
          // somar centavos por cima e desclassificar). O default do
          // Orçafascio é "não arredondar" → preços com 4+ casas que somam
          // valores levemente diferentes do edital. Truncar 2 casas bate
          // exatamente com a planilha do órgão.
          rounding_option: 2,
        };
      });
    if (bancos.length > 0) {
      // updateBases agora lê os defaults do form (todos os ~23 bancos) e
      // faz merge com os que queremos sobrescrever. Rails exige form completo.
      try {
        await updateBases(ctx, budget_id, {
          bancos,
          atualizar_composicoes: true,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        warnings.push(
          `updateBases falhou (configurar manualmente no Orçafascio): ${msg.slice(0, 150)}`,
        );
      }
    }

    try {
      // no_final=false: BDI incide sobre o preço UNITÁRIO da composição
      // (método recomendado pelo TCU e usado pelos orçamentos base do
      // órgão). Faz com que o total por item já apareça com BDI no Orçafascio,
      // batendo com a planilha do edital.
      await updateBdi(ctx, budget_id, { bdi_manual: bdiPct, no_final: false });
    } catch (e) {
      warnings.push(`updateBdi falhou: ${e instanceof Error ? e.message.slice(0, 150) : String(e)}`);
    }

    try {
      await updateLeisSociais(ctx, budget_id, {
        desonerado: comDesoneracao,
        charge_hourly: leisHorista,
        charge_monthly: leisHorista * 0.629, // razão típica horista→mensalista (71.59/113.78)
      });
    } catch (e) {
      warnings.push(`updateLeisSociais falhou: ${e instanceof Error ? e.message.slice(0, 150) : String(e)}`);
    }

    // ---- 8) Monta batch new_items[] -----------------------------------------
    const items: BudgetItem[] = [];
    let etapasCriadas = 0;
    let composicoesCriadas = 0;

    for (const c of comps) {
      if (c.tipo_linha === 'grupo') {
        items.push({
          kind: 'phase',
          itemization: c.item_codigo,
          descr: (c.descricao ?? '').slice(0, 200),
          parent_descr: c.item_pai_codigo
            ? (comps.find((x) => x.item_codigo === c.item_pai_codigo)?.descricao ?? '').slice(0, 200)
            : '',
          qty: 1,
        });
        etapasCriadas++;
      } else if (c.tipo_linha === 'servico') {
        // Pra fonte=PROPRIA, usar a composição cadastrada no MyBase (via cadastrar-edital).
        // `code` PRECISA ser o código humano da composição no MyBase (ex:
        // '2da42d41_1.1'), não o ObjectId nem o valor genérico do edital.
        // Quando enviamos `code` diferente do que está em MyBase, Orçafascio
        // não resolve o public_banco_id → valor R$ 0,00 no orçamento.
        const isPropria = c.fonte === 'PROPRIA';
        // PRECISA usar o MESMO formato de cadastrar-edital.ts pra Orçafascio
        // achar a composição no MyBase via public_banco_id + code. Sem pontos —
        // find_by_code dá 500 silencioso pra codes com múltiplos pontos.
        // Estratégia: usa código próprio do edital quando preenchido (mais
        // legível pro orçamentista), senão fallback pra COMPOSIC_<item>.
        const sanitize = (raw: string): string =>
          raw.normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toUpperCase().trim()
            .replace(/[^A-Z0-9_-]/g, '_')
            .replace(/_+/g, '_').replace(/^_|_$/g, '')
            .slice(0, 40);
        // Code com PREFIXO da licitação — espelha cadastrar-edital pra
        // garantir que orçamento e MyBase apontem pra mesma composição
        // (sem colisão silenciosa entre licitações com codes genéricos
        // como COMP01). Vide comentário no cadastrar-edital pra contexto.
        const licShort = licitacaoId.slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, '');
        const codigoBase = (
          c.codigo && (c.codigo as string).trim()
            ? sanitize(c.codigo as string)
            : `COMPOSIC_${sanitize(c.item_codigo as string)}`
        );
        const mybaseCode = `${licShort}_${codigoBase}`.slice(0, 50);
        // NORMALIZAÇÃO DE CÓDIGOS (SEINFRA cooper, jun/2026):
        // Codes extraídos do PDF às vezes têm formatação atípica que faz
        // Orçafascio não encontrar no catálogo → item entra com R$ 0,00.
        // Exemplos vistos:
        //   - SINAPI "00040647" (leading zeros) → catálogo tem "40647"
        //   - ORSE "S98525S" (letras prefixo/sufixo) → catálogo tem "98525"
        // Aplicamos só pra bancos referenciais; PROPRIA mantém code original
        // (já vai prefixado com licShort_).
        function normalizarCodeBanco(rawCode: string, fonte: string | null): string {
          const f = (fonte ?? '').toUpperCase();
          const trimmed = String(rawCode).trim();
          if (f === 'SINAPI') {
            // SINAPI: só dígitos. Remove leading zeros.
            const onlyDigits = trimmed.replace(/[^0-9]/g, '');
            return onlyDigits.replace(/^0+/, '') || onlyDigits;
          }
          if (f === 'ORSE') {
            // ORSE: principalmente dígitos com prefixo opcional. Remove
            // letras nas pontas que costumam ser ruído ("S98525S" → "98525")
            return trimmed.replace(/^[A-Za-z]+|[A-Za-z]+$/g, '') || trimmed;
          }
          // SICRO/SEINFRA/etc: mantém como está (alfanuméricos válidos)
          return trimmed;
        }
        const codeOriginal = c.codigo ?? '';
        const codeNormalizado = isPropria ? mybaseCode : normalizarCodeBanco(codeOriginal, c.fonte);
        if (codeOriginal !== codeNormalizado && !isPropria) {
          console.log(`[cadastrar-orcamento] code normalizado: ${c.fonte}/${codeOriginal} → ${codeNormalizado} (item ${c.item_codigo})`);
        }
        if (!codeNormalizado) continue;
        if (isPropria && !c.orcafascio_composition_id) continue;

        items.push({
          kind: 'composition',
          itemization: c.item_codigo,
          base: fonteToBase(c.fonte),
          base_id: uuidv4(),
          public_banco_id: isPropria ? c.orcafascio_composition_id ?? '' : '',
          code: String(codeNormalizado),
          qty: Number(c.quantidade ?? 0),
        });
        composicoesCriadas++;
      }
    }

    if (items.length > 0) {
      // Envia em UM chunk grande sempre que possível. Bug observado em PM
      // CASTANHAL: com chunks de 50, o 2º chunk retornava 200 OK mas 4 dos
      // 17 macrosserviços ficavam "perdidos" no Orçafascio (provavelmente
      // race condition na referência parent_descr entre chunks independentes).
      // Mandando tudo num só batch o Orçafascio processa em ordem com
      // consistência hierárquica garantida.
      //
      // Limite empírico: ~300 items dentro do limite de body urlencoded.
      // Pra orçamentos maiores, fragmenta em chunks de 300 — risco de
      // race entre chunks volta, mas raro.
      const CHUNK = 300;
      for (let i = 0; i < items.length; i += CHUNK) {
        await addItemsBatch(ctx, budget_id, items.slice(i, i + CHUNK));
      }
    }

    // ---- 8.4) AUTO-CORREÇÃO DO TOTAL (consciência do agente) ---------------
    // CONTEXTO: o orçamento da Pavcon TEM que casar com o valor do orçamento
    // do órgão. Divergências comuns (PUs do SINAPI da versão atual diferentes
    // do edital, codes que zeram silenciosamente, BDI/leis sociais aplicados
    // de forma sutilmente diferente, etc) causam variações de 5-30% no total.
    //
    // Pra resolver isso automaticamente, no FINAL do cadastro chamamos
    // ajustarValor(budgetId, totalExtraido) que aplica um fator linear em
    // TODOS os items pra o total bater exato com o que veio do edital.
    //
    // Trade-off: o ajuste é LINEAR (mesmo % pra todos), então a distribuição
    // interna entre items pode ficar imperfeita. Mas o TOTAL bate — que é
    // o que o órgão avalia no julgamento da proposta.
    //
    // Opt-out: body.pular_forcar_total_edital=true.
    if (!isProposta && body.forcar_total_inline === true) {
      // AUTO-AJUSTE opt-in (default false desde jun/2026).
      //
      // IMPORTANTE (jul/2026): NÃO chama mais ajustarValor() direto (HTTP
      // puro) — corrompia o budget (visto em SEINFRA PI e outros, 500 ao
      // abrir). Delega pra ajustarValorViaProxy (automação de navegador via
      // Cláudio Proxy, ver _shared/ajustar-valor-proxy.ts). Se o proxy não
      // estiver configurado (ou a automação falhar), cai no mesmo warning
      // de antes pedindo pra usar "Forçar total" no OrçaPav AI — nunca
      // arrisca corromper o budget.
      const totalExtraido = (comps ?? [])
        .filter((c) => c.tipo_linha === 'servico')
        .reduce((s, c) => s + (Number(c.preco_total) || 0), 0);
      if (totalExtraido > 0) {
        try {
          await new Promise((r) => setTimeout(r, 3000));
          const ajusteResult = await ajustarValorViaProxy(admin, session, {
            budgetId: budget_id,
            valorFinal: totalExtraido,
            callerUserId: user.id,
            licitacaoId,
            traceId,
          });
          if (ajusteResult.ok) {
            warnings.push(
              `✓ Auto-ajuste do total: orçamento forçado pra R$ ${totalExtraido.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.`,
            );
          } else {
            warnings.push(
              `⚠ Auto-ajuste do total FALHOU (${(ajusteResult.error ?? 'erro desconhecido').slice(0, 150)}). Use "Forçar total" no OrçaPav AI.`,
            );
          }
        } catch (e) {
          const msg = e instanceof AjustarValorProxyError
            ? e.message
            : (e instanceof Error ? e.message : String(e));
          warnings.push(
            `⚠ Auto-ajuste do total FALHOU (${msg.slice(0, 150)}). Use "Forçar total" no OrçaPav AI.`,
          );
        }
      }
    } else if (!isProposta) {
      warnings.push(
        '💡 Total do orçamento pode divergir do edital (PUs do SINAPI/etc atuais ≠ valores do edital). ' +
        'Use "Forçar total" no painel OrçaPav AI pra ajustar pro valor exato.',
      );
    }

    // ---- 8.5) Verificação pós-cadastro: confirma que o orçamento existe ----
    // Bug observado: em alguns casos o orçamento criado some/é movido pra
    // lixeira pelo próprio Orçafascio depois dos batches retornarem 200 OK.
    // Sem essa verificação, o cadastro_resumo dizia "OK" mas o user abria
    // depois e a URL retornava 302→listagem. Faz GET no budget URL — se
    // redirect, sinaliza erro fatal no warning.
    let orcamentoVerificado = false;
    try {
      const verifyResp = await fetch(`https://app.orcafascio.com/orc/orcamentos/${budget_id}`, {
        method: 'GET',
        headers: {
          Cookie: ctx.session.cookie_header,
          'User-Agent': 'pavcon-licitacoes/0.1 (post-verify)',
          Accept: 'text/html',
        },
        redirect: 'manual',
      });
      const location = verifyResp.headers.get('location') ?? '';
      if (verifyResp.status === 200) {
        orcamentoVerificado = true;
      } else if (verifyResp.status === 302 || verifyResp.status === 303) {
        if (location.includes('/login')) {
          warnings.push('Verificação pós-cadastro: sessão expirou. Recarregue e tente abrir o orçamento manualmente.');
        } else {
          // Redirect pra listagem = orçamento sumiu
          warnings.push(
            `⚠ ORÇAMENTO SUMIU APÓS CADASTRO: GET /orc/orcamentos/${budget_id} retornou 302→${location}. Possível bug do Orçafascio ou conflito. Recadastre.`,
          );
        }
      } else if (verifyResp.status === 404) {
        warnings.push(`⚠ Orçamento ${budget_id} retornou 404 imediatamente após cadastro. Recadastre.`);
      }
    } catch (e) {
      warnings.push(`Verificação pós-cadastro falhou (rede): ${e instanceof Error ? e.message.slice(0, 120) : 'erro'}`);
    }

    // ---- 9) Persiste budget_id na licitação + transição --------------------
    // PROPOSTA: não toca no status (orçamento base mantém fase1_concluida)
    if (!isProposta) {
      // Merge com cadastro_resumo existente — cadastrar-edital (Passo 1) já
      // escreveu warnings com prefixo "[Passo 1 - MyBase]". Preservamos eles
      // e adicionamos os do Passo 2 com prefixo "[Passo 2 - Orçamento]" pra
      // o painel de diagnóstico mostrar tudo agrupado por etapa.
      const { data: licAtual } = await admin
        .from('licitacoes')
        .select('cadastro_resumo')
        .eq('id', licitacaoId)
        .maybeSingle();
      const resumoAtual = (licAtual?.cadastro_resumo as Record<string, unknown> | null) ?? {};
      const warningsAtuais = Array.isArray(resumoAtual.warnings)
        ? (resumoAtual.warnings as string[])
        : [];
      // Mantém só os warnings do Passo 1 e descarta os antigos do Passo 2.
      const warningsPasso1 = warningsAtuais.filter((w) =>
        typeof w === 'string' && w.startsWith('[Passo 1 - MyBase]'),
      );
      const warningsPasso2Prefixed = warnings.map((w) => `[Passo 2 - Orçamento] ${w}`);
      const cadastroResumo = {
        ...resumoAtual,
        cadastrado_em: new Date().toISOString(),
        budget_id,
        budget_url: `https://app.orcafascio.com/orc/orcamentos/${budget_id}`,
        etapas_criadas: etapasCriadas,
        composicoes_criadas: composicoesCriadas,
        total_itens_batch: items.length,
        bdi: bdiPct,
        leis_sociais_horista: leisHorista,
        bancos_configurados: bancos.map((b) => `${b.nome} ${b.estado ?? ''} ${b.data}`.trim()),
        warnings: [...warningsPasso1, ...warningsPasso2Prefixed],
        orcamento_verificado: orcamentoVerificado,
      };
      await admin
        .from('licitacoes')
        .update({
          status: 'fase1_concluida',
          fase1_concluida_em: new Date().toISOString(),
          orcafascio_orcamento_base_id: budget_id,
          orcafascio_orcamento_base_codigo: codigo,
          cadastro_resumo: cadastroResumo,
        })
        .eq('id', licitacaoId);
    }

    // Atualiza extracoes_ocr ou outra tabela com o budget_id pra rastreamento
    // (a tabela licitacoes não tem campo orcafascio_orcamento_id atualmente —
    //  podemos guardar em audit ou criar coluna futura)

    return jsonResponse({
      ok: true,
      budget_id,
      budget_url: `https://app.orcafascio.com/orc/orcamentos/${budget_id}`,
      etapas_criadas: etapasCriadas,
      composicoes_criadas: composicoesCriadas,
      total_itens_batch: items.length,
      bdi: bdiPct,
      leis_sociais_horista: leisHorista,
      bancos_configurados: bancos.map((b) => `${b.nome} ${b.estado} ${b.data}`),
      warnings,
      trace_id: traceId,
      proximo_passo: warnings.length > 0
        ? `Orçamento criado com ${warnings.length} aviso(s) — alguns campos podem precisar ajuste manual. Abra a URL acima pra revisar.`
        : 'Abra o Orçafascio na URL acima pra revisar. O bot configurou cabeçalho, bases, BDI, encargos sociais e adicionou todas as composições.',
    });
  } catch (err) {
    // Em falha, transiciona licitação pra erro (mas NÃO pra proposta —
    // erro na proposta não pode quebrar o status do orçamento base)
    if (licitacaoId && !isProposta) {
      await admin.from('licitacoes').update({ status: 'erro' }).eq('id', licitacaoId);
    }
    if (err instanceof OrcafascioWebError) {
      return errorResponse(ERR_AUTH_TO_HTTP[err.code], err.message, err.details);
    }
    if (err instanceof OrcafascioV2023Error) {
      return errorResponse(502, err.message, { endpoint: err.endpoint, details: err.details });
    }
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.message, err.details);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cadastrar-orcamento] erro:', err);
    return errorResponse(500, msg);
  }
});
