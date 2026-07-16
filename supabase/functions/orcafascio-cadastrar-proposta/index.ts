// =============================================================================
// Edge Function: orcafascio-cadastrar-proposta
// =============================================================================
// Cria a PROPOSTA READEQUADA no Orçafascio em 2 etapas:
//   1. COPIA o orçamento base (preserva composições, BDI, leis sociais)
//   2. AJUSTA o valor final do novo orçamento pra bater com o valor calculado
//      pela nossa regra MO-aware (desconto não incide sobre mão de obra)
//
// A diferença entre o ajuste linear do Orçafascio e o cálculo MO-aware é
// ASSUMIDA: o total final do orçamento bate (Orçafascio garante), mas a
// distribuição interna por composição pode descontar MO proporcionalmente.
// Pra a maioria dos editais isso é aceitável — o que importa é o total
// (que é o que o órgão licitante avalia).
//
// Body (JSON):
//   { licitacao_id, credential_id, desconto_percentual, valor_proposta? }
//
// Resposta 200:
//   { ok, budget_id, budget_url, valor_aplicado, warnings }
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
  copyBudget,
  createContext,
  OrcafascioV2023Error,
} from '../_shared/orcafascio-web-v2023.ts';
import {
  ajustarValorViaProxy,
  AjustarValorProxyError,
} from '../_shared/ajustar-valor-proxy.ts';

