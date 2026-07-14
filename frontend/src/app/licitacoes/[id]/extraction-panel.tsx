'use client';

import { useState, useTransition } from 'react';
import {
  approveExtraction,
  cadastrarNoOrcafascio,
  cadastrarOrcamentoCompleto,
  resetOrcafascio,
  resetToDraft,
  saveExtractionEdits,
  classificarPaginasPdf,
  cortarPaginasPdf,
  otimizarPdfs,
  startExtraction,
  type ExtractedItem,
} from './actions';
import { dispararAgenteOrcapav } from '@/lib/agente/chat';
import { ExtractionEditor } from './extraction-editor';
import { ImportJsonModal } from './import-json-modal';
import { EXTRACTION_PROMPT, NOTEBOOKLM_URL, claudeNewChatUrl } from './prompt';

interface ArquivoLink {
  id: string;
  filename_original: string;
  downloadUrl: string | null;
}

interface ExtractionSummary {
  id: string;
  status: string;
  created_at: string;
  concluido_em: string | null;
  llm_model: string;
  prompt_versao: string;
  tokens_input: number | null;
  tokens_output: number | null;
  custo_usd: number | null;
  duracao_ms: number | null;
  erro_detalhe: string | null;
  json: { cabecalho: Record<string, unknown>; itens: ExtractedItem[] } | null;
  ja_revisada: boolean;
}

interface Props {
  licitacaoId: string;
  arquivoId: string | null;
  arquivos: ArquivoLink[];
  status: string;
  ultimaExtracao: ExtractionSummary | null;
}

