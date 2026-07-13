import { createClient } from '@/lib/supabase/server';
import { formatBRL, formatDate, statusColor, statusLabel } from '@/lib/utils';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChecklistPreCadastro } from './checklist-pre-cadastro';
import { DiagnosticoCadastro } from './diagnostico-cadastro';
import { ExtractionPanel } from './extraction-panel';
import { FloatingClaudio } from './floating-claudio';
import { StatusActions } from './status-actions';
import { PollRefresher } from './poll-refresher';
import { ProposalCard } from './proposal-card';
import type { ExtractedItem } from './actions';

export const metadata = { title: 'Orçamento — OrçaPav AI' };
export const dynamic = 'force-dynamic'; // sempre fresh, refletir estados em transição
// Server actions desta página (importar JSON manual, cadastrar Orçafascio) fazem
// múltiplos round-trips ao Supabase. Sem isso, action pesada estoura os 10s
// default do Vercel Hobby e o spinner fica eterno no cliente.
export const maxDuration = 60;

export default async function LicitacaoDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [licResp, arqResp, extrResp] = await Promise.all([
    supabase.from('licitacoes').select('*').eq('id', id).maybeSingle(),
    supabase
      .from('licitacao_arquivos')
      .select('id, filename_original, size_bytes, mime_type, created_at, total_paginas, storage_path')
      .eq('licitacao_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('extracoes_ocr')
      .select('id, status, created_at, concluido_em, llm_model, prompt_versao, tokens_input, tokens_output, custo_usd, duracao_ms, json_extraido, json_corrigido, erro_detalhe, revisado_por, revisado_em')
      .eq('licitacao_id', id)
      .order('created_at', { ascending: false }),
  ]);

  if (licResp.error) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-12">
        <p className="text-sm text-red-700">Erro: {licResp.error.message}</p>
      </main>
    );
  }
  if (!licResp.data) notFound();

  const licitacao = licResp.data;
  const arquivos = arqResp.data ?? [];
  const extracoes = extrResp.data ?? [];
  const ultimaExtracao = extracoes[0];

  // Soma do orçamento extraído: sem BDI, com BDI, e o BDI em si.
  // Só conta linhas tipo 'servico' pra não duplicar com grupos agregadores.
  const { data: linhasFinanceiras } = await supabase
    .from('composicoes_extraidas')
    .select('preco_total, preco_unitario_sem_bdi, quantidade')
    .eq('licitacao_id', id)
    .eq('tipo_linha', 'servico');

  // Lista completa dos serviços pra o painel de diagnóstico de cadastramento
  const { data: servicosDetalhados } = await supabase
    .from('composicoes_extraidas')
    .select('item_codigo, descricao, fonte, codigo, unidade, quantidade, preco_unitario_com_bdi, preco_total, orcafascio_composition_id, ordem')
    .eq('licitacao_id', id)
    .eq('tipo_linha', 'servico')
    .order('ordem', { ascending: true });

  // Sub-itens dessa licitação que estão na tabela de codes pendentes
  // (registrados quando algum add-items falhou com 500 silencioso). Persiste
  // entre re-cadastros, ao contrário do cadastro_resumo.warnings que é
  // sobrescrito a cada retry.
  const { data: subItensLicitacao } = await supabase
    .from('composicao_propria_itens')
    .select('codigo, fonte, descricao')
    .in(
      'composicao_extraida_id',
      (servicosDetalhados ?? []).filter((s) => s.fonte === 'PROPRIA').map((s) => s.orcafascio_composition_id ?? '').filter(Boolean),
    );
  // Cross-reference com tabela de mapeamentos pendentes
  const codesSet = new Set<string>(
    (subItensLicitacao ?? []).map((s) => `${(s.fonte ?? '').toUpperCase()}/${s.codigo ?? ''}`),
  );
  const { data: mapeamentosTodos } = await supabase
    .from('orcafascio_code_mappings')
    .select('fonte_original, codigo_original, descricao, codigo_substituto')
    .is('codigo_substituto', null);
  const codesPendentes = (mapeamentosTodos ?? []).filter((m) =>
    codesSet.has(`${(m.fonte_original ?? '').toUpperCase()}/${m.codigo_original ?? ''}`),
  );

  let totalComBdi = 0;
  let totalSemBdi = 0;
  for (const l of linhasFinanceiras ?? []) {
    if (l.preco_total != null) totalComBdi += Number(l.preco_total);
    if (l.preco_unitario_sem_bdi != null && l.quantidade != null) {
      totalSemBdi += Number(l.preco_unitario_sem_bdi) * Number(l.quantidade);
    }
  }
  const totalBdi = totalComBdi - totalSemBdi;
  const temTotal = (linhasFinanceiras?.length ?? 0) > 0 && totalComBdi > 0;

  // Signed URLs dos PDFs pra extração manual (NotebookLM/Claude).
  // TTL de 1h é suficiente pra usuário baixar e arrastar pra ferramenta externa.
  const arquivosComUrl = await Promise.all(
    arquivos.map(async (a) => {
      const { data } = await supabase.storage
        .from('editais')
        .createSignedUrl(a.storage_path, 3600, {
          download: a.filename_original,
        });
      return {
        id: a.id,
        filename_original: a.filename_original,
        downloadUrl: data?.signedUrl ?? null,
      };
    }),
  );

  // Polling automático enquanto status indica trabalho em andamento
  const inFlightStatuses = new Set(['extraindo', 'criando_composicoes_edital', 'criando_orcamento_base']);
  const shouldPoll = inFlightStatuses.has(licitacao.status);

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white shadow-sm">
        {/* Faixa fina navy->orange — identidade Pavcon */}
        <div className="h-1 w-full bg-gradient-to-r from-pavcon-navy via-pavcon-navy-light to-pavcon-orange" />
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div>
            <Link href="/dashboard" className="inline-flex items-center gap-1 text-xs font-medium text-pavcon-navy hover:text-pavcon-navy-dark">
              ← Painel
            </Link>
            <h1 className="mt-1 text-xl font-bold tracking-tight text-pavcon-coal">
              {licitacao.titulo}
            </h1>
            {licitacao.numero_edital && (
              <p className="text-xs text-zinc-500">
                {licitacao.numero_edital} · {licitacao.orgao_licitante ?? '—'}
              </p>
            )}
          </div>
          <span
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${statusColor(licitacao.status)}`}
          >
            {statusLabel(licitacao.status)}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        {shouldPoll && <PollRefresher />}

        <section className="rounded-lg border border-zinc-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-zinc-900">Arquivos</h2>
          {arquivos.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">Nenhum arquivo anexado.</p>
          ) : (
            <ul className="mt-2 divide-y divide-zinc-100">
              {arquivos.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-2">
                  <div>
                    <p className="text-sm font-medium text-zinc-800">{a.filename_original}</p>
                    <p className="text-xs text-zinc-500">
                      {(a.size_bytes / 1024 / 1024).toFixed(2)} MB
                      {a.total_paginas ? ` · ${a.total_paginas} páginas` : ''}
                      {' · '}
                      {formatDate(a.created_at)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {temTotal && (
          <section className="rounded-lg border border-zinc-200 bg-white p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900">
                  Total do orçamento (extraído)
                </h2>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Soma dos itens (tipo serviço). Use pra validar contra a planilha do edital.
                </p>
              </div>
              <div className="text-right">
                <div className="text-2xl font-semibold text-zinc-900">
                  {formatBRL(totalComBdi)}
                </div>
                <div className="text-xs text-zinc-500">Total geral (com BDI)</div>
              </div>
            </div>
            <dl className="mt-4 grid grid-cols-3 gap-4 border-t border-zinc-100 pt-4 text-sm">
              <div>
                <dt className="text-xs text-zinc-500">Total sem BDI</dt>
                <dd className="mt-0.5 font-medium text-zinc-900">
                  {formatBRL(totalSemBdi)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">
                  BDI{' '}
                  {totalSemBdi > 0 && (
                    <span className="text-zinc-400">
                      ({((totalBdi / totalSemBdi) * 100).toFixed(2)}%)
                    </span>
                  )}
                </dt>
                <dd className="mt-0.5 font-medium text-zinc-900">
                  {formatBRL(totalBdi)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Linhas (servicos)</dt>
                <dd className="mt-0.5 font-medium text-zinc-900">
                  {linhasFinanceiras?.length ?? 0}
                </dd>
              </div>
            </dl>
            {licitacao.valor_total_edital != null &&
              Math.abs(totalComBdi - Number(licitacao.valor_total_edital)) > 0.01 && (
                <p className="mt-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  ⚠ Total extraído ({formatBRL(totalComBdi)}) difere do valor de referência do
                  edital ({formatBRL(Number(licitacao.valor_total_edital))}) em{' '}
                  {formatBRL(totalComBdi - Number(licitacao.valor_total_edital))}.
                </p>
              )}
          </section>
        )}

        <ProposalCard
          licitacaoId={licitacao.id}
          status={licitacao.status}
          /*
           * BDI: prioriza o campo bdi_referencia_edital (preenchido manualmente).
           * Senão, calcula a partir do total_com_bdi / total_sem_bdi extraído
           * (mesmo cálculo da seção "Total do orçamento" acima). Antes caía
           * num fallback hardcoded 22%, que dava divergência visível pro
           * orçamentista (ex.: edital com BDI real 28,35% mostrava 22% no
           * painel de Proposta Readequada — confusão sobre qual BDI vale).
           */
          bdiEdital={Number(
            licitacao.bdi_referencia_edital ??
              (totalSemBdi > 0 ? (totalBdi / totalSemBdi) * 100 : 22),
          )}
          totalEdital={totalComBdi}
          orcamentoBaseId={licitacao.orcafascio_orcamento_base_id ?? null}
          proposta={{
            desconto_percentual: licitacao.desconto_percentual,
            valor_proposta_pavcon: licitacao.valor_proposta_pavcon,
            orcafascio_proposta_budget_id: licitacao.orcafascio_proposta_budget_id,
          }}
        />

        <StatusActions licitacaoId={licitacao.id} status={licitacao.status} />

        <ExtractionPanel
          licitacaoId={licitacao.id}
          status={licitacao.status}
          arquivoId={arquivos[0]?.id ?? null}
          arquivos={arquivosComUrl}
          ultimaExtracao={ultimaExtracao
            ? {
                id: ultimaExtracao.id,
                status: ultimaExtracao.status,
                created_at: ultimaExtracao.created_at,
                concluido_em: ultimaExtracao.concluido_em,
                llm_model: ultimaExtracao.llm_model,
                prompt_versao: ultimaExtracao.prompt_versao,
                tokens_input: ultimaExtracao.tokens_input,
                tokens_output: ultimaExtracao.tokens_output,
                custo_usd: ultimaExtracao.custo_usd,
                duracao_ms: ultimaExtracao.duracao_ms,
                erro_detalhe: ultimaExtracao.erro_detalhe,
                json:
                  (ultimaExtracao.json_corrigido as
                    | { cabecalho: Record<string, unknown>; itens: ExtractedItem[] }
                    | null) ??
                  (ultimaExtracao.json_extraido as
                    | { cabecalho: Record<string, unknown>; itens: ExtractedItem[] }
                    | null),
                ja_revisada: !!ultimaExtracao.json_corrigido,
              }
            : null}
        />

        {/* Checklist pré-cadastro: mostra dados que precisam validação manual
            (data-base, regime, BDI, leis sociais, gaps na extração).
            Reduz "bot extraiu errado" silencioso. */}
        <ChecklistPreCadastro
          servicos={(servicosDetalhados ?? []).map((s) => ({
            item_codigo: s.item_codigo,
            descricao: s.descricao,
            fonte: s.fonte,
            preco_total: s.preco_total != null ? Number(s.preco_total) : null,
          }))}
          totalExtraido={totalComBdi}
          cabecalho={
            (ultimaExtracao?.json_corrigido?.cabecalho ??
              ultimaExtracao?.json_extraido?.cabecalho ??
              null) as Parameters<typeof ChecklistPreCadastro>[0]['cabecalho']
          }
          jaCadastrou={!!licitacao.cadastro_resumo}
        />

        {/* Painel de diagnóstico do cadastramento — só aparece quando já cadastrou
            (cadastro_resumo tem budget_url). Compara totais e mostra warnings
            específicos pro orçamentista revisar diretamente no Orçafascio. */}
        {codesPendentes.length > 0 && (
          <section className="rounded-lg border border-amber-300 bg-amber-50 p-6 text-amber-900">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold">
                  ⚠ {codesPendentes.length} código(s) descontinuado(s) nesta licitação
                </h2>
                <p className="mt-1 text-xs">
                  Esses códigos (SINAPI/ORSE/etc) foram rejeitados pelo Orçafascio (provavelmente legacy
                  que não existe mais na base atual). Os insumos correspondentes ficaram <strong>com preço R$ 0,00</strong>
                  no orçamento. Mapeie cada um pro código atual equivalente — próximos editais aplicam a substituição
                  automaticamente.
                </p>
              </div>
              <Link
                href="/dashboard/code-mappings"
                className="rounded-md bg-amber-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-800"
              >
                Mapear códigos →
              </Link>
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium">Ver lista ({codesPendentes.length})</summary>
              <ul className="mt-2 space-y-1 text-[11px]">
                {codesPendentes.slice(0, 20).map((c, i) => (
                  <li key={i} className="border-l-2 border-amber-300 pl-2">
                    <span className="font-mono">{c.fonte_original}/{c.codigo_original}</span> —{' '}
                    {c.descricao ?? '(sem descrição)'}
                  </li>
                ))}
                {codesPendentes.length > 20 && (
                  <li className="text-amber-700">... e mais {codesPendentes.length - 20}</li>
                )}
              </ul>
            </details>
          </section>
        )}

        <DiagnosticoCadastro
          servicos={(servicosDetalhados ?? []).map((s) => ({
            item_codigo: s.item_codigo,
            descricao: s.descricao,
            fonte: s.fonte,
            codigo: s.codigo,
            unidade: s.unidade,
            quantidade: s.quantidade != null ? Number(s.quantidade) : null,
            preco_unitario_com_bdi: s.preco_unitario_com_bdi != null ? Number(s.preco_unitario_com_bdi) : null,
            preco_total: s.preco_total != null ? Number(s.preco_total) : null,
            orcafascio_composition_id: s.orcafascio_composition_id,
          }))}
          totalExtraido={totalComBdi}
          resumo={(licitacao.cadastro_resumo ?? null) as Parameters<typeof DiagnosticoCadastro>[0]['resumo']}
        />

        {licitacao.status === 'erro' && ultimaExtracao?.erro_detalhe && (
          <section className="rounded-lg border border-red-200 bg-red-50 p-6">
            <h2 className="text-sm font-semibold text-red-900">Erro na extração</h2>
            <p className="mt-2 text-sm text-red-800">{ultimaExtracao.erro_detalhe}</p>
            <p className="mt-2 text-xs text-red-700">
              Use o botão <strong>&ldquo;Voltar pra rascunho&rdquo;</strong> e tente novamente.
            </p>
          </section>
        )}

        {/* Extração terminou com status != 'erro' (chegou a 'sucesso') mas ainda
            assim deixou avisos de recuperação (JSON truncado por limite de
            tokens, item_codigo duplicado, campo obrigatório ausente, etc).
            Sem isso o orçamentista via uma planilha incompleta sem nenhum
            sinal — o erro_detalhe existia no banco mas nunca era exibido. */}
        {licitacao.status !== 'erro' && ultimaExtracao?.erro_detalhe && (
          <section className="rounded-lg border border-amber-300 bg-amber-50 p-6">
            <h2 className="text-sm font-semibold text-amber-900">⚠ Avisos da extração</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm text-amber-800">{ultimaExtracao.erro_detalhe}</p>
            <p className="mt-2 text-xs text-amber-700">
              A extração foi concluída, mas revise os itens abaixo com atenção antes de cadastrar no Orçafascio.
            </p>
          </section>
        )}

        <section className="rounded-lg border border-zinc-200 bg-white p-6 text-xs text-zinc-500">
          <h2 className="mb-2 text-sm font-semibold text-zinc-900">Custos da extração</h2>
          {ultimaExtracao?.custo_usd != null ? (
            <p>
              <strong className="text-zinc-700">{formatBRL((ultimaExtracao.custo_usd ?? 0) * 5.5)}</strong>
              {' '}aprox. (USD {ultimaExtracao.custo_usd?.toFixed(4)} ·
              {' '}{ultimaExtracao.tokens_input ?? '?'} tokens in /
              {' '}{ultimaExtracao.tokens_output ?? '?'} out · {ultimaExtracao.llm_model})
            </p>
          ) : (
            <p>Nenhuma extração concluída ainda.</p>
          )}
        </section>
      </main>

      {/* Widget flutuante de suporte — fica fixo no canto direito em todas
          as telas da licitação. Analisa automaticamente ao abrir + permite
          auto-fix em 1-click pros padrões conhecidos. */}
      <FloatingClaudio licitacaoId={licitacao.id} />
    </div>
  );
}

