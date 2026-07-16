'use server';

// =============================================================================
// Auto-fixes do Cláudio
// =============================================================================
// Cada auto-fix é uma server action que aplica uma correção determinística
// em uma licitação. O Cláudio sugere e executa em 1-click.
//
// Padrão de retorno: { ok, mensagem, mudancas: number }
// =============================================================================

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

interface AutoFixResult {
  ok?: boolean;
  error?: string;
  mensagem?: string;
  mudancas?: number;
  /** Screenshots (base64 PNG) da automação de navegador — só em forcarTotalOrcamentoBase. */
  screenshots?: Record<string, string>;
}

// Reusa o mesmo detector usado no importarExtracaoManual pra manter
// consistência (se mudarmos um, o outro também muda).
function ehCodigoAdaptado(fonte: string | null, codigo: string | null): { adaptado: boolean; motivo?: string } {
  if (!codigo || !fonte) return { adaptado: false };
  const f = fonte.toUpperCase();
  if (f === 'PROPRIA' || f === 'OUTRA') return { adaptado: false };
  const c = codigo.toUpperCase().trim();
  if (/^COMPOSI[CÇ][ÃA]O\s*[\d_-]+/i.test(c)) {
    return { adaptado: true, motivo: 'código é texto literal "COMPOSIÇÃO XX"' };
  }
  if (/[\s-]ADAPT?(?:AD[OA])?\s*$|^ADAPTAD[OA]\s|\sADAP\s|\s-\s*A\s*$|-A$|-ADAP$/i.test(c)) {
    return { adaptado: true, motivo: 'sufixo de adaptação (-ADAP, -A, adaptado)' };
  }
  return { adaptado: false };
}

/**
 * AUTO-FIX 1: Reclassifica retroativamente codes adaptados como PROPRIA.
 *
 * Aplica em composicoes_extraidas existentes sem precisar re-importar JSON.
 * Útil pra licitações que foram importadas antes do fix de normalização
 * automática. O Cláudio detecta esses casos e oferece o botão pra resolver
 * em 1-click.
 *
 * Side effects:
 *   - Atualiza fonte='PROPRIA' nas linhas afetadas
 *   - Salva metadata.fonte_original + codigo_original + reclassificada_motivo
 *   - NÃO toca em orcafascio_composition_id (pra que cadastrar-edital
 *     trate como composição nova e crie no MyBase em branco)
 */
export async function reclassificarCodesAdaptados(licitacaoId: string): Promise<AutoFixResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado.' };

  const admin = createAdminClient();
  const { data: items, error } = await admin
    .from('composicoes_extraidas')
    .select('id, fonte, codigo, metadata')
    .eq('licitacao_id', licitacaoId)
    .eq('tipo_linha', 'servico');
  if (error) return { error: error.message };

  const aReclassificar = (items ?? [])
    .map((it) => {
      const check = ehCodigoAdaptado(it.fonte, it.codigo);
      return check.adaptado ? { id: it.id, codigo: it.codigo, fonte: it.fonte, motivo: check.motivo, metadata: it.metadata } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (aReclassificar.length === 0) {
    return { ok: true, mensagem: 'Nada a reclassificar — todos os codes já estão corretos.', mudancas: 0 };
  }

  // Atualiza em lote
  for (const item of aReclassificar) {
    const metaAtual = (item.metadata as Record<string, unknown> | null) ?? {};
    await admin
      .from('composicoes_extraidas')
      .update({
        fonte: 'PROPRIA',
        // Limpa orcafascio_composition_id pra forçar recriação no MyBase
        orcafascio_composition_id: null,
        metadata: {
          ...metaAtual,
          fonte_original: item.fonte,
          codigo_original: item.codigo,
          reclassificada_motivo: item.motivo,
          reclassificada_em: new Date().toISOString(),
          reclassificada_por: 'claudio_auto',
        },
      })
      .eq('id', item.id);
  }

  revalidatePath(`/licitacoes/${licitacaoId}`);
  return {
    ok: true,
    mensagem: `${aReclassificar.length} item(ns) reclassificado(s) de SINAPI/ORSE pra PROPRIA. ` +
      `Próximo passo: clique "🚀 Cadastrar tudo no Orçafascio" pra criar as composições próprias correspondentes.`,
    mudancas: aReclassificar.length,
  };
}

/**
 * AUTO-FIX 2: Limpa orcafascio_composition_id de composições PROPRIA pra
 * forçar recriação no MyBase em retentativa. Útil quando o user mapeou
 * codes na tabela de mapeamentos e precisa re-rodar pra aplicar.
 */
export async function limparMyBaseIdsPropria(licitacaoId: string): Promise<AutoFixResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado.' };

  const admin = createAdminClient();
  const { count } = await admin
    .from('composicoes_extraidas')
    .update({ orcafascio_composition_id: null }, { count: 'exact' })
    .eq('licitacao_id', licitacaoId)
    .eq('fonte', 'PROPRIA')
    .not('orcafascio_composition_id', 'is', null);

  revalidatePath(`/licitacoes/${licitacaoId}`);
  return {
    ok: true,
    mensagem: `${count ?? 0} composição(ões) própria(s) marcada(s) pra recriação. ` +
      `Clique "🚀 Cadastrar tudo" pra aplicar mapeamentos novos.`,
    mudancas: count ?? 0,
  };
}

