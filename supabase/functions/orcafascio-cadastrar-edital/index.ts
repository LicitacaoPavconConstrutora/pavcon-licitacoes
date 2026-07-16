// =============================================================================
// Edge Function: orcafascio-cadastrar-edital (Plano A híbrido)
// =============================================================================
// A partir das `composicoes_extraidas` de uma licitação:
//   1. Cria um grupo (pasta) no MyBase do Orçafascio
//   2. Pra cada composição PRÓPRIA do edital, cria a composição no MyBase
//      e adiciona seus itens (sub-insumos) referenciando códigos
//      SINAPI/SEINFRA/ORSE/etc. que já existem na base do Orçafascio
//   3. Atualiza composicoes_extraidas.orcafascio_composition_id
//   4. Transição da licitação: criando_composicoes_edital → fase1_concluida
//
// Pré-requisitos pra esta função funcionar end-to-end:
//   - Credencial Orçafascio cadastrada (provider='orcafascio', metadata.auth_type='api')
//     com o secret_token no Vault
//   - Licitação com status em {aguardando_revisao_humana, criando_composicoes_edital,
//     fase1_concluida (idempotent retry)}
//   - composicoes_extraidas populadas (via Edge Function extracao-edital)
//
// LIMITAÇÃO confirmada pela documentação oficial do Orçafascio:
//   Não existe endpoint público pra criar o ORÇAMENTO em si (apenas /bud/budgets/list
//   pra listar). O orçamentista finaliza no painel do Orçafascio criando um novo
//   orçamento que aponte pra pasta gerada por esta função e importando as
//   composições já cadastradas.
//
// Body (JSON):
//   {
//     "licitacao_id": "uuid",        // obrigatório
//     "credential_id": "uuid",        // obrigatório
//     "force_relog": false,           // opcional
//     "trace_id": "uuid"              // opcional
//   }
//
// Resposta 200:
//   {
//     "ok": true,
//     "grupo_id": "...",
//     "grupo_descricao": "...",
//     "composicoes_criadas": 24,
//     "composicoes_puladas": 1,        // já tinham orcafascio_composition_id
//     "itens_adicionados": 134,
//     "warnings": [...]
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
  authenticateOrcafascio,
  OrcafascioAuthError,
} from '../_shared/orcafascio.ts';
import {
  addBasesToComposition,
  addItemsToComposition,
  COMPOSITION_TYPES,
  createComposition,
  createGroup,
  createResource,
  deleteResource,
  findCompositionByCode,
  findGroupByDescription,
  findMyBaseResourceByCode,
  fonteToBank,
  OrcafascioApiError,
  pickUF,
  RESOURCE_TYPE,
  ROUNDING_TYPE,
  type CompositionItem,
} from '../_shared/orcafascio-mybase.ts';

interface RequestBody {
  licitacao_id?: string;
  credential_id?: string;
  force_relog?: boolean;
  trace_id?: string;
}

interface ComposicaoExtraida {
  id: string;
  item_codigo: string;
  codigo: string | null;
  fonte: string | null;
  descricao: string;
  unidade: string | null;
  tipo_linha: string;
  orcafascio_composition_id: string | null;
  preco_unitario_sem_bdi: number | null;
  preco_unitario_com_bdi: number | null;
}

interface ComposicaoPropriaItem {
  composicao_extraida_id: string;
  classe: string;
  codigo: string | null;
  fonte: string;
  descricao: string;
  unidade: string | null;
  coeficiente: number | null;
  preco_unitario: number | null;
}

/**
 * Cria (ou reusa) um Resource no MyBase com um preço fixo. Usado tanto pras
 * sub-composições PROPRIA auxiliares (AUX_) quanto pro fallback de preço de
 * composições vazias (FALLBACK_) — extraído aqui pra não duplicar a lógica
 * de staleness (as duas precisam do MESMO cuidado: se o resource já existe
 * mas com preço zerado/desatualizado, apaga e recria em vez de reusar
 * cegamente).
 */
async function upsertPricedResource(
  ctx: Parameters<typeof createResource>[0],
  opts: {
    code: string;
    description: string;
    unit: string;
    uf: string;
    groupId: string;
    preco: number;
    note: string;
  },
): Promise<{ resource_code: string }> {
  const existing = await findMyBaseResourceByCode(ctx, opts.code);
  if (existing) {
    // Se o preço existente está zerado (criado por versão buggy anterior)
    // e agora temos um preço de verdade, apaga e recria. Do contrário
    // reusa — evita apagar/recriar resources à toa em todo run.
    const existingPnd = Number(existing.locals?.[opts.uf]?.pnd ?? 0);
    if (existingPnd > 0 || opts.preco === 0) {
      return { resource_code: existing.code };
    }
    await deleteResource(ctx, existing.id);
  }
  const resource = await createResource(ctx, {
    group_id: opts.groupId,
    code: opts.code,
    description: opts.description.slice(0, 500),
    type: RESOURCE_TYPE.OUTROS,
    unit: opts.unit.slice(0, 20),
    local: opts.uf,
    // Mesmo preço nos 4 campos — não desonerado/desonerado/improdutivo
    // (o cálculo correto vem do BDI + leis sociais do orçamento).
    pnd: opts.preco,
    pd: opts.preco,
    pndi: opts.preco,
    pdi: opts.preco,
    note: opts.note,
  });
  return { resource_code: resource.code };
}

