// =============================================================================
// Ajustar Valor — delegação centralizada pro Cláudio Proxy
// =============================================================================
// TODA function que precisa forçar o total de um orçamento no Orçafascio
// (orcafascio-ajustar-total, orcafascio-cadastrar-proposta,
// orcafascio-cadastrar-orcamento) deve chamar `ajustarValorViaProxy` daqui
// em vez de reimplementar a delegação. Isso existe porque a chamada HTTP
// direta ao endpoint interno do Orçafascio (`ajustarValor` em
// orcafascio-web-v2023.ts) já CORROMPEU orçamentos reais duas vezes — as
// tentativas anteriores adivinhavam a sequência de campos/URLs em vez de
// reproduzir o que o navegador real faz. `ajustarValor` continua existindo
// só pra referência histórica; NÃO chame direto — use este módulo.
//
// Centraliza 3 coisas que já existiam antes da migração pro proxy e não
// podem se perder de novo:
//   1. Kill-switch (FORCAR_TOTAL_AUTO_DESATIVADO) — checado uma única vez.
//   2. Checagem de sessão viva (fetchCsrfToken) ANTES de mutar — sem isso,
//      uma sessão cacheada-mas-morta só falha depois, no meio da automação
//      de navegador, sem chance de recovery.
//   3. Log de auditoria (logIntegration) da chamada ao proxy — sem isso,
//      não sobra registro no Supabase pra essa ação, só log local no PC
//      do operador.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { logIntegration } from './audit.ts';
import { fetchCsrfToken } from './orcafascio-web-v2023.ts';
import type { OrcafascioWebSession } from './orcafascio-web.ts';

export interface AjustarValorProxyResult {
  ok: boolean;
  dry_run?: boolean;
  error?: string;
  aviso?: string;
  total_confere_na_pagina?: boolean;
  valor_esperado_formatado?: string;
  passos?: string[];
  screenshots?: Record<string, string>;
}

export class AjustarValorProxyError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AjustarValorProxyError';
  }
}

export interface AjustarValorProxyOpts {
  budgetId: string;
  valorFinal: number;
  dryRun?: boolean;
  callerUserId: string;
  licitacaoId?: string | null;
  traceId?: string;
}

/**
 * Ajusta o valor final de um orçamento via automação de navegador
 * (Cláudio Proxy + Playwright). Lança `AjustarValorProxyError` pra falhas
 * de PRÉ-CONDIÇÃO (kill-switch ativo, proxy não configurado, sessão morta,
 * proxy inalcançável — nenhuma dessas tem screenshot pra mostrar). Pra
 * falhas DEPOIS que o proxy rodou (seletor não achado, sessão expirou no
 * meio, etc.) retorna normalmente com `ok:false` — o caller decide como
 * montar a resposta HTTP, mas deve manter `screenshots` no nível raiz do
 * JSON (não aninhar em `details`), senão o front nunca mostra os prints.
 */
export async function ajustarValorViaProxy(
  admin: SupabaseClient,
  session: OrcafascioWebSession,
  opts: AjustarValorProxyOpts,
): Promise<AjustarValorProxyResult> {
  if (Deno.env.get('FORCAR_TOTAL_AUTO_DESATIVADO') === 'true') {
    throw new AjustarValorProxyError(
      503,
      'Forçar total automático está desativado (FORCAR_TOTAL_AUTO_DESATIVADO=true). ' +
        'Ajuste o valor manualmente no Orçafascio ("Editar → Ajustar valor").',
    );
  }

  const proxyUrl = Deno.env.get('CLAUDIO_PROXY_URL');
  const proxyToken = Deno.env.get('CLAUDIO_PROXY_TOKEN') ?? '';
  if (!proxyUrl) {
    throw new AjustarValorProxyError(
      503,
      'Forçar total requer o Cláudio Proxy configurado (CLAUDIO_PROXY_URL) — ' +
        'a chamada direta à API do Orçafascio foi desativada por corromper orçamentos. ' +
        'Configure o proxy local (vide claudio-proxy/README.md) ou ajuste o valor ' +
        'manualmente no Orçafascio ("Editar → Ajustar valor").',
    );
  }

  // Checagem de sessão viva ANTES de mutar. A sessão cacheada no DB pode
  // parecer válida (TTL 4h) mas o Orçafascio expirou silenciosamente
  // (logout em outro device, load balancer rotacionou instância). Sem
  // isso, só descobríamos a sessão morta depois de abrir o navegador de
  // verdade (redirect pro /login no meio da automação), sem chance de
  // recovery automático.
  const csrfToken = await fetchCsrfToken(session);
  if (csrfToken == null) {
    throw new AjustarValorProxyError(
      502,
      'Sessão do Orçafascio expirou. Tente novamente — a chamada seguinte deve reautenticar automaticamente.',
    );
  }

  const startedAt = Date.now();
  const endpoint = `${proxyUrl}/ajustar-valor`;
  const requestPayload = {
    budget_id: opts.budgetId,
    valor_final: opts.valorFinal,
    dry_run: !!opts.dryRun,
  };

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(proxyToken ? { authorization: `Bearer ${proxyToken}` } : {}),
      },
      body: JSON.stringify({ ...requestPayload, cookie_header: session.cookie_header }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logIntegration(admin, {
      user_id: opts.callerUserId,
      licitacao_id: opts.licitacaoId ?? null,
      provider: 'orcafascio',
      endpoint,
      metodo_http: 'POST',
      request_payload: requestPayload,
      response_status: 0,
      response_payload: { error: msg },
      duracao_ms: Date.now() - startedAt,
      trace_id: opts.traceId ?? null,
    });
    throw new AjustarValorProxyError(
      502,
      `Não consegui alcançar o Cláudio Proxy — confirme que ele e o tunnel estão rodando. (${msg})`,
    );
  }

  const proxyResult = (await resp.json()) as AjustarValorProxyResult;

  await logIntegration(admin, {
    user_id: opts.callerUserId,
    licitacao_id: opts.licitacaoId ?? null,
    provider: 'orcafascio',
    endpoint,
    metodo_http: 'POST',
    request_payload: requestPayload,
    response_status: resp.status,
    // Não loga screenshots (payload grande, base64) — só os campos leves.
    response_payload: {
      ok: proxyResult.ok,
      error: proxyResult.error,
      aviso: proxyResult.aviso,
      total_confere_na_pagina: proxyResult.total_confere_na_pagina,
      passos: proxyResult.passos,
    },
    duracao_ms: Date.now() - startedAt,
    trace_id: opts.traceId ?? null,
  });

  return proxyResult;
}