/**
 * AUTO-FIX 3: Define data_base do edital quando ausente.
 *
 * Sem data_base_descricao, o Edge Function cadastrar-edital cai num fallback
 * (mês atual) — codes do edital podem ficar em versão diferente do banco no
 * Orçafascio e zerar preço ou retornar 500. Esse auto-fix permite o user
 * digitar a data-base correta inline na UI do Cláudio sem voltar etapa
 * inteira.
 *
 * Aceita formatos: "MM/AAAA", "fev/26", "fevereiro/2026", "JANEIRO/2026"
 * — o cadastrar-edital normaliza no momento de uso (parseDataBase).
 *
 * Side effects:
 *   - Atualiza licitacoes.data_base_descricao
 *   - Atualiza extracoes_ocr.json_corrigido.cabecalho.data_base_descricao
 *     (pra que próxima reanálise leia o valor novo do mesmo lugar)
 */
export async function definirDataBase(
  licitacaoId: string,
  dataBase: string,
): Promise<AutoFixResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado.' };
  const valor = dataBase.trim();
  if (!valor) return { error: 'Data-base vazia. Ex: "04/2026" ou "abril/2026".' };
  // Validação leve: precisa ter dígitos
  if (!/\d/.test(valor)) {
    return { error: 'Data-base inválida. Use formato "MM/AAAA" ou "mês/ano".' };
  }

  const admin = createAdminClient();
  // 1) licitacoes.data_base_descricao
  const { error: e1 } = await admin
    .from('licitacoes')
    .update({ data_base_descricao: valor })
    .eq('id', licitacaoId);
  if (e1) return { error: `Falha ao salvar em licitacoes: ${e1.message}` };

  // 2) extracoes_ocr.json_corrigido.cabecalho — só atualiza se existir
  const { data: extr } = await admin
    .from('extracoes_ocr')
    .select('id, json_corrigido, json_extraido')
    .eq('licitacao_id', licitacaoId)
    .in('status', ['sucesso', 'revisada_humano'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (extr) {
    const src = (extr.json_corrigido ?? extr.json_extraido) as Record<string, unknown> | null;
    if (src && typeof src === 'object') {
      const cabecalho = ((src.cabecalho as Record<string, unknown> | undefined) ?? {});
      const novoJson = {
        ...src,
        cabecalho: { ...cabecalho, data_base_descricao: valor },
      };
      await admin
        .from('extracoes_ocr')
        .update({ json_corrigido: novoJson })
        .eq('id', extr.id);
    }
  }

  revalidatePath(`/licitacoes/${licitacaoId}`);
  return {
    ok: true,
    mensagem: `Data-base setada pra "${valor}". Clique "🚀 Cadastrar tudo" pra re-rodar com a nova base.`,
    mudancas: 1,
  };
}

/**
 * AUTO-FIX 4: Adiciona mapeamentos de codes descontinuados em batch.
 *
 * Recebe um array de {fonte_original, codigo_original, fonte_nova, codigo_novo}
 * e popula a tabela orcafascio_code_mappings. Próxima rodada do cadastrar-edital
 * aplica automaticamente.
 *
 * Identity mapping (codigo_novo == codigo_original) é permitido — funciona como
 * "confirmar que esse code é válido, pode retentar". Útil quando o code é real
 * mas Orçafascio falhou por outra razão (ex: data-base errada).
 *
 * Também limpa orcafascio_composition_id das composições que usavam esses codes,
 * pra que o retry tente adicionar os items que tinham falhado.
 */
export async function salvarMapeamentosCodes(
  licitacaoId: string,
  mapeamentos: Array<{
    fonte_original: string;
    codigo_original: string;
    fonte_nova?: string;
    codigo_novo: string;
    descricao?: string | null;
  }>,
): Promise<AutoFixResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado.' };
  if (!mapeamentos || mapeamentos.length === 0) {
    return { error: 'Nenhum mapeamento fornecido.' };
  }

  const admin = createAdminClient();
  const linhas = mapeamentos.map((m) => ({
    fonte_original: m.fonte_original.toUpperCase(),
    codigo_original: m.codigo_original,
    fonte: (m.fonte_nova ?? m.fonte_original).toUpperCase(),
    codigo: m.codigo_novo,
    descricao: m.descricao ?? null,
    motivo: 'Mapeamento adicionado via OrçaPav AI (inline)',
  }));

  const { error } = await admin
    .from('orcafascio_code_mappings')
    .upsert(linhas, { onConflict: 'fonte_original,codigo_original' });
  if (error) return { error: `Falha ao salvar mapeamentos: ${error.message}` };

  // Limpa composition_ids das PROPRIA (próxima cadastrar-edital re-tenta)
  await admin
    .from('composicoes_extraidas')
    .update({ orcafascio_composition_id: null })
    .eq('licitacao_id', licitacaoId)
    .eq('fonte', 'PROPRIA');

  revalidatePath(`/licitacoes/${licitacaoId}`);
  return {
    ok: true,
    mensagem: `${linhas.length} mapeamento(s) salvo(s). Clique "🚀 Cadastrar tudo" pra aplicar.`,
    mudancas: linhas.length,
  };
}

