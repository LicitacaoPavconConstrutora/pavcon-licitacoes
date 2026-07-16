// =============================================================================
// Edge Function: orcafascio-ajustar-total
// =============================================================================
// Força o total do orçamento BASE no Orçafascio a bater com `valor_total_alvo`.
// Útil quando o cadastramento ficou incompleto (composições próprias em branco,
// codes descontinuados) e o total ficou abaixo do que o edital pede. Aplica o
// "Ajustar valor" do Orçafascio — fator linear sobre todos os itens não-zero.
//
// LIMITAÇÃO: ajuste é proporcional. Composições com R$ 0,00 continuam R$ 0,00.
// Composições com preço inflam pelo fator. Total bate, distribuição imperfeita.
// Pra estrutura correta, ainda precisa popular os sub-itens das composições.
//
// IMPORTANTE (jul/2026): a chamada HTTP direta ao endpoint interno do
// Orçafascio (ajustarValor em orcafascio-web-v2023.ts) já CORROMPEU
// orçamentos reais duas vezes (ver histórico nesse arquivo e commit
// 42f4d8d) — as tentativas anteriores adivinhavam a sequência de campos/
// URLs do endpoint em vez de reproduzir o que o navegador real faz.
// Por isso esta function agora exige o Cláudio Proxy (claudio-proxy/) rodando
// com automação de navegador (Playwright) — ele clica no formulário real em
// vez de adivinhar a chamada da API. Sem CLAUDIO_PROXY_URL configurado, esta
// function recusa a operação em vez de arriscar corromper o orçamento.
//
// Body:
//   { licitacao_id, credential_id, valor_total_alvo, dry_run? }
//   dry_run: true preenche o form no Orçafascio mas NÃO submete — use isso
//   pra validar visualmente (screenshots) antes de rodar de verdade.
// =============================================================================

import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import {
  getServiceRoleClient,
  requireAuthenticatedUser,
} from '../_shared/supabase.ts';
import {
  authenticateOrcafascioWeb,
  OrcafascioWebError,
} from '../_shared/orcafascio-web.ts';
import {
  ajustarValorViaProxy,
  AjustarValorProxyError,
} from '../_shared/ajustar-valor-proxy.ts';

interface RequestBody {
  licitacao_id?: string;
  credential_id?: string;
  valor_total_alvo?: number;
  dry_run?: boolean;
  trace_id?: string;
}

Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  // ---- GET /?disponibilidade — healthcheck de configuração ------------------
  // O frontend (Vercel) precisa saber se pode oferecer o botão "Forçar
  // Total", mas CLAUDIO_PROXY_URL/FORCAR_TOTAL_AUTO_DESATIVADO são secrets
  // do SUPABASE — configuráveis independentemente das env vars do Vercel.
  // Manter os dois em sincronia manualmente é frágil (ver histórico: botão
  // aparece mas 503, ou botão some mesmo com o backend pronto). Esta rota
  // faz do Supabase a ÚNICA fonte de verdade: o frontend chama aqui em vez
  // de reler suas próprias env vars.
  if (req.method === 'GET') {
    const disponivel = !!Deno.env.get('CLAUDIO_PROXY_URL') &&
      Deno.env.get('FORCAR_TOTAL_AUTO_DESATIVADO') !== 'true';
    return jsonResponse({ disponivel });
  }

  if (req.method !== 'POST') return errorResponse(405, 'Use GET (healthcheck) ou POST.');

  let body: RequestBody;
  try { body = await req.json(); } catch { return errorResponse(400, 'JSON inválido.'); }

  const licitacaoId = body.licitacao_id?.trim();
  const credentialId = body.credential_id?.trim();
  const valorAlvo = body.valor_total_alvo;

  if (!licitacaoId) return errorResponse(400, 'licitacao_id é obrigatório.');
  if (!credentialId) return errorResponse(400, 'credential_id é obrigatório.');
  if (!Number.isFinite(valorAlvo) || (valorAlvo as number) <= 0) {
    return errorResponse(400, `valor_total_alvo inválido: ${valorAlvo}`);
  }

  const traceId = body.trace_id ?? crypto.randomUUID();
  const admin = getServiceRoleClient();

  try {
    const user = await requireAuthenticatedUser(req);

    // ---- 1) Carrega licitação + budget_id ----------------------------------
    const { data: lic, error: licErr } = await admin
      .from('licitacoes')
      .select('id, status, titulo, orcafascio_orcamento_base_id')
      .eq('id', licitacaoId)
      .maybeSingle();
    if (licErr || !lic) return errorResponse(404, 'Licitação não encontrada.', licErr?.message);

    const budgetId = lic.orcafascio_orcamento_base_id;
    if (!budgetId) {
      return errorResponse(
        422,
        'orcafascio_orcamento_base_id não preenchido. Cadastre o orçamento primeiro.',
      );
    }

    // ---- 2) Autentica Orçafascio web (só precisamos do cookie da sessão — o
    // Cláudio Proxy injeta ele num navegador real, não fazemos fetch direto) --
    const session = await authenticateOrcafascioWeb(admin, credentialId, {
      callerUserId: user.id,
      traceId,
      licitacaoId,
    });

    // ---- 3) Delega o ajuste pro Cláudio Proxy (automação de navegador) -----
    // Kill-switch, checagem de proxy configurado, sessão viva e log de
    // auditoria são todos centralizados em ajustarValorViaProxy — não
    // reimplementar aqui (ver _shared/ajustar-valor-proxy.ts).
    const proxyResult = await ajustarValorViaProxy(admin, session, {
      budgetId,
      valorFinal: valorAlvo as number,
      dryRun: !!body.dry_run,
      callerUserId: user.id,
      licitacaoId,
      traceId,
    });

    if (!proxyResult.ok) {
      // IMPORTANTE: NÃO usar errorResponse aqui — ele aninha proxyResult
      // sob "details", e o frontend (auto-fixes.ts) lê screenshots no nível
      // raiz do body. Screenshots são justamente o que o orçamentista
      // precisa ver quando a automação falha (seletor não achado, sessão
      // expirou no meio, etc.) — aninhar os esconderia exatamente na hora
      // em que mais importam.
      return jsonResponse({
        ok: false,
        error: proxyResult.error ?? 'Ajustar valor falhou no proxy.',
        aviso: proxyResult.aviso,
        passos: proxyResult.passos,
        screenshots: proxyResult.screenshots,
        trace_id: traceId,
      }, 502);
    }

    return jsonResponse({
      ok: true,
      budget_id: budgetId,
      budget_url: `https://app.orcafascio.com/orc/orcamentos/${budgetId}`,
      valor_alvo_aplicado: valorAlvo,
      trace_id: traceId,
      dry_run: !!proxyResult.dry_run,
      total_confere_na_pagina: proxyResult.total_confere_na_pagina,
      aviso: proxyResult.aviso,
      screenshots: proxyResult.screenshots,
      proximo_passo: proxyResult.dry_run
        ? 'Modo dry-run: form preenchido mas NÃO submetido. Confira os screenshots antes de rodar sem dry_run.'
        : 'Abre o orçamento no Orçafascio pra conferir. Total bate com o alvo; ' +
          'a distribuição interna foi escalada linearmente — itens em branco continuam zerados.',
    });
  } catch (err) {
    if (err instanceof OrcafascioWebError) {
      return errorResponse(502, `Auth Orçafascio falhou: ${err.message}`, { code: err.code });
    }
    if (err instanceof AjustarValorProxyError) {
      return errorResponse(err.status, err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(500, `Erro inesperado: ${msg}`);
  }
});
