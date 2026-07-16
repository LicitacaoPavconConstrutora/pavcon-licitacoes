// =============================================================================
// Códigos pendentes de mapeamento — escopados pra uma licitação
// =============================================================================
// `orcafascio_code_mappings` é uma tabela GLOBAL (sem coluna licitacao_id —
// é reusada entre editais futuros de propósito). Sem cruzar com os
// sub-itens PROPRIA desta licitação específica, qualquer caller que
// buscasse "os códigos pendentes" veria os de TODAS as licitações já
// processadas pelo sistema, não só desta — em sistemas rodando há meses,
// os pendentes relevantes desta licitação podem nem entrar num corte
// simples (ex: "os 30 primeiros").
//
// Usado por: claudio-chat (tool consultar_codes_pendentes) e
// orcapav-corrigir-gemini (fallback Gemini quando a conta Anthropic fica
// sem créditos). A MESMA lógica também existe em
// frontend/src/lib/agente/actions.ts (analisarLicitacao) — como aquele
// roda no runtime do Vercel/Next.js (não importa módulos Deno daqui),
// qualquer mudança de regra aqui precisa ser espelhada manualmente lá.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export interface CodePendente {
  fonte_original: string;
  codigo_original: string;
  descricao: string | null;
}

export async function codesPendentesDaLicitacao(
  admin: SupabaseClient,
  licitacaoId: string,
): Promise<CodePendente[]> {
  const { data: proprias } = await admin
    .from('composicoes_extraidas')
    .select('id')
    .eq('licitacao_id', licitacaoId)
    .eq('fonte', 'PROPRIA');
  const compIds = (proprias ?? []).map((c) => c.id);
  if (compIds.length === 0) return [];

  const { data: subitens } = await admin
    .from('composicao_propria_itens')
    .select('codigo, fonte')
    .in('composicao_extraida_id', compIds);
  const codesDaLicitacao = new Set(
    (subitens ?? []).map((s) => `${(s.fonte ?? '').toUpperCase()}/${s.codigo ?? ''}`),
  );
  if (codesDaLicitacao.size === 0) return [];

  const { data: pendentes } = await admin
    .from('orcafascio_code_mappings')
    .select('fonte_original, codigo_original, descricao')
    .is('codigo_substituto', null);
  return (pendentes ?? []).filter((m) =>
    codesDaLicitacao.has(`${(m.fonte_original ?? '').toUpperCase()}/${m.codigo_original ?? ''}`),
  );
}