interface RequestBody {
  licitacao_id?: string;
  credential_id?: string;
  desconto_percentual?: number;
  /** Valor final desejado pra proposta (com BDI). Pré-calculado pelo
   * backend respeitando regra de MO. Se omitido, a Edge Function calcula. */
  valor_proposta?: number;
  /** WORKAROUND do bug Orçafascio: pula a chamada ajustarValor que corrompe
   * o budget novo (500 ao abrir). Quando true, só copia o budget base sem
   * aplicar o ajuste — o orçamentista aplica o desconto manualmente na UI
   * do Orçafascio. Mais cliques mas funciona 100%. */
  skip_ajustar_valor?: boolean;
  trace_id?: string;
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

Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') {
    return errorResponse(405, 'Use POST.');
  }

  let body: RequestBody;
  try { body = await req.json(); } catch { return errorResponse(400, 'JSON inválido.'); }

  const licitacaoId = body.licitacao_id?.trim();
  const credentialId = body.credential_id?.trim();
  const desconto = body.desconto_percentual;

  if (!licitacaoId) return errorResponse(400, 'licitacao_id é obrigatório.');
  if (!credentialId) return errorResponse(400, 'credential_id é obrigatório.');
  if (desconto == null || !Number.isFinite(desconto) || desconto <= 0 || desconto >= 100) {
    return errorResponse(400, 'desconto_percentual deve ser entre 0 e 100 (exclusivo).');
  }

  const traceId = body.trace_id ?? crypto.randomUUID();
  const admin = getServiceRoleClient();
  const warnings: string[] = [];

  try {
    const user = await requireAuthenticatedUser(req);

    // ---- 1) Carrega licitação ------------------------------------------------
    const { data: lic, error: licErr } = await admin
      .from('licitacoes')
      .select(
        'id, status, titulo, municipio, bdi_referencia_edital, orcafascio_orcamento_base_id',
      )
      .eq('id', licitacaoId)
      .maybeSingle();
    if (licErr || !lic) {
      return errorResponse(404, 'Licitação não encontrada.', licErr?.message);
    }
    if (lic.status !== 'fase1_concluida' && lic.status !== 'finalizado') {
      return errorResponse(
        409,
        `Licitação precisa estar em fase1_concluida (atual: "${lic.status}").`,
      );
    }
    const sourceBudgetId = lic.orcafascio_orcamento_base_id;
    if (!sourceBudgetId) {
      return errorResponse(
        422,
        'orcafascio_orcamento_base_id não preenchido na licitação. Recadastre o orçamento base ou popule manualmente.',
      );
    }

    // ---- 2) Calcula valor_proposta se não veio do cliente -------------------
    let valorProposta = body.valor_proposta;
    if (valorProposta == null || !Number.isFinite(valorProposta) || valorProposta <= 0) {
      // Fallback: usa cálculo simples (valor_total × (1-desconto%)).
      // Não respeita MO — só serve quando o cliente esqueceu de pré-calcular.
      const { data: comps } = await admin
        .from('composicoes_extraidas')
        .select('preco_total')
        .eq('licitacao_id', licitacaoId)
        .eq('tipo_linha', 'servico');
      const totalEdital = (comps ?? []).reduce(
        (s, c) => s + Number(c.preco_total ?? 0),
        0,
      );
      valorProposta = totalEdital * (1 - desconto / 100);
      warnings.push(
        `valor_proposta não foi fornecido. Calculei desconto LINEAR sobre o total (sem regra de MO): ${valorProposta.toFixed(2)}`,
      );
    }
    if (!Number.isFinite(valorProposta) || valorProposta <= 0) {
      return errorResponse(422, `valor_proposta inválido: ${valorProposta}`);
    }

    // ---- 3) Auth + contexto Orçafascio --------------------------------------
    const session = await authenticateOrcafascioWeb(admin, credentialId, {
      callerUserId: user.id,
      traceId,
      licitacaoId,
    });
    const ctx = await createContext(
      admin, session, credentialId, user.id, licitacaoId, traceId,
      () => authenticateOrcafascioWeb(admin, credentialId, {
        callerUserId: user.id,
        forceRefresh: true,
        traceId,
        licitacaoId,
      }),
    );

    // ---- 4) Copia o orçamento base ------------------------------------------
    const { budget_id: novoBudgetId } = await copyBudget(ctx, sourceBudgetId);

    // Delay entre copy e ajustarValor — race observado: chamar ajustarValor
    // imediatamente após o 302 do copyBudget às vezes pega o orçamento ainda
    // sendo processado internamente pelo Orçafascio (items não foram todos
    // copiados ainda), e o ajustarValor aplica fator sobre estado parcial,
    // corrompendo o budget e gerando 500 ao abrir depois. 2 segundos resolve
    // na maioria dos casos.
    await new Promise((r) => setTimeout(r, 2000));

    // ---- 5) Aplica ajustar_valor (a menos que skip_ajustar_valor) -----------
    // O Orçafascio aplica o fator linear sobre TODOS os itens pra alcançar
    // exatamente o `valorProposta`. Como esse valor já respeita a regra de
    // MO (calculado no backend), o resultado total bate, embora a divisão
    // interna fique linear.
    //
    // IMPORTANTE (jul/2026): NÃO chama mais ajustarValor() (chamada HTTP
    // direta) — corrompia o budget internamente (500 ao abrir depois).
    // Delega pra ajustarValorViaProxy (automação de navegador via Cláudio
    // Proxy, ver _shared/ajustar-valor-proxy.ts), que clica no formulário
    // real do Orçafascio em vez de adivinhar a chamada da API. Se o proxy
    // não estiver configurado (ou a automação falhar), cai no mesmo
    // comportamento de skip_ajustar_valor=true: budget fica com o valor do
    // base e o warning avisa pra ajustar manualmente — nunca arrisca
    // corromper o budget.
    if (body.skip_ajustar_valor === true) {
      warnings.push(
        `ajustarValor PULADO (skip_ajustar_valor=true). Orçamento copiado ` +
        `com valor do base. Aplique o desconto manualmente no Orçafascio ` +
        `usando "Ajustar valor" da UI.`,
      );
    } else {
      try {
        const ajusteResult = await ajustarValorViaProxy(admin, session, {
          budgetId: novoBudgetId,
          valorFinal: valorProposta,
          callerUserId: user.id,
          licitacaoId,
          traceId,
        });
        if (!ajusteResult.ok) {
          warnings.push(
            `Ajustar valor falhou: ${ajusteResult.error ?? 'erro desconhecido'} — orçamento copiado mas sem ` +
            'desconto aplicado. Ajuste manualmente no Orçafascio usando "Ajustar valor" da UI.',
          );
        } else if (ajusteResult.aviso) {
          warnings.push(`Ajustar valor: ${ajusteResult.aviso}`);
        }
      } catch (e) {
        // AjustarValorProxyError (proxy não configurado/desativado/sessão
        // morta) ou qualquer outro erro inesperado — nunca deixa travar o
        // cadastro da proposta, só avisa pra ajustar manualmente.
        const msg = e instanceof AjustarValorProxyError
          ? e.message
          : (e instanceof Error ? e.message : String(e));
        warnings.push(
          `Ajustar valor não aplicado: ${msg.slice(0, 200)} — orçamento copiado mas sem desconto aplicado. ` +
          'Ajuste manualmente no Orçafascio usando "Ajustar valor" da UI.',
        );
      }
    } // fim do if (skip_ajustar_valor)

    // ---- 5.5) Verificação pós-cadastro: confirma que o orçamento existe ----
    // Bug observado (NOVO ORIENTE 001 - 03/06/2026): copyBudget + ajustarValor
    // retornam 200 OK mas ao abrir a URL no browser, Orçafascio mostra 500
    // "Ocorreu um erro durante esse processo". O orçamento ficou em estado
    // inválido — provável race entre o copy e o ajuste linear que corrompe a
    // estrutura interna. Sem essa verificação, PavCon mostra "Proposta
    // cadastrada!" mas o link leva pro 500.
    //
    // Faz GET no budget URL — se 200, OK. Se 302/3xx ou 500, o budget está
    // corrompido e a gente avisa o user pra retentar (não persiste o
    // budget_id inválido).
    // Verificação pós-cadastro com retry + endpoint alternativo.
    // Orçafascio tem 2 jeitos de acessar o budget:
    //   (a) /orc/orcamentos/{id}  — UI clássica, ÀS VEZES retorna 500
    //   (b) /v2023/bud/budgets/{id}  — API v2023, mais estável
    // Tenta (a) primeiro, se falhar tenta (b). Se (b) responde OK, considera
    // que o budget existe e está acessível (a UI clássica pode tar com bug).
    let propostaVerificada = false;
    let ultimoStatusA = 0;
    let ultimoStatusB = 0;
    const delays = [1500, 3000, 5000, 8000, 12000, 15000];

    async function verificar(): Promise<{ statusA: number; statusB: number; ok: boolean }> {
      let statusA = 0;
      let statusB = 0;
      try {
        const respA = await fetch(
          `https://app.orcafascio.com/orc/orcamentos/${novoBudgetId}`,
          {
            method: 'GET',
            headers: { Cookie: ctx.session.cookie_header, 'User-Agent': 'pavcon/0.1', Accept: 'text/html' },
            redirect: 'manual',
          },
        );
        statusA = respA.status;
        if (statusA === 200) return { statusA, statusB: 0, ok: true };
      } catch {}
      // Fallback: API v2023 mais estável
      try {
        const respB = await fetch(
          `https://app.orcafascio.com/v2023/bud/budgets/${novoBudgetId}`,
          {
            method: 'GET',
            headers: { Cookie: ctx.session.cookie_header, 'User-Agent': 'pavcon/0.1', Accept: 'application/json' },
            redirect: 'manual',
          },
        );
        statusB = respB.status;
        if (statusB >= 200 && statusB < 400) return { statusA, statusB, ok: true };
      } catch {}
      return { statusA, statusB, ok: false };
    }

    for (let tentativa = 0; tentativa < delays.length; tentativa++) {
      await new Promise((r) => setTimeout(r, delays[tentativa]));
      const v = await verificar();
      ultimoStatusA = v.statusA;
      ultimoStatusB = v.statusB;
      if (v.ok) {
        propostaVerificada = true;
        if (tentativa > 0 || v.statusB > 0) {
          warnings.push(
            `Proposta verificada na tentativa ${tentativa + 1} ` +
            `(UI=${v.statusA}, API_v2023=${v.statusB || 'não testada'}).`,
          );
        }
        break;
      }
    }

    if (!propostaVerificada) {
      warnings.push(
        `⚠ Orçafascio retornou erros ao abrir a proposta criada (budget_id=${novoBudgetId}, ` +
        `UI=${ultimoStatusA}, API=${ultimoStatusB}) após ${delays.length} tentativas (${delays.reduce((a, b) => a + b, 0) / 1000}s total). ` +
        `O budget FOI CRIADO no Orçafascio (copy + ajustarValor retornaram OK), mas a abertura via UI está falhando. ` +
        `Tente abrir o link você mesmo — se abrir, ótimo (bug intermitente do servidor deles). ` +
        `Se mesmo no seu browser não abrir, apague manualmente no Orçafascio e refaça.`,
      );
    }

    // ---- 6) Persiste budget_id da proposta na licitação --------------------
    // MUDANÇA: persiste o budget_id MESMO quando verificação falha.
    // Razão: o budget foi criado (logs confirmam 302 success do copy+adjust),
    // só a verificação do servidor Orçafascio tá com bug intermitente.
    // Salvar o ID dá a chance do orçamentista abrir o link manualmente —
    // muitas vezes funciona quando o servidor deles "esquenta".
    // Se de fato tá quebrado, o user apaga e retenta.
    await admin
      .from('licitacoes')
      .update({
        desconto_percentual: desconto,
        valor_proposta_pavcon: valorProposta,
        orcafascio_proposta_budget_id: novoBudgetId,
      })
      .eq('id', licitacaoId);

    return jsonResponse({
      ok: propostaVerificada,
      proposta_verificada: propostaVerificada,
      budget_id: novoBudgetId,
      budget_url: `https://app.orcafascio.com/orc/orcamentos/${novoBudgetId}`,
      source_budget_id: sourceBudgetId,
      valor_aplicado: valorProposta,
      desconto_percentual: desconto,
      warnings,
      trace_id: traceId,
      proximo_passo: propostaVerificada
        ? 'Abra o link no Orçafascio pra revisar o orçamento da proposta. Total deve bater.'
        : 'Orçamento criado mas Orçafascio retornou erro ao abrir. Apague o orçamento "fantasma" manualmente no Orçafascio (lixeira), depois tente de novo com valor alvo ligeiramente diferente.',
    });
  } catch (err) {
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
    console.error('[cadastrar-proposta] erro:', err);
    return errorResponse(500, msg);
  }
});
