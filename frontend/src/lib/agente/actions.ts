'use server';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { type ContextoAnalise, type Diagnostico, rodarAnalise } from './detectores';

interface DiagnosticoPersistido extends Diagnostico {
  id: number;
  status: 'pendente' | 'aplicado' | 'resolvido_manualmente' | 'ignorado';
  detectado_em: string;
}

/**
 * Roda análise completa na licitação: coleta contexto, executa todos os
 * detectores, e persiste os diagnósticos novos. Diagnósticos antigos com
 * o mesmo `tipo` em status `pendente` são mantidos (não duplica).
 */
export async function analisarLicitacao(
  licitacaoId: string,
): Promise<{ ok?: boolean; error?: string; diagnosticos?: DiagnosticoPersistido[] }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado.' };

  const admin = createAdminClient();

  // 1) Coleta contexto
  const { data: licitacao } = await admin
    .from('licitacoes')
    .select('id, titulo, status, orcafascio_orcamento_base_id, cadastro_resumo')
    .eq('id', licitacaoId)
    .maybeSingle();
  if (!licitacao) return { error: 'Licitação não encontrada.' };

  const { data: extracao } = await admin
    .from('extracoes_ocr')
    .select('json_corrigido, json_extraido, conferencia_resultado')
    .eq('licitacao_id', licitacaoId)
    .in('status', ['sucesso', 'revisada_humano'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const cabecalho = ((extracao?.json_corrigido ?? extracao?.json_extraido) as
    { cabecalho?: ContextoAnalise['cabecalho'] } | null)?.cabecalho ?? null;
  const conferenciaResultado =
    (extracao?.conferencia_resultado as ContextoAnalise['conferenciaResultado']) ?? null;

  const { data: servicos } = await admin
    .from('composicoes_extraidas')
    .select('item_codigo, descricao, fonte, codigo, orcafascio_composition_id, preco_total')
    .eq('licitacao_id', licitacaoId)
    .eq('tipo_linha', 'servico');

  // Total extraído (com BDI) = soma dos preco_total dos serviços. Esse é
  // o "valor do edital" pra fins de comparação com o que está cadastrado
  // no Orçafascio. O detector orcamento_abaixo_do_edital usa pra flagar
  // diferenças relevantes (>15% e >R$5k).
  const totalExtraidoServicos = (servicos ?? []).reduce(
    (acc, s) => acc + Number((s as { preco_total?: number | null }).preco_total ?? 0),
    0,
  );

  // Total atual do Orçafascio: pega do cadastro_resumo (escrito por
  // orcafascio-cadastrar-orcamento). Se não tem resumo, é null e o
  // detector não dispara.
  const resumo = (licitacao as { cadastro_resumo?: Record<string, unknown> | null }).cadastro_resumo;
  const totalOrcamentoOrcafascio = resumo && typeof resumo === 'object' &&
    typeof (resumo as { total_orcamento?: unknown }).total_orcamento === 'number'
    ? (resumo as { total_orcamento: number }).total_orcamento
    : null;

  // Codes pendentes da tabela orcafascio_code_mappings que tocam essa
  // licitação (filtra por sub-itens das composições próprias)
  const propriasIds = (servicos ?? [])
    .filter((s) => s.fonte === 'PROPRIA' && s.orcafascio_composition_id)
    .map((s) => s.orcafascio_composition_id ?? '')
    .filter(Boolean);
  let codesPendentes: ContextoAnalise['codesPendentes'] = [];
  if (propriasIds.length > 0) {
    const { data: composicoes } = await admin
      .from('composicoes_extraidas')
      .select('id')
      .eq('licitacao_id', licitacaoId)
      .eq('fonte', 'PROPRIA');
    const compIds = (composicoes ?? []).map((c) => c.id);
    const { data: subitens } = await admin
      .from('composicao_propria_itens')
      .select('codigo, fonte')
      .in('composicao_extraida_id', compIds);
    const setCodes = new Set(
      (subitens ?? []).map((s) => `${(s.fonte ?? '').toUpperCase()}/${s.codigo ?? ''}`),
    );
    const { data: mappings } = await admin
      .from('orcafascio_code_mappings')
      .select('fonte_original, codigo_original, descricao')
      .is('codigo_substituto', null);
    codesPendentes = (mappings ?? []).filter((m) =>
      setCodes.has(`${(m.fonte_original ?? '').toUpperCase()}/${m.codigo_original ?? ''}`),
    );
  }

  // Composições vazias (PROPRIA sem sub-itens)
  let composicoesVazias: ContextoAnalise['composicoesVazias'] = [];
  if ((servicos ?? []).some((s) => s.fonte === 'PROPRIA')) {
    const { data: composicoes } = await admin
      .from('composicoes_extraidas')
      .select('id, item_codigo, codigo, descricao')
      .eq('licitacao_id', licitacaoId)
      .eq('fonte', 'PROPRIA');
    const compIds = (composicoes ?? []).map((c) => c.id);
    if (compIds.length > 0) {
      const { data: subitens } = await admin
        .from('composicao_propria_itens')
        .select('composicao_extraida_id')
        .in('composicao_extraida_id', compIds);
      const comSubitens = new Set((subitens ?? []).map((s) => s.composicao_extraida_id));
      composicoesVazias = (composicoes ?? [])
        .filter((c) => !comSubitens.has(c.id))
        .map((c) => ({
          item_codigo: c.item_codigo,
          codigo: c.codigo,
          descricao: c.descricao,
        }));
    }
  }

  const ctx: ContextoAnalise = {
    licitacao: licitacao as ContextoAnalise['licitacao'],
    cabecalho,
    servicos: (servicos ?? []) as ContextoAnalise['servicos'],
    codesPendentes,
    composicoesVazias,
    totalExtraidoServicos,
    totalOrcamentoOrcafascio,
    conferenciaResultado,
  };

  // 2) Roda detectores
  const novos = rodarAnalise(ctx);

  // 3) Pega diagnósticos existentes pendentes pra essa licitação
  const { data: existentes } = await admin
    .from('agente_diagnosticos')
    .select('id, tipo, status')
    .eq('licitacao_id', licitacaoId)
    .eq('status', 'pendente');
  const tiposExistentes = new Set((existentes ?? []).map((e) => e.tipo));
  const tiposNovos = new Set(novos.map((n) => n.tipo));

  // 4) Insere os diagnósticos novos (que não existem como pendente)
  const aInserir = novos.filter((n) => !tiposExistentes.has(n.tipo));
  if (aInserir.length > 0) {
    await admin.from('agente_diagnosticos').insert(
      aInserir.map((d) => ({
        licitacao_id: licitacaoId,
        tipo: d.tipo,
        severidade: d.severidade,
        titulo: d.titulo,
        mensagem: d.mensagem ?? null,
        sugestao: d.sugestao ?? null,
        acao_acionavel: d.acao_acionavel ?? null,
        contexto: d.contexto ?? null,
      })),
    );
  }

  // 5) Marca como resolvidos os diagnósticos pendentes que sumiram
  const aResolver = (existentes ?? [])
    .filter((e) => !tiposNovos.has(e.tipo))
    .map((e) => e.id);
  if (aResolver.length > 0) {
    await admin
      .from('agente_diagnosticos')
      .update({
        status: 'resolvido_manualmente',
        resolvido_em: new Date().toISOString(),
        resolvido_por: user.id,
      })
      .in('id', aResolver);
  }

  // 6) Retorna todos os pendentes atuais
  const { data: pendentes } = await admin
    .from('agente_diagnosticos')
    .select('*')
    .eq('licitacao_id', licitacaoId)
    .eq('status', 'pendente')
    .order('severidade', { ascending: true })
    .order('id', { ascending: false });

  revalidatePath(`/licitacoes/${licitacaoId}`);
  return {
    ok: true,
    diagnosticos: (pendentes ?? []) as DiagnosticoPersistido[],
  };
}

/**
 * Marca um diagnóstico como resolvido manualmente pelo orçamentista.
 * Pode aprender o padrão pra editais futuros.
 */
export async function marcarResolvido(
  diagnosticoId: number,
  comoAprendizado = false,
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado.' };

  const admin = createAdminClient();
  const { data: diag } = await admin
    .from('agente_diagnosticos')
    .select('tipo, contexto')
    .eq('id', diagnosticoId)
    .maybeSingle();
  if (!diag) return { error: 'Diagnóstico não encontrado.' };

  await admin
    .from('agente_diagnosticos')
    .update({
      status: 'resolvido_manualmente',
      resolvido_em: new Date().toISOString(),
      resolvido_por: user.id,
    })
    .eq('id', diagnosticoId);

  if (comoAprendizado && diag.contexto) {
    // Insere padrão aprendido (ignora se já existe)
    await admin.from('agente_padroes_aprendidos').upsert({
      tipo_diagnostico: diag.tipo,
      padrao_match: diag.contexto,
      solucao_aplicar: { acao: 'manual', descricao: 'Resolvido pelo orçamentista' },
      criado_por: user.id,
    }, { onConflict: 'tipo_diagnostico,padrao_match', ignoreDuplicates: true });
  }

  return { ok: true };
}

/** Marca diagnóstico como ignorado (não vai mais aparecer pra essa licitação) */
export async function ignorarDiagnostico(
  diagnosticoId: number,
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado.' };

  const admin = createAdminClient();
  await admin
    .from('agente_diagnosticos')
    .update({
      status: 'ignorado',
      resolvido_em: new Date().toISOString(),
      resolvido_por: user.id,
    })
    .eq('id', diagnosticoId);

  return { ok: true };
}