/**
 * AUTO-FIX 5: Força o total do orçamento BASE a bater com o valor do edital.
 *
 * Usa o "Ajustar valor" do Orçafascio (fator linear sobre todos os itens).
 * Pragmático pra quando o cadastramento ficou com composições em branco e o
 * total ficou abaixo do edital — em vez de re-cadastrar tudo, escala o que
 * existe pra fechar o valor.
 *
 * LIMITAÇÃO: distribuição interna fica imperfeita (composições em R$ 0,00
 * continuam em R$ 0,00; demais infladas pelo fator). Total = correto, itens
 * individualmente = aproximação. Pra estrutura fiel ao edital, faça
 * re-extração com sub-itens.
 */
export async function forcarTotalOrcamentoBase(
  licitacaoId: string,
  valorTotalAlvo: number,
  opts?: { dryRun?: boolean },
): Promise<AutoFixResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: { session } } = await supabase.auth.getSession();
  if (!user || !session) return { error: 'Não autenticado.' };

  if (!Number.isFinite(valorTotalAlvo) || valorTotalAlvo <= 0) {
    return { error: `valor_total_alvo inválido: ${valorTotalAlvo}` };
  }

  const admin = createAdminClient();
  // Acha credencial WEB do Orçafascio (a função usa session web).
  const { data: creds } = await admin
    .from('api_credentials')
    .select('id, metadata')
    .eq('provider', 'orcafascio')
    .eq('ativo', true);
  const cred = (creds ?? []).find(
    (c) => (c.metadata as { auth_type?: string } | null)?.auth_type === 'web',
  );
  if (!cred) return { error: 'Credencial Orçafascio (web) não encontrada.' };

  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/orcafascio-ajustar-total`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      licitacao_id: licitacaoId,
      credential_id: cred.id,
      valor_total_alvo: valorTotalAlvo,
      dry_run: !!opts?.dryRun,
    }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch {}
  if (!res.ok) {
    return {
      error: `Ajustar valor falhou (${res.status}): ${(body.error as string) ?? text.slice(0, 200)}`,
      screenshots: body.screenshots as Record<string, string> | undefined,
    };
  }
  if (opts?.dryRun) {
    return {
      ok: true,
      mensagem: 'Dry-run: form preenchido no Orçafascio mas NÃO submetido. Confira os screenshots.',
      screenshots: body.screenshots as Record<string, string> | undefined,
    };
  }
  revalidatePath(`/licitacoes/${licitacaoId}`);
  const aviso = body.aviso ? ` ⚠ ${body.aviso as string}` : '';
  return {
    ok: true,
    mensagem: `Total do orçamento ajustado pra R$ ${valorTotalAlvo.toFixed(2)}. ` +
      `Abre o Orçafascio pra conferir — distribuição interna foi escalada.${aviso}`,
    mudancas: 1,
    screenshots: body.screenshots as Record<string, string> | undefined,
  };
}

/**
 * AUTO-FIX 6: Despacha por tipo de diagnóstico.
 * Cada `tipo` mapeia pra uma função específica.
 *
 * Auto-fixes com payload (data-base, mapeamentos) NÃO usam esse dispatcher —
 * são chamados diretamente do componente UI pq precisam de input do user.
 */
export async function executarAutoFix(
  licitacaoId: string,
  tipo: string,
): Promise<AutoFixResult> {
  switch (tipo) {
    case 'codes_adaptados_nao_reclassificados':
      return reclassificarCodesAdaptados(licitacaoId);
    case 'aplicar_mapeamentos_pendentes':
      return limparMyBaseIdsPropria(licitacaoId);
    default:
      return { error: `Auto-fix "${tipo}" não implementado ainda. OrçaPav AI precisa de uma resolução manual.` };
  }
}