export function ExtractionPanel({
  licitacaoId,
  arquivoId,
  arquivos,
  status,
  ultimaExtracao,
}: Props) {
  const [isPending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);
  const [importModal, setImportModal] = useState<null | 'notebooklm' | 'claude_code'>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const [importResult, setImportResult] = useState<{ composicoes: number; subItens: number; jsonReparado?: boolean } | null>(null);
  const [cadastroResult, setCadastroResult] = useState<{
    grupo_descricao?: string;
    composicoes_criadas?: number;
    composicoes_puladas?: number;
    itens_adicionados?: number;
    warnings?: string[];
  } | null>(null);
  const [orcamentoResult, setOrcamentoResult] = useState<{
    budget_id?: string;
    budget_url?: string;
    etapas_criadas?: number;
    composicoes_criadas?: number;
    total_itens_batch?: number;
    bdi?: number;
    leis_sociais_horista?: number;
    bancos_configurados?: string[];
    warnings?: string[];
    mybase?: {
      composicoes_criadas: number;
      itens_adicionados: number;
      warnings?: string[];
    };
  } | null>(null);

  const canStart = (status === 'rascunho' || status === 'aguardando_extracao') &&
    !!arquivoId;
  const isExtracting = status === 'extraindo';
  const isReviewable = status === 'aguardando_revisao_humana' && ultimaExtracao?.json;
  const canCadastrar = status === 'criando_composicoes_edital';
  const isDone = ['fase1_concluida', 'criando_orcamento_base', 'finalizado'].includes(status);
  const isError = status === 'erro';

  function handleStart(provider: 'gemini' | 'anthropic' = 'gemini') {
    if (!arquivoId) return;
    setActionError(null);
    startTransition(async () => {
      const r = await startExtraction(licitacaoId, arquivoId, provider);
      if (r?.error) setActionError(`${r.error}${r.details ? ': ' + JSON.stringify(r.details).slice(0, 200) : ''}`);
    });
  }

  // Otimização de PDF antes da extração — reduz tamanho 15-30% via
  // recompressão lossless (pdf-lib + object streams + strip metadata).
  // Acelera o upload pro Gemini e economiza tokens.
  const [otimResult, setOtimResult] = useState<{
    total_antes_bytes: number;
    total_depois_bytes: number;
    total_reducao_pct: number;
    arquivos: Array<{ filename: string; reducao_pct: number; skipped?: boolean; motivo_skip?: string }>;
  } | null>(null);
  function handleOtimizar() {
    setActionError(null);
    setOtimResult(null);
    startTransition(async () => {
      const r = await otimizarPdfs(licitacaoId);
      if (r?.error) {
        setActionError(r.error);
      } else if (r.otimizados) {
        setOtimResult({
          total_antes_bytes: r.total_antes_bytes ?? 0,
          total_depois_bytes: r.total_depois_bytes ?? 0,
          total_reducao_pct: r.total_reducao_pct ?? 0,
          arquivos: r.otimizados.map((o) => ({
            filename: o.filename,
            reducao_pct: o.reducao_pct,
            skipped: o.skipped,
            motivo_skip: o.motivo_skip,
          })),
        });
      }
    });
  }

  // ===== Page filtering — Nível 2 ============================================
  // Usa Gemini Flash pra classificar páginas por relevância. Mostra preview,
  // user confirma, aplica corte. Pode reduzir 30-60% o tempo de extração ao
  // pular declarações, certidões, capas e termos genéricos.
  const [classifResult, setClassifResult] = useState<{
    arquivos: Array<{
      arquivo_id: string;
      filename: string;
      total_paginas: number;
      paginas_relevantes: number[];
      paginas_descartaveis: number[];
      reducao_estimada_pct: number;
      paginas?: Array<{ num: number; classe: string; confianca: number; justificativa: string }>;
      erro?: string;
    }>;
    total_paginas: number;
    total_paginas_descartaveis: number;
    total_reducao_estimada_pct: number;
  } | null>(null);
  const [cortando, setCortando] = useState(false);
  const [corteResult, setCorteResult] = useState<{
    total_reducao_pct: number;
    resultados: Array<{
      filename?: string;
      paginas_antes?: number;
      paginas_depois?: number;
      reducao_pct?: number;
      erro?: string;
    }>;
  } | null>(null);

  function handleClassificar() {
    setActionError(null);
    setClassifResult(null);
    setCorteResult(null);
    startTransition(async () => {
      const r = await classificarPaginasPdf(licitacaoId);
      if (r?.error) {
        setActionError(r.error);
      } else if (r.arquivos) {
        setClassifResult({
          arquivos: r.arquivos,
          total_paginas: r.total_paginas ?? 0,
          total_paginas_descartaveis: r.total_paginas_descartaveis ?? 0,
          total_reducao_estimada_pct: r.total_reducao_estimada_pct ?? 0,
        });
      }
    });
  }

  function handleAplicarCorte() {
    if (!classifResult) return;
    if (!confirm(
      `Cortar ${classifResult.total_paginas_descartaveis} página(s) classificadas como irrelevantes ` +
      `(${classifResult.total_reducao_estimada_pct}% do total)? ` +
      'Os PDFs originais serão SUBSTITUÍDOS no Storage — operação destrutiva sem rollback automático. Continuar?'
    )) return;
    setCortando(true);
    setActionError(null);
    startTransition(async () => {
      const cortes = classifResult.arquivos
        .filter((a) => !a.erro && a.paginas_relevantes.length > 0)
        .map((a) => ({ arquivo_id: a.arquivo_id, paginas_manter: a.paginas_relevantes }));
      const r = await cortarPaginasPdf(licitacaoId, cortes);
      setCortando(false);
      if (r?.error) {
        setActionError(r.error);
      } else if (r.resultados) {
        setCorteResult({
          total_reducao_pct: r.total_reducao_pct ?? 0,
          resultados: r.resultados,
        });
        setClassifResult(null); // limpa preview, já aplicou
      }
    });
  }

  function handleReset() {
    setActionError(null);
    startTransition(async () => {
      const r = await resetToDraft(licitacaoId);
      if (r?.error) setActionError(r.error);
    });
  }

  function handleResetOrcafascio() {
    if (
      !confirm(
        'Resetar Orçafascio?\n\nIsso:\n• Limpa os IDs MyBase salvos no nosso banco\n• Invalida a sessão web (próximo cadastro faz login fresco)\n• Volta status pra "criando composições" (botão azul reaparece)\n\nNão deleta nada do Orçafascio web — você precisa apagar manualmente as composições e o orçamento parcial em https://app.orcafascio.com.\n\nContinuar?',
      )
    ) {
      return;
    }
    setActionError(null);
    setCadastroResult(null);
    setOrcamentoResult(null);
    startTransition(async () => {
      const r = await resetOrcafascio(licitacaoId);
      if (r?.error) setActionError(r.error);
    });
  }

  function openManualExtraction(source: 'notebooklm' | 'claude_code') {
    // IMPORTANTE: window.open precisa rodar síncrono dentro do click handler
    // pra navegador não tratar como popup bloqueado.
    const url = source === 'notebooklm' ? NOTEBOOKLM_URL : claudeNewChatUrl(EXTRACTION_PROMPT);
    window.open(url, '_blank', 'noopener,noreferrer');
    // Copiar pro clipboard — promise mas não bloqueia o fluxo
    navigator.clipboard
      .writeText(EXTRACTION_PROMPT)
      .then(() => setPromptCopied(true))
      .catch(() => setPromptCopied(false));
    setImportModal(source);
  }

  // Detecta se as warnings do cadastro contêm o padrão que o IA sabe resolver
  // (códigos descontinuados, codes adaptados mal classificados, addBases 500).
  function temWarningsCorrigiveisIA(warnings: string[] | undefined): boolean {
    if (!warnings || warnings.length === 0) return false;
    return warnings.some((w) =>
      /provável código descontinuado|adicionar manual|adaptado|-ADAP|COMPOSIÇÃO|addBases falhou/i.test(w)
    );
  }

  // Estado pra mostrar overlay enquanto IA está rodando auto-correção
  const [iaCorrigindo, setIaCorrigindo] = useState<{
    iteracao: number;
    mensagem?: string;
    acoes_aplicadas?: number;
  } | null>(null);

  // Auto-correção IA com retry: dispara autoCorrigirComIA, depois re-cadastra,
  // checa se warnings diminuíram, repete até max 3 iterações ou estabilizar.
  async function tentarAutoCorrigirIA(
    licId: string,
    warningsAtuais: string[],
    iteracao: number,
    onResult: (warnings: string[]) => void,
  ): Promise<void> {
    if (iteracao > 3) {
      setIaCorrigindo(null);
      return;
    }
    setIaCorrigindo({
      iteracao,
      mensagem: `Iteração ${iteracao}/3: IA analisando ${warningsAtuais.length} warning(s)…`,
    });
    const r = await dispararAgenteOrcapav(licId);
    if (r.error) {
      // IA falhou — não bloqueia o usuário, ele vê os warnings normalmente
      setIaCorrigindo(null);
      return;
    }
    const acoesAplicadas = r.acoes_executadas?.length ?? 0;
    setIaCorrigindo({
      iteracao,
      mensagem: `IA aplicou ${acoesAplicadas} ação(ões). Recadastrando…`,
      acoes_aplicadas: acoesAplicadas,
    });
    if (acoesAplicadas === 0) {
      // IA não conseguiu aplicar nada — para o loop
      setIaCorrigindo(null);
      return;
    }
    // Re-roda cadastramento pra aplicar mappings/correções
    const recad = await cadastrarNoOrcafascio(licId);
    const novasWarnings = recad?.warnings ?? [];
    onResult(novasWarnings);
    // Se ainda tem warnings corrigíveis E o número de warnings DIMINUIU
    // (progresso real), tenta de novo. Senão para.
    if (
      temWarningsCorrigiveisIA(novasWarnings) &&
      novasWarnings.length < warningsAtuais.length
    ) {
      await tentarAutoCorrigirIA(licId, novasWarnings, iteracao + 1, onResult);
    } else {
      setIaCorrigindo(null);
    }
  }

  function handleCadastrar() {
    setActionError(null);
    setCadastroResult(null);
    startTransition(async () => {
      const r = await cadastrarNoOrcafascio(licitacaoId);
      if (r?.error) {
        setActionError(r.error);
        return;
      }
      const warnings = r.warnings ?? [];
      setCadastroResult({
        grupo_descricao: r.grupo_descricao,
        composicoes_criadas: r.composicoes_criadas,
        composicoes_puladas: r.composicoes_puladas,
        itens_adicionados: r.itens_adicionados,
        warnings,
      });
      // AUTO-TRIGGER do IA quando tiver warnings corrigíveis
      if (temWarningsCorrigiveisIA(warnings)) {
        await tentarAutoCorrigirIA(licitacaoId, warnings, 1, (novasWarnings) => {
          setCadastroResult((prev) => prev ? { ...prev, warnings: novasWarnings } : prev);
        });
      }
    });
  }

  function handleCadastrarOrcamentoCompleto() {
    setActionError(null);
    setOrcamentoResult(null);
    startTransition(async () => {
      const r = await cadastrarOrcamentoCompleto(licitacaoId);
      if (r?.error) {
        setActionError(r.error);
        return;
      }
      const warningsPasso1 = r.mybase?.warnings ?? [];
      const warningsPasso2 = r.warnings ?? [];
      const todasWarnings = [...warningsPasso1, ...warningsPasso2];
      setOrcamentoResult({
        budget_id: r.budget_id,
        budget_url: r.budget_url,
        etapas_criadas: r.etapas_criadas,
        composicoes_criadas: r.composicoes_criadas,
        total_itens_batch: r.total_itens_batch,
        bdi: r.bdi,
        leis_sociais_horista: r.leis_sociais_horista,
        bancos_configurados: r.bancos_configurados,
        warnings: warningsPasso2,
        mybase: r.mybase,
      });
      // AUTO-TRIGGER do IA quando tiver warnings corrigíveis no Passo 1
      if (temWarningsCorrigiveisIA(todasWarnings)) {
        await tentarAutoCorrigirIA(licitacaoId, todasWarnings, 1, (novasWarnings) => {
          setOrcamentoResult((prev) => prev ? {
            ...prev,
            mybase: prev.mybase ? { ...prev.mybase, warnings: novasWarnings } : prev.mybase,
          } : prev);
        });
      }
    });
  }

  return (
    <section className="space-y-4 rounded-lg border border-zinc-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-900">Extração do orçamento</h2>
        {ultimaExtracao && (
          <span className="text-xs text-zinc-500">
            {ultimaExtracao.llm_model} · {ultimaExtracao.prompt_versao}
          </span>
        )}
      </div>

      {actionError && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">{actionError}</div>
      )}

      {canStart && (
        <div className="space-y-3">
          {/* Card de otimização do PDF (passo opcional antes da extração) */}
          <div className="rounded-lg border border-pavcon-orange/30 bg-pavcon-orange-50/50 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <p className="text-sm font-semibold text-pavcon-coal">
                  🗜 Otimizar PDFs antes da extração (opcional)
                </p>
                <p className="mt-1 text-xs text-zinc-700">
                  Recompressão lossless via pdf-lib — reduz 15-30% do tamanho típico, acelera o upload pro Gemini
                  e economiza tokens de imagem. Não altera o conteúdo visual.
                </p>
              </div>
              <button
                onClick={handleOtimizar}
                disabled={isPending}
                className="shrink-0 rounded-md bg-pavcon-orange px-4 py-2 text-xs font-semibold text-white hover:bg-pavcon-orange-dark disabled:opacity-50"
              >
                {isPending ? 'Otimizando…' : 'Otimizar agora'}
              </button>
            </div>
            {otimResult && (
              <div className="mt-3 rounded-md border border-emerald-200 bg-white p-3 text-xs">
                {otimResult.total_reducao_pct > 0 ? (
                  <p className="font-semibold text-emerald-800">
                    ✓ Reduzido em {otimResult.total_reducao_pct}% ({(otimResult.total_antes_bytes / 1024 / 1024).toFixed(2)} MB → {(otimResult.total_depois_bytes / 1024 / 1024).toFixed(2)} MB)
                  </p>
                ) : (
                  <p className="font-semibold text-zinc-700">
                    ℹ PDFs já estão bem otimizados — nenhuma redução aplicada.
                  </p>
                )}
                <ul className="mt-1.5 space-y-0.5 text-zinc-600">
                  {otimResult.arquivos.map((a, i) => (
                    <li key={i} className="truncate">
                      • {a.filename}: {a.skipped
                        ? <span className="text-zinc-500">{a.motivo_skip}</span>
                        : <span className="text-emerald-700">−{a.reducao_pct}%</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Card de filtragem inteligente de páginas — Nível 2 */}
          <div className="rounded-lg border border-pavcon-navy/30 bg-pavcon-navy-50 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <p className="text-sm font-semibold text-pavcon-coal">
                  🔍 Filtrar páginas irrelevantes (recomendado)
                </p>
                <p className="mt-1 text-xs text-zinc-700">
                  Gemini Flash analisa o PDF e identifica páginas como capa, índice, declarações, certidões e termos genéricos.
                  Pulando essas, a extração principal fica 30-60% mais rápida e barata.
                </p>
              </div>
              <button
                onClick={handleClassificar}
                disabled={isPending || cortando}
                className="shrink-0 rounded-md bg-pavcon-navy px-4 py-2 text-xs font-semibold text-white hover:bg-pavcon-navy-dark disabled:opacity-50"
              >
                {isPending && !cortando ? 'Analisando…' : 'Analisar páginas'}
              </button>
            </div>

            {/* Preview pós-classificação */}
            {classifResult && (
              <div className="mt-3 space-y-2 rounded-md border border-emerald-200 bg-white p-3 text-xs">
                <p className="font-semibold text-emerald-800">
                  ✓ Identificadas {classifResult.total_paginas_descartaveis} páginas irrelevantes de {classifResult.total_paginas} ({classifResult.total_reducao_estimada_pct}% de redução)
                </p>
                {classifResult.arquivos.map((a) => (
                  <div key={a.arquivo_id} className="rounded border border-zinc-200 p-2">
                    <p className="truncate font-medium text-zinc-900">{a.filename}</p>
                    {a.erro ? (
                      <p className="mt-0.5 text-red-700">⚠ {a.erro}</p>
                    ) : (
                      <>
                        <p className="text-zinc-600">
                          Total: <strong>{a.total_paginas}</strong> ·
                          {' '}Manter: <strong className="text-emerald-700">{a.paginas_relevantes.length}</strong> ·
                          {' '}Cortar: <strong className="text-amber-700">{a.paginas_descartaveis.length}</strong>
                          {' '}({a.reducao_estimada_pct}%)
                        </p>
                        {a.paginas && a.paginas.length > 0 && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-[10px] text-zinc-500 hover:text-pavcon-navy">
                              Ver detalhamento por página
                            </summary>
                            <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-[10px]">
                              {a.paginas.map((p) => {
                                const relevant = a.paginas_relevantes.includes(p.num);
                                return (
                                  <li key={p.num} className={`flex items-center gap-1.5 ${relevant ? 'text-emerald-700' : 'text-amber-700'}`}>
                                    <span className="font-mono">p.{p.num}</span>
                                    <span className="font-semibold">{p.classe}</span>
                                    <span className="text-zinc-500">({(p.confianca * 100).toFixed(0)}%)</span>
                                    <span className="truncate text-zinc-600">— {p.justificativa}</span>
                                  </li>
                                );
                              })}
                            </ul>
                          </details>
                        )}
                      </>
                    )}
                  </div>
                ))}
                {classifResult.total_paginas_descartaveis > 0 && (
                  <button
                    onClick={handleAplicarCorte}
                    disabled={isPending || cortando}
                    className="w-full rounded-md bg-pavcon-orange px-4 py-2 text-xs font-semibold text-white shadow hover:bg-pavcon-orange-dark disabled:opacity-50"
                  >
                    {cortando ? '✂️ Cortando…' : `✂️ Aplicar corte e remover ${classifResult.total_paginas_descartaveis} páginas`}
                  </button>
                )}
              </div>
            )}

            {/* Resultado pós-corte */}
            {corteResult && (
              <div className="mt-3 space-y-1 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-xs">
                <p className="font-bold text-emerald-900">
                  ✅ Corte aplicado! Redução total: {corteResult.total_reducao_pct}%
                </p>
                <ul className="space-y-0.5 text-emerald-800">
                  {corteResult.resultados.map((r, i) => (
                    <li key={i} className="truncate">
                      • {r.filename}: {r.erro
                        ? <span className="text-red-700">{r.erro}</span>
                        : <>de <strong>{r.paginas_antes}</strong> pra <strong>{r.paginas_depois}</strong> páginas (−{r.reducao_pct}%)</>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <p className="text-xs text-zinc-600">Escolha como extrair os dados deste orçamento:</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {/* Opção 1 — Gemini API automática */}
            <button
              onClick={() => handleStart('gemini')}
              disabled={isPending}
              className="rounded-md border border-zinc-300 bg-white p-4 text-left hover:bg-zinc-50 disabled:opacity-50"
            >
              <p className="text-sm font-semibold text-zinc-900">
                ⚡ Gemini API (automático)
              </p>
              <p className="mt-1 text-xs text-zinc-600">
                Roda a Edge Function chamando Gemini 2.5 Pro. 2–5 min, ~$0.50/edital.
              </p>
            </button>

            {/* Opção 2 — NotebookLM */}
            <button
              onClick={() => openManualExtraction('notebooklm')}
              disabled={isPending}
              className="rounded-md border border-zinc-300 bg-white p-4 text-left hover:bg-zinc-50 disabled:opacity-50"
            >
              <p className="text-sm font-semibold text-zinc-900">
                📓 NotebookLM (1 clique)
              </p>
              <p className="mt-1 text-xs text-zinc-600">
                Abre o NotebookLM em nova aba + copia o prompt + mostra os PDFs pra
                baixar. Gratuito.
              </p>
            </button>

            {/* Opção 3 — Claude API automática (substitui o antigo Claude 1-clique manual) */}
            <button
              onClick={() => handleStart('anthropic')}
              disabled={isPending}
              className="rounded-md border border-pavcon-orange/40 bg-pavcon-orange-50/30 p-4 text-left hover:bg-pavcon-orange-50 disabled:opacity-50"
            >
              <p className="text-sm font-semibold text-zinc-900">
                🤖 Claude API (automático)
              </p>
              <p className="mt-1 text-xs text-zinc-600">
                Roda a Edge Function chamando Claude Sonnet 4.5. ~3–6 min, melhor pra
                planilhas complexas que truncam no Gemini. ~$2/edital.
              </p>
            </button>
          </div>
          {isPending && <p className="text-xs text-zinc-500">Processando…</p>}
        </div>
      )}

      {importResult && (
        <div className={`rounded-md p-3 text-sm ${importResult.jsonReparado ? 'bg-amber-50 text-amber-900' : 'bg-emerald-50 text-emerald-800'}`}>
          {importResult.jsonReparado ? '⚠ JSON estava truncado' : '✓ JSON importado'}:{' '}
          <strong>{importResult.composicoes}</strong> composições e{' '}
          <strong>{importResult.subItens}</strong> sub-itens inseridos.
          {importResult.jsonReparado && (
            <p className="mt-1 text-xs">
              O LLM cortou a resposta no meio do JSON. Conseguimos recuperar até o último item válido,
              mas <strong>itens do final podem ter sido perdidos</strong>. Conferir a tabela do edital
              vs a contagem acima — se faltar item, peça pra o LLM continuar de onde parou e re-importe.
            </p>
          )}
        </div>
      )}

      <ImportJsonModal
        licitacaoId={licitacaoId}
        source={importModal ?? 'outro'}
        arquivos={arquivos}
        promptCopied={promptCopied}
        open={importModal !== null}
        onClose={() => {
          setImportModal(null);
          setPromptCopied(false);
        }}
        onSuccess={(c, s, jsonReparado) => setImportResult({ composicoes: c, subItens: s, jsonReparado })}
      />

      {isExtracting && (
        <div className="rounded-md bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Extração em andamento…</p>
          <p className="mt-1 text-xs">
            Pode levar 1–3 minutos pra editais grandes. A página vai recarregar
            sozinha quando terminar.
          </p>
        </div>
      )}

      {isError && (
        <div className="space-y-2">
          <p className="text-sm text-red-800">A extração falhou.</p>
          <button
            onClick={handleReset}
            disabled={isPending}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            Voltar pra rascunho
          </button>
        </div>
      )}

      {isReviewable && ultimaExtracao?.json && (
        <ExtractionEditor
          licitacaoId={licitacaoId}
          extracaoId={ultimaExtracao.id}
          jsonInicial={ultimaExtracao.json}
          jaRevisada={ultimaExtracao.ja_revisada}
          onApproved={handleCadastrarOrcamentoCompleto}
        />
      )}

      {canCadastrar && (
        <div className="space-y-3 rounded-md border border-blue-200 bg-blue-50 p-4">
          <div>
            <p className="text-sm font-medium text-blue-900">
              Passo 1 — Cadastrar composições próprias no MyBase
            </p>
            <p className="mt-1 text-xs text-blue-800">
              Cria uma pasta no MyBase e cadastra as composições <strong>PROPRIAS</strong>{' '}
              do edital (com seus sub-itens, coeficientes e nomenclatura{' '}
              <strong>exatamente como o orçamento do órgão</strong>). É pré-requisito do
              Passo 2 — sem isso, as composições PROPRIAS ficam com valor R$ 0,00 no
              orçamento final.
            </p>
          </div>
          <button
            onClick={handleCadastrar}
            disabled={isPending}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isPending ? 'Cadastrando…' : 'Cadastrar composições próprias'}
          </button>
        </div>
      )}

      {cadastroResult && (
        <div className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-medium">✓ Cadastrado com sucesso</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-emerald-700">Pasta criada</dt>
            <dd className="font-medium">{cadastroResult.grupo_descricao ?? '—'}</dd>
            <dt className="text-emerald-700">Composições criadas</dt>
            <dd className="font-medium">{cadastroResult.composicoes_criadas ?? 0}</dd>
            <dt className="text-emerald-700">Itens adicionados</dt>
            <dd className="font-medium">{cadastroResult.itens_adicionados ?? 0}</dd>
            {(cadastroResult.composicoes_puladas ?? 0) > 0 && (
              <>
                <dt className="text-emerald-700">Já cadastradas (puladas)</dt>
                <dd className="font-medium">{cadastroResult.composicoes_puladas}</dd>
              </>
            )}
          </dl>
          {/* Overlay quando a IA está rodando auto-correção */}
          {iaCorrigindo && (
            <div className="mt-2 rounded-lg border-2 border-pavcon-navy bg-gradient-to-r from-pavcon-navy-50 to-pavcon-orange-50 p-3 text-xs">
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 animate-pulse rounded-full bg-pavcon-orange" />
                <p className="font-bold text-pavcon-navy">
                  🤖 OrçaPav AI corrigindo automaticamente — {iaCorrigindo.mensagem}
                </p>
              </div>
            </div>
          )}
          {cadastroResult.warnings && cadastroResult.warnings.length > 0 && (
            <details className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">
              <summary className="cursor-pointer">⚠ {cadastroResult.warnings.length} avisos</summary>
              <ul className="mt-2 list-disc pl-4">
                {cadastroResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </details>
          )}
          <p className="mt-2 text-xs text-emerald-800">
            <strong>Próximo passo:</strong> rode o Passo 2 (botão roxo) pra criar o orçamento completo no Orçafascio referenciando essa pasta. Ou — mais simples — pule esse passo e use direto o botão roxo, que faz Passo 1 + Passo 2 numa só.
          </p>
        </div>
      )}

      {/* Cadastrar orçamento completo — usa web auth (email+senha), funciona
          já a partir de aguardando_revisao_humana. Permite pular o MyBase
          (que exige secret_token de API e não é necessário pro fluxo principal). */}
      {(status === 'aguardando_revisao_humana' ||
        status === 'criando_composicoes_edital' ||
        status === 'fase1_concluida' ||
        status === 'criando_orcamento_base') &&
        !orcamentoResult && (
          <div className="space-y-3 rounded-md border border-purple-200 bg-purple-50 p-4">
            <div>
              <p className="text-sm font-medium text-purple-900">
                🚀 Cadastrar orçamento completo no Orçafascio (tudo automático)
              </p>
              <p className="mt-1 text-xs text-purple-800">
                Roda <strong>Passo 1 + Passo 2</strong> em sequência: cadastra as
                composições próprias no MyBase (se ainda não estiverem) e em
                seguida cria o orçamento com cabeçalho, BDI, leis sociais, 3 bancos
                (SINAPI/SICRO3/ORSE) e todas as etapas + composições. Um clique faz
                tudo.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleCadastrarOrcamentoCompleto}
                disabled={isPending}
                className="rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
              >
                {isPending ? 'Cadastrando…' : '🚀 Cadastrar tudo no Orçafascio'}
              </button>
              <button
                onClick={handleResetOrcafascio}
                disabled={isPending}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                title="Limpa IDs MyBase + sessão web + volta status pra criando_composicoes_edital (Passo 1)"
              >
                ↺ Resetar Orçafascio
              </button>
            </div>
          </div>
        )}

      {orcamentoResult && (
        <div className="space-y-2 rounded-md border border-emerald-300 bg-emerald-50 p-4 text-sm">
          <p className="font-semibold text-emerald-900">
            ✅ Orçamento criado no Orçafascio!
          </p>
          {orcamentoResult.budget_url && (
            <a
              href={orcamentoResult.budget_url}
              target="_blank"
              rel="noreferrer"
              className="block rounded-md bg-white px-3 py-2 text-xs text-emerald-800 underline hover:bg-emerald-100"
            >
              {orcamentoResult.budget_url}
            </a>
          )}
          {orcamentoResult.mybase && (
            <p className="rounded bg-emerald-100 px-2 py-1 text-[11px] text-emerald-900">
              ↺ Passo 1 (MyBase) também foi rodado automaticamente:{' '}
              <strong>{orcamentoResult.mybase.composicoes_criadas}</strong>{' '}
              composições próprias criadas com{' '}
              <strong>{orcamentoResult.mybase.itens_adicionados}</strong> sub-itens.
            </p>
          )}
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-emerald-800">
            <dt>Budget ID:</dt>
            <dd className="font-mono">{orcamentoResult.budget_id}</dd>
            <dt>Etapas criadas:</dt>
            <dd className="font-medium">{orcamentoResult.etapas_criadas ?? 0}</dd>
            <dt>Composições criadas:</dt>
            <dd className="font-medium">{orcamentoResult.composicoes_criadas ?? 0}</dd>
            <dt>BDI configurado:</dt>
            <dd className="font-medium">{orcamentoResult.bdi}%</dd>
            <dt>Leis sociais (horista):</dt>
            <dd className="font-medium">{orcamentoResult.leis_sociais_horista}%</dd>
            {orcamentoResult.bancos_configurados && orcamentoResult.bancos_configurados.length > 0 && (
              <>
                <dt>Bancos:</dt>
                <dd className="font-medium">{orcamentoResult.bancos_configurados.join(', ')}</dd>
              </>
            )}
          </dl>
          {orcamentoResult.warnings && orcamentoResult.warnings.length > 0 && (
            <details className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">
              <summary className="cursor-pointer">⚠ {orcamentoResult.warnings.length} aviso(s) — ajuste manual recomendado</summary>
              <ul className="mt-2 list-disc pl-4">
                {orcamentoResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </details>
          )}
          <p className="mt-3 text-xs text-emerald-700">
            <strong>Próximo passo:</strong> abra o link acima no navegador (precisa estar
            logado no Orçafascio) pra revisar o orçamento criado.
          </p>
        </div>
      )}

      {isDone && ultimaExtracao?.json && (
        <div className="space-y-2 text-sm">
          <p className="text-emerald-700">Extração aprovada e composições cadastradas no Orçafascio.</p>
          <div className="flex items-center gap-2">
            <details className="flex-1 text-xs">
              <summary className="cursor-pointer text-zinc-600">Ver itens extraídos ({ultimaExtracao.json.itens.length})</summary>
              <pre className="mt-2 max-h-96 overflow-auto rounded bg-zinc-50 p-3 text-[11px]">
                {JSON.stringify(ultimaExtracao.json, null, 2)}
              </pre>
            </details>
            <button
              onClick={handleResetOrcafascio}
              disabled={isPending}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              title="Refaz Passo 1 + 2 do zero"
            >
              {isPending ? 'Resetando…' : '↺ Resetar Orçafascio'}
            </button>
          </div>
        </div>
      )}

      {!ultimaExtracao && !canStart && !isExtracting && (
        <p className="text-sm text-zinc-500">
          Suba um PDF antes de iniciar a extração.
        </p>
      )}
    </section>
  );
}

// helper para o server-side aproveitar
export async function _approve(licitacaoId: string) {
  return await approveExtraction(licitacaoId);
}
export async function _save(
  licitacaoId: string,
  extracaoId: string,
  json: { cabecalho: Record<string, unknown>; itens: ExtractedItem[] },
) {
  return await saveExtractionEdits(licitacaoId, extracaoId, json);
}