const ERR_AUTH_TO_HTTP: Record<OrcafascioAuthError['code'], number> = {
  credential_not_found: 404,
  credential_inactive: 403,
  credential_wrong_provider: 400,
  credential_no_email: 422,
  vault_unreadable: 500,
  orcafascio_rejected: 422,
  orcafascio_unreachable: 502,
  orcafascio_unexpected: 502,
};

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
  if (!credentialId) return errorResponse(400, 'credential_id é obrigatório.');

  const traceId = body.trace_id ?? crypto.randomUUID();
  const admin = getServiceRoleClient();
  const warnings: string[] = [];

  try {
    const user = await requireAuthenticatedUser(req);

    // ---- 1) Carrega licitação + composições -----------------------------------
    const { data: licitacao, error: licErr } = await admin
      .from('licitacoes')
      .select('id, titulo, numero_edital, orgao_licitante, municipio, uf, status')
      .eq('id', licitacaoId)
      .maybeSingle();
    if (licErr || !licitacao) {
      return errorResponse(404, 'Licitação não encontrada.', licErr?.message);
    }
    const ALLOWED_STATUS = new Set([
      'aguardando_revisao_humana',
      'criando_composicoes_edital',
      'fase1_concluida', // permite retry idempotente
    ]);
    if (!ALLOWED_STATUS.has(licitacao.status)) {
      return errorResponse(
        409,
        `Licitação está em "${licitacao.status}" — precisa estar em ${[...ALLOWED_STATUS].join(', ')}.`,
      );
    }

    const { data: composicoes, error: compErr } = await admin
      .from('composicoes_extraidas')
      .select('id, item_codigo, codigo, fonte, descricao, unidade, tipo_linha, orcafascio_composition_id, preco_unitario_sem_bdi, preco_unitario_com_bdi')
      .eq('licitacao_id', licitacaoId)
      .eq('fonte', 'PROPRIA')
      .eq('tipo_linha', 'servico');
    if (compErr) {
      return errorResponse(500, 'Falha ao ler composicoes_extraidas.', compErr.message);
    }
    if (!composicoes || composicoes.length === 0) {
      // Licitação só tem itens de bancos referenciais (SINAPI/ORSE/SEINFRA/etc)
      // — não tem composição PROPRIA pra cadastrar no MyBase. Passo 1 é
      // simplesmente desnecessário; retornamos sucesso vazio pra que o
      // usuário possa avançar pro Passo 2 (criar orçamento referenciando
      // os bancos diretamente) sem ver erro.
      return jsonResponse({
        ok: true,
        skipped: true,
        composicoes_criadas: 0,
        composicoes_puladas: 0,
        itens_adicionados: 0,
        warnings: [
          'Esta licitação não tem composições próprias — só itens de bancos referenciais ' +
          '(SINAPI/ORSE/etc). Passo 1 (MyBase) não é necessário. Vá direto pro Passo 2.',
        ],
        trace_id: traceId,
        proximo_passo: 'Clique em "🚀 Cadastrar tudo no Orçafascio" (Passo 2) — o orçamento vai referenciar os códigos SINAPI/ORSE diretamente.',
      });
    }

    // Pega cabecalho da extração pra montar bases (data-base + UF). Sem isso,
    // composições novas usam SINAPI/AC/01-2026 default → códigos do edital
    // (que vivem em outra UF/data) retornam 500 ao serem adicionados.
    const { data: extr } = await admin
      .from('extracoes_ocr')
      .select('json_corrigido, json_extraido')
      .eq('licitacao_id', licitacaoId)
      .in('status', ['sucesso', 'revisada_humano'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const cabecalho = ((extr?.json_corrigido ?? extr?.json_extraido) as
      { cabecalho?: { data_base_descricao?: string; uf?: string; bases_utilizadas?: string[]; com_desoneracao?: boolean } } | null
    )?.cabecalho ?? {};
    // Monta versão default MM/AAAA do data_base_descricao
    // Aceita: "fev/26", "02/2026", "fevereiro/2026", "JANEIRO/2026"
    function parseDataBase(s: string | undefined): string {
      if (!s) {
        const d = new Date();
        return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
      }
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
      const normalized = s.toLowerCase().trim();
      // Tenta formato "MM/AAAA" direto
      const direct = normalized.match(/(\d{1,2})\s*\/\s*(\d{4}|\d{2})/);
      if (direct) {
        const month = direct[1].padStart(2, '0');
        const year = direct[2].length === 2 ? `20${direct[2]}` : direct[2];
        return `${month}/${year}`;
      }
      // "fev/26" ou "fevereiro/2026"
      const named = normalized.match(/([a-zç]+)\s*\/\s*(\d{4}|\d{2})/);
      if (named && meses[named[1]]) {
        const month = meses[named[1]];
        const year = named[2].length === 2 ? `20${named[2]}` : named[2];
        return `${month}/${year}`;
      }
      // Fallback
      const d = new Date();
      return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    }
    const dataBaseEdital = parseDataBase(cabecalho.data_base_descricao);

    // Tenta extrair data ESPECÍFICA de cada banco do data_base_descricao.
    // Ex: "SINAPI PI 02/2026, SEINFRA CE 28, ORSE SE 01/2026, SICRO PI 10/2025"
    //  → SINAPI: "02/2026", SEINFRA: "28", ORSE: "01/2026", SICRO: "10/2025"
    function parseDataBasePorBanco(descricao: string | undefined, banco: string): string | null {
      if (!descricao) return null;
      const variants = [banco, banco.replace(/3$/, '')];
      for (const v of variants) {
        // BUG CORRIGIDO (SEINFRA - cooper, jun/2026): captura ORDENADA —
        // tenta AAAA/MM PRIMEIRO (ex: "2025/12"), senão MM/AAAA (ex: "12/2025"),
        // senão número puro. Antes a regex `\d{1,2}\/\d{2,4}` aplicada em
        // "2025/12" matchava "25/12" do meio → resultava "25/2012" → budget 500.
        const re = new RegExp(
          `${v}\\b[^,/]*?(\\b\\d{4}\\/\\d{1,2}\\b|\\b\\d{1,2}\\/\\d{2,4}\\b|\\b\\d{2,3}\\b)`,
          'i',
        );
        const m = descricao.match(re);
        if (!m) continue;
        const raw = m[1].trim();
        if (!raw.includes('/')) {
          return raw; // ex: "28" pra SEINFRA
        }
        const [a, b] = raw.split('/').map((p) => p.trim());
        let mm: string, year: string;
        if (a.length === 4) {
          // AAAA/MM
          year = a;
          mm = b.padStart(2, '0');
        } else {
          // MM/AAAA ou MM/AA
          mm = a.padStart(2, '0');
          year = b.length === 2 ? `20${b}` : b;
        }
        // Sanity check: ano razoável
        const y = Number(year);
        if (y < 2020 || y > 2030) continue;
        return `${mm}/${year}`;
      }
      return null;
    }
    const ufEdital = (cabecalho.uf ?? licitacao.uf ?? 'SP').toString().toUpperCase().slice(0, 2);
    const basesEdital = Array.isArray(cabecalho.bases_utilizadas)
      ? cabecalho.bases_utilizadas.map((b) => String(b).toUpperCase().trim()).filter((b) => b !== 'PROPRIA')
      : ['SINAPI'];

    // Normaliza nome do banco + UF padrão pros bancos que só existem em
    // um estado. Sem isso, addBases retorna 422 "Local not found"
    // (ORSE só em SE) ou "Base not found" (SICRO → precisa SICRO3).
    // Mapeamento de bancos: nome canônico + UF fixa (quando regional) +
    // formato de versão. Alguns bancos não usam "MM/AAAA":
    //   - SEINFRA: número sequencial sem barra (ex: "028", "030")
    //   - Outros conformidades específicas
    interface BankConfig {
      name: string;
      local: string;
      /** Formato de versão preferido. Default = MM/AAAA do edital */
      versionFormat?: 'mm_yyyy' | 'seinfra_num';
      /** Versão hard-coded mais recente conhecida (fallback) */
      versionFallback?: string;
    }
    const BANK_NORMALIZATION: Record<string, BankConfig> = {
      SICRO: { name: 'SICRO3', local: '' },
      SICRO3: { name: 'SICRO3', local: '' },
      SINAPI: { name: 'SINAPI', local: '' },
      SBC: { name: 'SBC', local: 'BA' },
      ORSE: { name: 'ORSE', local: 'SE' },
      // SEINFRA usa versionamento sequencial ("028", "029" etc), NÃO MM/AAAA.
      // Sem versão correta, addBases retorna 422 "Version not found".
      SEINFRA: { name: 'SEINFRA', local: 'CE', versionFormat: 'seinfra_num', versionFallback: '028' },
      SETOP: { name: 'SETOP', local: 'MG' },
      EMBASA: { name: 'EMBASA', local: 'BA' },
      FDE: { name: 'FDE', local: 'SP' },
      CPOS: { name: 'CPOS', local: 'SP' },
      SUDECAP: { name: 'SUDECAP', local: 'MG' },
      IOPES: { name: 'IOPES', local: 'ES' },
      AGESUL: { name: 'AGESUL', local: 'MS' },
      EMOP: { name: 'EMOP', local: 'RJ' },
      SCO: { name: 'SCO', local: 'RJ' },
      SEDOP: { name: 'SEDOP', local: 'PA' },     // Pará
      DERPR: { name: 'DERPR', local: 'PR' },
      CAEMA: { name: 'CAEMA', local: 'MA' },
      CAERN: { name: 'CAERN', local: 'RN' },
      COMPESA: { name: 'COMPESA', local: 'PE' },
      SIURB: { name: 'SIURB', local: 'SP' },
      MAPP: { name: 'MAPP', local: '' },         // fallback UF do edital
      // Bancos adicionados em jun/2026 após aparecerem em editais reais:
      GOINFRA: { name: 'GOINFRA', local: 'GO' },  // Goiás Infraestrutura
      CPTM: { name: 'CPTM', local: 'SP' },        // Cia Paulista Trens Metropolitanos
      SMOP: { name: 'SMOP', local: '' },          // Sec Mun Obras (UF varia, fallback)
      DNIT: { name: 'DNIT', local: '' },          // Federal
      CESAN: { name: 'CESAN', local: 'ES' },      // Cia Esp Santo Saneamento
      SABESP: { name: 'SABESP', local: 'SP' },    // Cia Saneamento SP
      CASAN: { name: 'CASAN', local: 'SC' },      // Cia Santa Catarina Saneamento
      AGEHAB: { name: 'AGEHAB', local: '' },      // Agência Habitação (varia por estado)
      TCE: { name: 'TCE', local: '' },            // Tribunal Contas Estado (varia)
    };
    const basesDaComposicao: Array<{
      name: string; local: string; version: string; status: boolean; with_labor_charges?: boolean;
    }> = [];
    for (const nome of basesEdital) {
      // FALLBACK INTELIGENTE: se o banco não está no BANK_NORMALIZATION,
      // assume que é um banco regional/estadual e usa a UF do edital. Antes
      // pulávamos (deixando itens sem base → R$ 0,00). Agora tentamos com
      // best-guess; se Orçafascio rejeitar a base via addBases, o item ainda
      // existe no orçamento (só sem referência de banco), e o warning fica
      // visível pro orçamentista decidir manualmente.
      // User feedback (jun/2026): "se aparecer banco novo, INCLUIR no cadastro
      // não pular — preciso desse valor pra fechar o orçamento."
      const cfg = BANK_NORMALIZATION[nome] ?? {
        name: nome,
        local: ufEdital,  // UF do edital como melhor palpite (uf real é declarado mais abaixo via pickUF)
      };
      if (!BANK_NORMALIZATION[nome]) {
        warnings.push(
          `Banco "${nome}" não estava mapeado — usando configuração genérica ` +
          `(nome="${nome}", UF="${ufEdital || 'global'}"). Se Orçafascio não conhecer ` +
          `esse banco, items vão entrar sem referência (PU pode ficar R$ 0). ` +
          `Considere mapear manualmente.`,
        );
      }
      // Resolve versão ESPECÍFICA do banco do cabecalho (data_base_descricao
      // pode ter datas diferentes pra cada banco). Fallbacks em ordem:
      // 1. Match específico do banco no data_base_descricao
      // 2. Data genérica do edital (parseDataBase)
      // 3. versionFallback do BANK_NORMALIZATION (último recurso)
      const especifica = parseDataBasePorBanco(cabecalho.data_base_descricao, cfg.name);
      let version = especifica ?? dataBaseEdital;
      if (cfg.versionFormat === 'seinfra_num') {
        // SEINFRA não aceita MM/AAAA. Espera "028", "029" etc.
        // Se o match específico já trouxe número puro, usa; senão fallback.
        if (especifica && /^\d+$/.test(especifica)) {
          version = especifica.padStart(3, '0');
        } else {
          version = cfg.versionFallback ?? '028';
        }
      }
      basesDaComposicao.push({
        name: cfg.name,
        local: cfg.local || ufEdital,
        version,
        status: true,
        with_labor_charges: !cabecalho.com_desoneracao,
      });
    }
    console.log(
      `[cadastrar-edital] bases da composição: ${basesEdital.join('+')} ${ufEdital} ${dataBaseEdital}`,
    );

    // Carrega mapeamento de codes descontinuados (substitui automaticamente).
    // Map<"FONTE_ORIGINAL/CODIGO_ORIGINAL", {fonte_substituto, codigo_substituto}>
    const { data: mappings } = await admin
      .from('orcafascio_code_mappings')
      .select('fonte_original, codigo_original, fonte_substituto, codigo_substituto')
      .not('fonte_substituto', 'is', null)
      .not('codigo_substituto', 'is', null);
    const codeMappings = new Map<string, { fonte: string; codigo: string }>();
    for (const m of mappings ?? []) {
      const key = `${(m.fonte_original ?? '').toUpperCase()}/${m.codigo_original}`;
      codeMappings.set(key, {
        fonte: (m.fonte_substituto as string).toUpperCase(),
        codigo: m.codigo_substituto as string,
      });
    }
    console.log(`[cadastrar-edital] ${codeMappings.size} code mappings carregados`);

    const composicaoIds = composicoes.map((c) => c.id);
    // ordem ASC pra preservar a sequência do edital — sem ordem explícita,
    // a UI do Orçafascio acaba alfabetizando os sub-itens.
    const { data: subItens, error: subErr } = await admin
      .from('composicao_propria_itens')
      .select('composicao_extraida_id, classe, codigo, fonte, descricao, unidade, coeficiente, preco_unitario, ordem')
      .in('composicao_extraida_id', composicaoIds)
      .order('ordem', { ascending: true });
    if (subErr) {
      return errorResponse(500, 'Falha ao ler composicao_propria_itens.', subErr.message);
    }

    // Agrupa sub-itens por composição (ordem já garantida pelo SELECT acima)
    const subItensByCompId = new Map<string, ComposicaoPropriaItem[]>();
    for (const s of (subItens ?? [])) {
      const list = subItensByCompId.get(s.composicao_extraida_id) ?? [];
      list.push(s);
      subItensByCompId.set(s.composicao_extraida_id, list);
    }

    // ---- 2) Transição: criando_composicoes_edital -----------------------------
    if (licitacao.status === 'aguardando_revisao_humana') {
      await admin
        .from('licitacoes')
        .update({ status: 'criando_composicoes_edital' })
        .eq('id', licitacaoId);
    }

    // ---- 3) Autentica no Orçafascio ------------------------------------------
    const session = await authenticateOrcafascio(admin, credentialId, {
      callerUserId: user.id,
      forceRefresh: body.force_relog === true,
      traceId,
      licitacaoId,
    });

    const ctx = {
      admin,
      session,
      credentialId,
      callerUserId: user.id,
      licitacaoId,
      traceId,
    };

    // ---- 4) Find-or-create grupo -----------------------------------------------
    // Idempotência: se já existe grupo com mesma descrição, reusa (retry
    // depois de erro não cria duplicata e nem 422 'já está utilizada').
    const grupoDescricao = [
      'EDITAL',
      licitacao.numero_edital ?? licitacao.id.slice(0, 8),
      licitacao.municipio,
      licitacao.uf,
    ].filter(Boolean).join(' / ').slice(0, 200);

    const existingGroup = await findGroupByDescription(ctx, grupoDescricao);
    const grupo = existingGroup
      ? existingGroup
      : await createGroup(ctx, { description: grupoDescricao });
    console.log(
      `[cadastrar-edital] grupo ${existingGroup ? 'reusado' : 'criado'}: ${grupo.id} — ${grupoDescricao}`,
    );

    // ---- 4.5) Pré-cria resources auxiliares pra sub-composições PROPRIA --------
    // Editais frequentemente têm composições próprias que internamente referenciam
    // OUTRAS composições próprias auxiliares (ex: PARALELEPIPEDO+FRETE dentro de
    // PAVIMENTAÇÃO). Essas auxiliares não viram linha do orçamento — só servem
    // de "categoria de custo" interna. No MyBase do Orçafascio, isso é resolvido
    // tratando-as como RESOURCES (insumos com preço fixo).
    //
    // Sem isso: add-items envia { bank: 'MYBASE', code: '07', is_resource: false }
    // → Orçafascio busca composição com code='07', não acha → 500.
    const uf = pickUF(licitacao.uf);
    const auxSubItens = (subItens ?? []).filter(
      (s) => s.fonte === 'PROPRIA' && s.classe === 'COMPOSICAO' && s.codigo,
    );
    const auxByOriginalCode = new Map<string, { resource_code: string }>();
    if (auxSubItens.length > 0) {
      // Dedup por código (com a 1ª descrição/preço/unidade encontrados)
      const uniques = new Map<string, ComposicaoPropriaItem>();
      for (const s of auxSubItens as ComposicaoPropriaItem[]) {
        if (!uniques.has(s.codigo!)) uniques.set(s.codigo!, s);
      }
      console.log(
        `[cadastrar-edital] ${uniques.size} sub-composições PROPRIA auxiliares pra cadastrar como Resource`,
      );

      for (const aux of uniques.values()) {
        // Code único por licitação pra não colidir entre editais
        const auxCode = `AUX_${licitacaoId.slice(0, 8)}_${aux.codigo!}`.slice(0, 50);
        const preco = aux.preco_unitario != null ? Number(aux.preco_unitario) : 0;
        try {
          const { resource_code } = await upsertPricedResource(ctx, {
            code: auxCode,
            description: aux.descricao ?? `Sub-composição auxiliar ${aux.codigo}`,
            unit: aux.unidade ?? 'un',
            uf,
            groupId: grupo.id,
            preco,
            note: `Auxiliar do edital ${licitacao.numero_edital ?? licitacao.id.slice(0, 8)}. Código original "${aux.codigo}".`,
          });
          auxByOriginalCode.set(aux.codigo!, { resource_code });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push(`Resource auxiliar "${auxCode}" — falhou: ${msg.slice(0, 200)}`);
        }
      }
    }

    // ---- 5) Pra cada composição PRÓPRIA: cria + adiciona itens -----------------
    let composicoesCriadas = 0;
    let composicoesPuladas = 0;
    let itensAdicionados = 0;

    // Trackeia codes da composição PRÓPRIA que JÁ FORAM PROCESSADOS nesta
    // execução do cadastro. Quando o edital tem o mesmo "COMPOSIÇÃO 04" em
    // 5 ruas (SEFIR Pavussu), a 1ª iteração CRIA a composição com seus
    // sub-itens; as 2ª–5ª chamam findCompositionByCode e REUSAM. O bug
    // anterior tentava addItems mesmo na reusada → duplicação 5×.
    //
    // O fix v43 confiava em `created.items` retornado pela API mas
    // find_by_code do Orçafascio NÃO popula esse array — sempre 0 → fix
    // não disparava. Esta versão (v45) trackeia em memória, garantido.
    const codesJaProcessadosNesseRun = new Set<string>();

    for (const comp of (composicoes as ComposicaoExtraida[])) {
      // Idempotência: se já tem orcafascio_composition_id, pula
      if (comp.orcafascio_composition_id) {
        composicoesPuladas++;
        continue;
      }

      // Code da composição no MyBase. Estratégia:
      // 1. SE o edital trouxe um código próprio (comp.codigo, ex: "ADM LOCAL",
      //    "REG1"), usa esse (mais legível pro orçamentista — bate com a
      //    nomenclatura do órgão).
      // 2. Senão, fallback pra 'COMPOSIC_<item_codigo>'.
      // Em todo caso, sanitiza removendo PONTOS/espaços — find_by_code do
      // Orçafascio retorna 500 silencioso pra codes com múltiplos pontos
      // (ex: "COMPOSIC_1.1.1"). Trocando ponto por underscore resolve.
      // Sanitiza string pra ser code válido: trim + upper + remove acentos +
      // troca não-alfanuméricos por underscore. Mantém máximo 40 chars.
      const sanitize = (raw: string): string =>
        raw
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '') // remove acentos
          .toUpperCase()
          .trim()
          .replace(/[^A-Z0-9_-]/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/g, '')
          .slice(0, 40);

      // Code da composição no MyBase com PREFIXO da licitação.
      // BUG CRÍTICO (batalha teste, jun/2026): editais diferentes usavam
      // codes genéricos (COMP01, COMP02 etc) que colidiam entre licitações
      // no MyBase. Quando licitação A criava COMP01="Admin Local" e
      // licitação B tentava criar COMP01="Locação obra", findCompositionByCode
      // achava o antigo e reusava — qty da B × PU da A = total absurdo
      // (visto: locação 1077m² × R$ 4.851 = R$ 5.228.008 de "locação").
      //
      // Fix: prefixar com 6 primeiros chars do licitacao_id. Cada licitação
      // tem seu próprio "namespace" no MyBase. Trade-off: MyBase cresce
      // (X comps × Y licitações) mas sem colisão silenciosa entre orçamentos.
      // O mesmo prefix é aplicado no cadastrar-orcamento (mybaseCode) pra
      // garantir match.
      const licShort = licitacaoId.slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const codigoBase = (
        comp.codigo && comp.codigo.trim()
          ? sanitize(comp.codigo)
          : `COMPOSIC_${sanitize(comp.item_codigo)}`
      );
      const codigo = `${licShort}_${codigoBase}`.slice(0, 50);
      const descricao = (comp.descricao ?? 'Composição própria do edital').slice(0, 500);
      const unidade = (comp.unidade ?? 'Un').slice(0, 20);

      // Tipo da composição: usamos "PARE" (paredes) como default genérico —
      // o orçamentista pode reclassificar dentro do Orçafascio se preciso.
      // TODO: inferir do tipo do item via LLM (futuro)
      const tipo: typeof COMPOSITION_TYPES[number] = 'PARE';

      // Find-or-create composição por code (único: licitacao_id + item_codigo).
      // Reusa em retry; só cria se nao achar.
      let created;
      let foiCriadaAgora = false;
      try {
        const existing = await findCompositionByCode(ctx, codigo);
        if (existing) {
          created = existing;
          composicoesPuladas++;
          console.log(`[cadastrar-edital] composição reusada: ${codigo} → ${existing.id}`);
        } else {
          foiCriadaAgora = true;
          created = await createComposition(ctx, {
            code: codigo,
            second_code: `LICITACAO_${licitacaoId.slice(0, 8)}_${comp.item_codigo
              .replace(/[^A-Za-z0-9_-]/g, '_')
              .slice(0, 30)}`,
            description: descricao,
            labor: false,
            type: tipo,
            unit: unidade,
            local: uf,
            // CRÍTICO PARA LICITAÇÃO: TRUNCAR sempre arredonda PRA BAIXO.
            // Nosso orçamento NUNCA pode ter valor maior que o edital
            // (desclassificação). ARREDONDAR (half-up) pode somar centavos
            // por cima do edital — usamos TRUNCAR pra garantir ≤ edital.
            rounding_type: ROUNDING_TYPE.TRUNCAR_2_CASAS,
            is_sicro: false,
            note: `Composição extraída do edital. Item ${comp.item_codigo}.`,
          });
          composicoesCriadas++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Composição "${codigo}" — falhou: ${msg}`);
        continue;
      }

      // Configura bases (SINAPI/SICRO/ORSE/etc) com UF + data-base do edital.
      // Composições criadas usam default da conta (SINAPI/AC/01-2026), e os
      // códigos do edital (que vivem em PI/02-2026 ou similar) retornam 500
      // no addItemsToComposition sem isso. SÓ chamamos pra composições
      // vazias — Orçafascio retorna 500 silencioso se add-bases for chamado
      // numa composição que já tem items (faz sentido: bases definem onde
      // o servidor procura os codes, não dá pra mudar depois de resolvido).
      const itensJaExistentes = ((created as { items?: unknown[] }).items ?? []).length;
      if (basesDaComposicao.length > 0 && itensJaExistentes === 0) {
        try {
          await addBasesToComposition(ctx, created.id, basesDaComposicao);
        } catch (e) {
          // 422 "already in use" (idempotência) é OK; outros 422 (Local
          // not found, Base not found) precisam de aviso pq itens vão
          // falhar com 500.
          const details = (e instanceof OrcafascioApiError && e.details) || null;
          const detailsStr = details ? JSON.stringify(details).slice(0, 200) : '';
          const isAlreadyInUse = detailsStr.toLowerCase().includes('already_in_use') ||
            detailsStr.toLowerCase().includes('já está utilizada');
          if (!isAlreadyInUse) {
            warnings.push(
              `Composição "${codigo}": addBases falhou ${detailsStr || (e instanceof Error ? e.message.slice(0, 120) : '')}. Items dessas bases podem falhar com 500.`,
            );
          }
        }
      }

      // Adiciona sub-itens da composição própria.
      // Cada sub-item pode ser COMPOSICAO ou INSUMO (MAT/EQUIPAMENTO).
      // Orçafascio exige is_resource pra distinguir — sem isso, 500 quando
      // mistura COMPOSICAO + INSUMO na mesma composição.
      //
      // Sub-composições PROPRIA auxiliares (ex: codigo "07" PARALELEPIPEDO)
      // foram pré-cadastradas como RESOURCES no MyBase no passo 4.5. Aqui
      // substituímos o codigo original pelo code do resource e marcamos
      // is_resource: true.
      const subs = subItensByCompId.get(comp.id) ?? [];
      // Composição PROPRIA sem detalhamento no JSON (ex: planilha anexa não
      // veio na extração). Mantemos a composição criada no MyBase pra
      // preservar a estrutura do orçamento (código/descrição/unidade), mas
      // logamos warning pro orçamentista preencher manualmente depois.
      // Feedback do orçamentista (Batalha): "se em algum caso uma composição
      // própria não for encontrada nos anexos, criar a mesma no orçamento e
      // deixar em branco". É exatamente isso.
      // LIMITAÇÃO conhecida da API pública do Orçafascio: insumos do MyBase
      // (resources cadastrados pela empresa) NÃO podem ser sub-itens de outra
      // composição MyBase via /add-items (sempre devolve 500). Por isso os
      // sub-itens PROPRIA+COMPOSICAO auxiliares (AUX_XX) vão pro warning
      // pra o orçamentista adicionar manualmente na UI web.
      const itemsParaApi: CompositionItem[] = [];
      const subItensManuais: string[] = [];

      if (subs.length === 0) {
        // FALLBACK (jul/2026): antes a composição ficava em branco (R$ 0,00)
        // até alguém preencher manualmente — mesmo quando o PREÇO do item já
        // tinha sido extraído certinho da planilha oficial do edital (só o
        // DETALHAMENTO em sub-itens/insumos que faltava, geralmente porque a
        // planilha auxiliar do órgão não veio na extração). Isso fazia o
        // total do orçamento nunca bater com o edital.
        //
        // Reusa o MESMO mecanismo já testado em produção pras sub-composições
        // PROPRIA auxiliares (ver "passo 4.5" acima, comentário "testes
        // empíricos"): cria um Resource no MyBase com o preço JÁ CONHECIDO
        // (não inventado — é o preco_unitario_sem_bdi extraído da planilha
        // oficial) e adiciona como o único item da composição via
        // type:'resource' (que funciona pela API — só composição-dentro-de-
        // composição que 500a). O BDI é aplicado depois pelo orçamento, então
        // usamos o preço SEM BDI aqui.
        const precoConhecido = comp.preco_unitario_sem_bdi != null
          ? Number(comp.preco_unitario_sem_bdi)
          : comp.preco_unitario_com_bdi != null
            ? Number(comp.preco_unitario_com_bdi)
            : 0;
        if (precoConhecido > 0) {
          const fallbackCode = `FALLBACK_${codigo}`.slice(0, 50);
          try {
            const { resource_code } = await upsertPricedResource(ctx, {
              code: fallbackCode,
              description: `${descricao} (preço do edital — sem detalhamento de insumos)`,
              unit: unidade,
              uf,
              groupId: grupo.id,
              preco: precoConhecido,
              note:
                `Fallback automático: composição "${comp.item_codigo}" sem detalhamento no JSON do ` +
                'edital. Preço reproduzido de composicoes_extraidas.preco_unitario_sem_bdi (extraído ' +
                'da planilha oficial). Substitua por insumos reais quando/se a planilha auxiliar ' +
                'do órgão for localizada.',
            });
            itemsParaApi.push({ bank: 'MYBASE', code: resource_code, qty: 1, type: 'resource' });

            // Grava também na NOSSA tabela (composicao_propria_itens) — sem
            // isso, composicoesVazias (frontend/src/lib/agente/actions.ts)
            // continuava marcando esta composição como "vazia" pra sempre,
            // mesmo depois do fallback já ter preenchido o preço no
            // Orçafascio, e o detector de "total abaixo do edital" seguia
            // oferecendo "Forçar Total" e inflando um total que já batia.
            const { error: subItemErr } = await admin
              .from('composicao_propria_itens')
              .insert({
                composicao_extraida_id: comp.id,
                classe: 'INSUMO',
                codigo: resource_code,
                fonte: 'OUTRA',
                descricao: `${descricao} (preço do edital — fallback automático, sem detalhamento real de insumos)`.slice(0, 500),
                unidade,
                coeficiente: 1,
                preco_unitario: precoConhecido,
                preco_total: precoConhecido,
                orcafascio_resource_id: resource_code,
                ordem: 0,
              });
            if (subItemErr) {
              warnings.push(
                `Composição "${codigo}": fallback de preço aplicado no Orçafascio, mas falhou ao registrar ` +
                  `localmente (${subItemErr.message.slice(0, 150)}) — pode continuar aparecendo como "vazia" nos diagnósticos.`,
              );
            }

            warnings.push(
              `Composição "${codigo}" (${(comp.descricao ?? '').slice(0, 60)}): sem detalhamento no JSON do edital — ` +
                `preenchida com o preço já extraído da planilha oficial (R$ ${precoConhecido.toFixed(2)}, sem BDI) ` +
                'como item único. Substitua pelos insumos reais no Orçafascio quando localizar a planilha auxiliar do órgão.',
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            warnings.push(
              `Composição "${codigo}" (${(comp.descricao ?? '').slice(0, 60)}) criada em branco — falha ao aplicar ` +
                `fallback de preço (${msg.slice(0, 150)}). Preencha manualmente os insumos no Orçafascio.`,
            );
          }
        } else {
          warnings.push(
            `Composição "${codigo}" (${(comp.descricao ?? '').slice(0, 60)}) criada em branco — não havia ` +
              'detalhamento no JSON do edital nem preço extraído pra usar de fallback. Preencha manualmente ' +
              'os insumos/sub-composições no Orçafascio.',
          );
        }
      }
      // Cruzamento payload → sub_item original (pro fallback poder logar
      // descrição/preço quando o code falha)
      const itemPayloadToSub = new Map<string, ComposicaoPropriaItem>();
      // Sub-items descartados pelo filtro (codigo NULL, coef NULL/zero).
      // Antes esses eram pulados silenciosamente — agora viram warning
      // consolidado no fim, agrupado por motivo, pra o orçamentista saber
      // exatamente o que faltou e por quê.
      const descartados: Array<{ motivo: string; descricao: string; codigo: string | null }> = [];
      for (const s of subs) {
        if (!s.codigo || s.coeficiente == null || s.coeficiente <= 0) {
          let motivo: string;
          if (!s.codigo) motivo = 'sem código';
          else if (s.coeficiente == null) motivo = 'sem coeficiente';
          else motivo = 'coeficiente zero';
          descartados.push({
            motivo,
            descricao: (s.descricao ?? '(sem descrição)').slice(0, 60),
            codigo: s.codigo,
          });
          continue;
        }
        const isAuxPropria = s.fonte === 'PROPRIA' && s.classe === 'COMPOSICAO';
        if (isAuxPropria) {
          const aux = auxByOriginalCode.get(s.codigo);
          subItensManuais.push(
            `[Adicionar manual] ${s.codigo} ${(s.descricao ?? '').slice(0, 60)}` +
            (aux ? ` (Resource MyBase: ${aux.resource_code}, ${s.unidade ?? ''}, ${s.preco_unitario != null ? `R$ ${Number(s.preco_unitario).toFixed(2)}` : 'sem preço'}) — coef ${s.coeficiente}` : ''),
          );
          continue;
        }
        // Aplica mapeamento de code descontinuado (auto-substituição).
        // Ex: SICRO/E9515 (descontinuado) → SICRO3/123456 (novo).
        // O user popula orcafascio_code_mappings conforme descobre.
        const fonteRaw = (s.fonte ?? '').toUpperCase();
        const mappingKey = `${fonteRaw}/${s.codigo}`;
        const mapping = codeMappings.get(mappingKey);
        const fonteFinal = mapping ? mapping.fonte : (s.fonte ?? null);
        const codigoFinal = mapping ? mapping.codigo : s.codigo;

        const bankNorm = fonteToBank(fonteFinal);
        itemPayloadToSub.set(`${bankNorm}/${codigoFinal}`, s);
        itemsParaApi.push({
          bank: bankNorm,
          code: codigoFinal,
          qty: s.coeficiente,
          // classe='COMPOSICAO' → type:'composition'; outros (INSUMO, MAT,
          // EQUIPAMENTO) → type:'resource'.
          type: s.classe === 'COMPOSICAO' ? 'composition' : 'resource',
        });
      }
      const items = itemsParaApi;
      if (subItensManuais.length > 0) {
        warnings.push(
          `Composição "${codigo}": ${subItensManuais.length} sub-item(ns) PROPRIA auxiliar — Orçafascio API não aceita resource MyBase como sub-item, adicione manualmente na UI: ${subItensManuais.join('; ')}`,
        );
      }
      // Warning consolidado dos sub-items descartados pelo filtro de validação.
      // Agrupa por motivo pra a mensagem ficar legível mesmo com vários casos.
      if (descartados.length > 0) {
        const porMotivo = new Map<string, string[]>();
        for (const d of descartados) {
          const lista = porMotivo.get(d.motivo) ?? [];
          lista.push(d.codigo ? `${d.codigo} ${d.descricao}` : d.descricao);
          porMotivo.set(d.motivo, lista);
        }
        const partes: string[] = [];
        for (const [motivo, items] of porMotivo.entries()) {
          partes.push(`${items.length} ${motivo} ("${items.slice(0, 3).join('", "')}"${items.length > 3 ? ` e mais ${items.length - 3}` : ''})`);
        }
        warnings.push(
          `Composição "${codigo}": ${descartados.length} sub-item(ns) descartados na extração — ${partes.join('; ')}. Corrija o JSON do edital ou edite a composição manualmente no Orçafascio.`,
        );
      }

      // FIX DEFINITIVO (v45) — SEFIR Pavussu multi-rua:
      // Edital tem "COMPOSIÇÃO 04" repetido em 5 ruas (item_codigo
      // 2.2.1, 3.2.1, 4.2.1, 5.2.1, 6.2.1). O laço processa os 5:
      //   - Iter 1: cria composição com 7 sub-items
      //   - Iter 2-5: findCompositionByCode reusa, mas SE não trackar,
      //     addItems duplica os 7 sub-items mais 4 vezes = 35 totais
      //   - PU inflado 5× → orçamento ~2× o real
      //
      // v43 tentou checar `created.items.length` mas a API find_by_code
      // não popula esse array (sempre 0). Não disparava.
      //
      // v45: track em memória os codes já processados neste run.
      // Quando o mesmo code aparece de novo, pula addItems garantido.
      const jaProcessadoNesseRun = codesJaProcessadosNesseRun.has(codigo);
      if (items.length > 0 && jaProcessadoNesseRun) {
        // Mesmo code já recebeu sub-items nesta rodada → pula pra evitar
        // duplicação. Conta como sucesso (composição já está OK).
        itensAdicionados += items.length;
      } else if (items.length > 0 && !foiCriadaAgora && itensJaExistentes > 0) {
        // Existe no MyBase com sub-items (de outra licitação ou rodada
        // anterior), e a API conseguiu enumerar items → não duplica.
        itensAdicionados += items.length;
        codesJaProcessadosNesseRun.add(codigo);
      } else if (items.length > 0) {
        try {
          await addItemsToComposition(ctx, created.id, items);
          itensAdicionados += items.length;
          // Marca code como processado — próxima iteração do mesmo code
          // pula addItems pra não duplicar sub-itens.
          codesJaProcessadosNesseRun.add(codigo);
        } catch (err) {
          // Batch falhou com 500 (HTML genérico, sem detalhes do item ruim).
          // Tenta item por item pra identificar o(s) problemático(s) — os
          // que funcionarem ficam adicionados, os que falharem viram warning
          // específico com o code/bank/qty pra debug.
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`[cadastrar-edital] batch ${codigo} falhou (${msg}), tentando item a item`);
          let oneByOneOk = 0;
          const failuresManual: string[] = [];
          for (const it of items) {
            try {
              await addItemsToComposition(ctx, created.id, [it]);
              oneByOneOk++;
            } catch (e2) {
              // 422 "already_in_use" = sucesso. O batch que falhou com 500
              // espúrio na verdade adicionou os items — quando tentamos
              // de novo, a API diz "já está em uso". Conta como OK.
              const details = (e2 instanceof OrcafascioApiError && e2.details) || null;
              const detailsStr = details ? JSON.stringify(details) : '';
              if (detailsStr.includes('already_in_use')) {
                oneByOneOk++;
                continue;
              }
              // 500 persistente. Provavelmente o code não existe no banco
              // do Orçafascio (descontinuado ou de outra versão). Gera
              // warning detalhado com info do edital pra adição manual.
              const sub = itemPayloadToSub.get(`${it.bank}/${it.code}`);
              const desc = (sub?.descricao ?? '').slice(0, 80);
              const preco = sub?.preco_unitario != null
                ? `R$ ${Number(sub.preco_unitario).toFixed(2)}`
                : 's/preço';
              const unid = sub?.unidade ?? '';
              failuresManual.push(
                `${it.bank}/${it.code} ${desc} (${unid}, ${preco}, coef ${it.qty})`,
              );
              // Registra na tabela de mapeamentos pra o user mapear depois
              // (idempotente — ON CONFLICT DO NOTHING).
              if (sub) {
                await admin
                  .from('orcafascio_code_mappings')
                  .upsert({
                    fonte_original: it.bank,
                    codigo_original: it.code,
                    descricao: sub.descricao ?? null,
                    motivo: 'addItemsToComposition retornou 500 — code provável descontinuado',
                  }, { onConflict: 'fonte_original,codigo_original', ignoreDuplicates: true });
              }
            }
          }
          itensAdicionados += oneByOneOk;
          if (failuresManual.length > 0) {
            warnings.push(
              `Composição "${codigo}": ${oneByOneOk}/${items.length} itens OK. Items não encontrados no banco do Orçafascio (provável código descontinuado) — adicionar manual: ${failuresManual.join('; ')}`,
            );
          }
        }
      }

      // Atualiza orcafascio_composition_id no banco
      await admin
        .from('composicoes_extraidas')
        .update({ orcafascio_composition_id: created.id })
        .eq('id', comp.id);
    }

    // ---- 6) Transição: fase1_concluida -----------------------------------------
    // Também persiste os warnings do Passo 1 (MyBase) dentro de cadastro_resumo
    // pra o painel DiagnosticoCadastro mostrá-los. Sem isso, o Passo 2 (cadastro
    // de orçamento) sobrescrevia cadastro_resumo só com SEUS warnings, e os do
    // Passo 1 — incluindo o consolidado de sub-items descartados (codigo NULL,
    // coef zero) — sumiam ao terminar o fluxo. Prefixamos com [Passo 1 - MyBase]
    // pra ficar claro pro orçamentista de onde vem cada warning.
    const { data: licAtual } = await admin
      .from('licitacoes')
      .select('cadastro_resumo')
      .eq('id', licitacaoId)
      .maybeSingle();
    const resumoAtual = (licAtual?.cadastro_resumo as Record<string, unknown> | null) ?? {};
    const warningsAtuais = Array.isArray(resumoAtual.warnings)
      ? (resumoAtual.warnings as string[])
      : [];
    // Remove eventuais warnings antigos do Passo 1 (retry) e injeta os novos
    // mantendo os do Passo 2 que ainda não foram regerados.
    const warningsPasso2 = warningsAtuais.filter((w) =>
      typeof w === 'string' && !w.startsWith('[Passo 1 - MyBase]'),
    );
    const warningsMybasePrefixed = warnings.map((w) => `[Passo 1 - MyBase] ${w}`);
    const resumoNovo = {
      ...resumoAtual,
      mybase: {
        composicoes_criadas: composicoesCriadas,
        composicoes_puladas: composicoesPuladas,
        itens_adicionados: itensAdicionados,
        warnings,
        finalizado_em: new Date().toISOString(),
      },
      warnings: [...warningsMybasePrefixed, ...warningsPasso2],
    };
    await admin
      .from('licitacoes')
      .update({
        status: 'fase1_concluida',
        fase1_concluida_em: new Date().toISOString(),
        cadastro_resumo: resumoNovo,
      })
      .eq('id', licitacaoId);

    return jsonResponse({
      ok: true,
      grupo_id: grupo.id,
      grupo_descricao: grupoDescricao,
      composicoes_criadas: composicoesCriadas,
      composicoes_puladas: composicoesPuladas,
      itens_adicionados: itensAdicionados,
      warnings,
      trace_id: traceId,
      proximo_passo: 'No Orçafascio: crie um novo Orçamento e selecione a pasta criada pra importar as composições.',
    });
  } catch (err) {
    // Em falha, transiciona pra 'erro'
    if (licitacaoId) {
      await admin.from('licitacoes').update({ status: 'erro' }).eq('id', licitacaoId);
    }
    if (err instanceof OrcafascioAuthError) {
      return errorResponse(ERR_AUTH_TO_HTTP[err.code], err.message, err.details);
    }
    if (err instanceof OrcafascioApiError) {
      return errorResponse(502, err.message, { endpoint: err.endpoint, details: err.details });
    }
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.message, err.details);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cadastrar-edital] erro inesperado:', err);
    return errorResponse(500, msg);
  }
});
