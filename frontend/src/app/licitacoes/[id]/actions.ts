'use server';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { revalidatePath } from 'next/cache';

interface ActionResult {
  ok?: boolean;
  error?: string;
  details?: unknown;
}

/**
 * Otimiza os PDFs da licitação antes da extração:
 *   - Recompressão lossless via pdf-lib (object streams)
 *   - Strip de metadata desnecessária
 *
 * Reduz 15-30% o tamanho típico, acelera upload pro Gemini e economiza
 * tokens de imagem. NÃO altera conteúdo visual.
 *
 * Retorna stats por arquivo + redução total.
 */
export async function otimizarPdfs(
  licitacaoId: string,
): Promise<ActionResult & {
  otimizados?: Array<{
    filename: string;
    antes_bytes: number;
    depois_bytes: number;
    reducao_pct: number;
    skipped?: boolean;
    motivo_skip?: string;
  }>;
  total_antes_bytes?: number;
  total_depois_bytes?: number;
  total_reducao_pct?: number;
}> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Não autenticado.' };

  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/pdf-otimizar`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ licitacao_id: licitacaoId }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch {}

  revalidatePath(`/licitacoes/${licitacaoId}`);

  if (!res.ok) {
    return { error: `Otimização falhou (${res.status}): ${(body.error as string) ?? text.slice(0, 200)}` };
  }
  return {
    ok: true,
    otimizados: body.otimizados as Array<{
      filename: string;
      antes_bytes: number;
      depois_bytes: number;
      reducao_pct: number;
      skipped?: boolean;
      motivo_skip?: string;
    }> | undefined,
    total_antes_bytes: body.total_antes_bytes as number | undefined,
    total_depois_bytes: body.total_depois_bytes as number | undefined,
    total_reducao_pct: body.total_reducao_pct as number | undefined,
  };
}

/**
 * Classifica cada página dos PDFs via Gemini Flash. Retorna preview de quais
 * são relevantes vs descartáveis — NÃO modifica nada.
 */
export async function classificarPaginasPdf(
  licitacaoId: string,
): Promise<ActionResult & {
  arquivos?: Array<{
    arquivo_id: string;
    filename: string;
    total_paginas: number;
    paginas_relevantes: number[];
    paginas_descartaveis: number[];
    reducao_estimada_pct: number;
    paginas?: Array<{ num: number; classe: string; confianca: number; justificativa: string }>;
    erro?: string;
  }>;
  total_paginas?: number;
  total_paginas_descartaveis?: number;
  total_reducao_estimada_pct?: number;
}> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Não autenticado.' };

  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/pdf-classificar-paginas`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ licitacao_id: licitacaoId }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch {}
  if (!res.ok) return { error: `Classificação falhou (${res.status}): ${(body.error as string) ?? text.slice(0, 200)}` };
  return {
    ok: true,
    arquivos: body.arquivos as Array<{
      arquivo_id: string;
      filename: string;
      total_paginas: number;
      paginas_relevantes: number[];
      paginas_descartaveis: number[];
      reducao_estimada_pct: number;
      paginas?: Array<{ num: number; classe: string; confianca: number; justificativa: string }>;
      erro?: string;
    }> | undefined,
    total_paginas: body.total_paginas as number | undefined,
    total_paginas_descartaveis: body.total_paginas_descartaveis as number | undefined,
    total_reducao_estimada_pct: body.total_reducao_estimada_pct as number | undefined,
  };
}

/**
 * Aplica o corte: substitui cada PDF no Storage por uma versão só com as
 * páginas indicadas. Destrutivo — não tem rollback automático.
 */
export async function cortarPaginasPdf(
  licitacaoId: string,
  cortes: Array<{ arquivo_id: string; paginas_manter: number[] }>,
): Promise<ActionResult & {
  resultados?: Array<{
    arquivo_id: string;
    filename?: string;
    antes_bytes?: number;
    depois_bytes?: number;
    paginas_antes?: number;
    paginas_depois?: number;
    reducao_pct?: number;
    erro?: string;
  }>;
  total_reducao_pct?: number;
}> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Não autenticado.' };

  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/pdf-cortar-paginas`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ licitacao_id: licitacaoId, cortes }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch {}

  revalidatePath(`/licitacoes/${licitacaoId}`);

  if (!res.ok) return { error: `Corte falhou (${res.status}): ${(body.error as string) ?? text.slice(0, 200)}` };
  return {
    ok: true,
    resultados: body.resultados as Array<{
      arquivo_id: string;
      filename?: string;
      antes_bytes?: number;
      depois_bytes?: number;
      paginas_antes?: number;
      paginas_depois?: number;
      reducao_pct?: number;
      erro?: string;
    }> | undefined,
    total_reducao_pct: body.total_reducao_pct as number | undefined,
  };
}

export async function startExtraction(
  licitacaoId: string,
  _arquivoId: string | null,
  provider: 'gemini' | 'anthropic' = 'gemini',
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { error: 'Não autenticado.' };

  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/extracao-edital`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    // Manda licitacao_id pra função processar TODOS os arquivos da licitação.
    // provider escolhe o LLM (gemini default; anthropic = Claude Sonnet 4.5).
    body: JSON.stringify({ licitacao_id: licitacaoId, provider }),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  revalidatePath(`/licitacoes/${licitacaoId}`);

  if (!res.ok) {
    return { error: `Extração falhou (${res.status})`, details: body };
  }
  return { ok: true };
}

export async function saveExtractionEdits(
  licitacaoId: string,
  extracaoId: string,
  jsonCorrigido: { cabecalho: Record<string, unknown>; itens: ExtractedItem[] },
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado.' };

  // Server-side: usa admin (service_role) pra contornar RLS nas tabelas
  // composicoes_extraidas e composicao_propria_itens, que são populadas
  // por Edge Functions. A autorização já foi validada (user autenticado
  // + dono da revisão; checagem extra abaixo via licitacao_id).
  const admin = createAdminClient();

  // 1) Salva json_corrigido + marca quem revisou
  const { error: extrErr } = await admin
    .from('extracoes_ocr')
    .update({
      json_corrigido: jsonCorrigido,
      status: 'revisada_humano',
      revisado_por: user.id,
      revisado_em: new Date().toISOString(),
    })
    .eq('id', extracaoId)
    .eq('licitacao_id', licitacaoId);
  if (extrErr) return { error: `Falha ao salvar revisão: ${extrErr.message}` };

  // 2) Re-popula composicoes_extraidas (cascade limpa composicao_propria_itens)
  const { error: delErr } = await admin
    .from('composicoes_extraidas')
    .delete()
    .eq('licitacao_id', licitacaoId)
    .eq('extracao_id', extracaoId);
  if (delErr) return { error: `Falha ao limpar composições antigas: ${delErr.message}` };

  // Mesmo padrão do extracao-edital (Edge Function) e importarJsonManual:
  // item_codigo duplicado no JSON editado (blocos/etapas que repetem
  // numeração, ou edição manual do orçamentista introduzindo um código já
  // usado) colide com UNIQUE(licitacao_id, item_codigo) e derruba o
  // INSERT inteiro. Desambigua com sufixo "#N" antes de gravar.
  const codigoVistoEdicao = new Map<string, number>();
  const composicoesRows = jsonCorrigido.itens.map((item, idx) => {
    const fonteNormalizada = normalizeFonte(item.fonte);
    const adaptCheck = detectarCodigoAdaptado(fonteNormalizada, item.codigo);
    const fonteFinal = adaptCheck.reclassificarComoPropria ? 'PROPRIA' : fonteNormalizada;

    const ocorrencia = (codigoVistoEdicao.get(item.item_codigo) ?? 0) + 1;
    codigoVistoEdicao.set(item.item_codigo, ocorrencia);
    const itemCodigoFinal =
      ocorrencia > 1 ? `${item.item_codigo}#${ocorrencia}` : item.item_codigo;

    let metadata: Record<string, unknown> = {};
    if (item.fonte && fonteNormalizada === 'OUTRA' && item.fonte.toUpperCase() !== 'OUTRA') {
      metadata = { fonte_original: item.fonte };
    }
    if (adaptCheck.reclassificarComoPropria) {
      metadata = {
        ...metadata,
        fonte_original: item.fonte ?? null,
        codigo_original: item.codigo ?? null,
        reclassificada_motivo: adaptCheck.motivo,
      };
    }
    if (ocorrencia > 1) {
      metadata = { ...metadata, item_codigo_original: item.item_codigo };
    }
    return {
      licitacao_id: licitacaoId,
      extracao_id: extracaoId,
      item_codigo: itemCodigoFinal,
      item_nivel: item.nivel,
      item_pai_codigo: item.pai,
      tipo_linha: item.tipo,
      codigo: item.codigo,
      fonte: fonteFinal,
      descricao: item.descricao,
      unidade: item.unidade,
      quantidade: item.quantidade,
      preco_unitario_sem_bdi: item.preco_unitario_sem_bdi,
      preco_unitario_com_bdi: item.preco_unitario_com_bdi,
      preco_total: item.preco_total,
      ordem: idx,
      metadata,
    };
  });

  if (composicoesRows.length > 0) {
    // upsert (não insert puro): protege contra sobra de linhas de outro
    // extracao_id pra mesma licitação, que o DELETE acima (escopado por
    // extracao_id) não alcança.
    const { error: insErr } = await admin
      .from('composicoes_extraidas')
      .upsert(composicoesRows, { onConflict: 'licitacao_id,item_codigo' });
    if (insErr) return { error: `Falha ao reinserir composições: ${insErr.message}` };
  }

  // 3) Re-insere os sub-itens das composições próprias.
  // Pareado por índice (ordem 0..n-1), não por item_codigo — códigos podem
  // ter sido desambiguados acima e deixar de ser únicos por si só.
  const { data: persistidas, error: relerErr } = await admin
    .from('composicoes_extraidas')
    .select('id')
    .eq('licitacao_id', licitacaoId)
    .eq('extracao_id', extracaoId)
    .order('ordem');
  if (relerErr || !persistidas) {
    return { error: 'Falha ao reler composições.' };
  }

  const subRows: Array<Record<string, unknown>> = [];
  for (let itemIdx = 0; itemIdx < jsonCorrigido.itens.length; itemIdx++) {
    const item = jsonCorrigido.itens[itemIdx];
    if (item.fonte !== 'PROPRIA' || !item.composicao_propria?.itens) continue;
    const compId = persistidas[itemIdx]?.id as string | undefined;
    if (!compId) continue;
    item.composicao_propria.itens.forEach((sub, i) => {
      subRows.push({
        composicao_extraida_id: compId,
        classe: sub.classe,
        codigo: sub.codigo ?? null,
        fonte: sub.fonte,
        descricao: sub.descricao,
        unidade: sub.unidade ?? null,
        coeficiente: sub.coeficiente,
        preco_unitario: sub.preco_unitario ?? null,
        preco_total: sub.preco_unitario != null
          ? sub.coeficiente * sub.preco_unitario
          : null,
        ordem: i,
      });
    });
  }
  if (subRows.length > 0) {
    const { error: subErr } = await admin
      .from('composicao_propria_itens')
      .insert(subRows);
    if (subErr) return { error: `Falha ao gravar sub-itens: ${subErr.message}` };
  }

  revalidatePath(`/licitacoes/${licitacaoId}`);
  return { ok: true };
}

export async function approveExtraction(
  licitacaoId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  // Transição: aguardando_revisao_humana → criando_composicoes_edital
  // (é o próximo estado válido segundo a state machine)
  const { error } = await supabase
    .from('licitacoes')
    .update({ status: 'criando_composicoes_edital' })
    .eq('id', licitacaoId)
    .eq('status', 'aguardando_revisao_humana');
  if (error) return { error: error.message };

  revalidatePath(`/licitacoes/${licitacaoId}`);
  return { ok: true };
}

interface ImportarManualResult extends ActionResult {
  composicoes_inseridas?: number;
  sub_itens_inseridos?: number;
  /** True quando o JSON do LLM veio truncado e foi reparado automaticamente.
   * O orçamentista deve conferir se faltou item no fim do orçamento. */
  json_reparado?: boolean;
}

const SOURCE_LABELS: Record<string, { provider: 'gemini' | 'anthropic' | 'openai' | 'voyage' | 'orcafascio'; model: string }> = {
  notebooklm: { provider: 'gemini', model: 'gemini-2.5-pro (via NotebookLM — manual)' },
  claude_code: { provider: 'anthropic', model: 'claude (via Claude Code — manual)' },
  outro: { provider: 'gemini', model: 'desconhecido (manual)' },
};

interface ManualItem {
  item_codigo: string;
  nivel: number;
  pai: string | null;
  tipo: 'grupo' | 'servico';
  codigo: string | null;
  fonte: string | null;
  descricao: string;
  unidade: string | null;
  quantidade: number | null;
  preco_unitario_sem_bdi: number | null;
  preco_unitario_com_bdi: number | null;
  preco_total: number | null;
  composicao_propria?: {
    itens: Array<{
      classe: string;
      codigo: string | null;
      fonte: string;
      descricao: string;
      unidade: string | null;
      coeficiente: number;
      preco_unitario: number | null;
    }>;
  };
}

interface ManualJson {
  cabecalho: Record<string, unknown>;
  itens: ManualItem[];
}

function validateManualJson(raw: unknown): ManualJson {
  if (!raw || typeof raw !== 'object') throw new Error('JSON deve ser um objeto.');
  const o = raw as Record<string, unknown>;
  if (!o.cabecalho || typeof o.cabecalho !== 'object') {
    throw new Error('Faltou "cabecalho" no JSON.');
  }
  if (!Array.isArray(o.itens)) {
    throw new Error('"itens" deve ser um array.');
  }
  for (let i = 0; i < o.itens.length; i++) {
    const it = o.itens[i] as Partial<ManualItem>;
    if (!it.item_codigo) throw new Error(`Item #${i}: faltou item_codigo.`);
    if (typeof it.nivel !== 'number') throw new Error(`Item ${it.item_codigo}: nivel deve ser número.`);
    if (it.tipo !== 'grupo' && it.tipo !== 'servico') {
      throw new Error(`Item ${it.item_codigo}: tipo deve ser "grupo" ou "servico".`);
    }
    if (!it.descricao) throw new Error(`Item ${it.item_codigo}: faltou descricao.`);
  }
  return o as unknown as ManualJson;
}

function stripCodeFences(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : s.trim();
}

/**
 * Detecta items que foram marcados como SINAPI/ORSE/etc mas com código
 * sinalizando que são ADAPTAÇÕES do edital (variação local da composição
 * oficial). Reclassifica como PROPRIA pra que o cadastrar-edital crie
 * uma composição própria no MyBase em vez de tentar resolver o code
 * inexistente no banco público (que zera o preço).
 *
 * Padrões detectados (case-insensitive):
 *   - Sufixos: "-A", "-ADAP", "-ADAPT", "-ADAPTADA", "-ADAPTADO",
 *     " - ADAP", "ADAP " no meio
 *   - Texto literal "COMPOSIÇÃO XX" / "COMPOSICAO XX" como código
 *
 * Retorna { fonte, codigo_original } com fonte_original preservado em
 * metadata pra rastreabilidade.
 */
function detectarCodigoAdaptado(
  fonte: string | null,
  codigo: string | null,
): { reclassificarComoPropria: boolean; motivo?: string } {
  if (!codigo || !fonte) return { reclassificarComoPropria: false };
  const f = fonte.toUpperCase();
  if (f === 'PROPRIA' || f === 'OUTRA') return { reclassificarComoPropria: false };

  const c = codigo.toUpperCase().trim();

  // Texto literal "COMPOSIÇÃO 07" ou "COMPOSICAO 07" como código
  if (/^COMPOSI[CÇ][ÃA]O\s*[\d_-]+/i.test(c)) {
    return {
      reclassificarComoPropria: true,
      motivo: `código "${codigo}" é texto literal (não é código ${fonte}) — provável composição própria do edital`,
    };
  }

  // Sufixos de adaptação: -ADAP, -ADAPT, -ADAPTADA, -A no final
  if (/[\s-]ADAPT?(?:AD[OA])?\s*$|^ADAPTAD[OA]\s|\sADAP\s|\s-\s*A\s*$|-A$|-ADAP$/i.test(c)) {
    return {
      reclassificarComoPropria: true,
      motivo: `código "${codigo}" tem sufixo de adaptação — composição ${fonte} foi modificada pelo órgão`,
    };
  }

  return { reclassificarComoPropria: false };
}

/**
 * Tenta reparar JSON truncado (típico em respostas de LLM cortadas no meio).
 * Estratégia: localiza o último `}` válido dentro do array `itens` e trunca
 * tudo depois disso, fechando o array e o objeto raiz manualmente.
 *
 * Retorna { parsed, recuperados, descartados } ou null se nem isso funcionar.
 */
function tryParseTruncatedJSON(raw: string): {
  parsed: unknown;
  recuperados: number;
  descartados: 'parcial' | null;
} | null {
  // Localiza início do array itens
  const itensStart = raw.search(/"itens"\s*:\s*\[/);
  if (itensStart < 0) return null;
  const arrayOpen = raw.indexOf('[', itensStart);
  if (arrayOpen < 0) return null;

  // Caminha pelo array contando objetos top-level. Quando encontrar EOF
  // ou char inválido, trunca depois do último `}` que fechou um objeto
  // top-level (depth voltou a 0) e fecha o array + objeto raiz.
  let depth = 0;
  let inString = false;
  let escape = false;
  let lastValidObjectEnd = -1; // posição depois do último `}` top-level válido

  for (let i = arrayOpen + 1; i < raw.length; i++) {
    const c = raw[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) lastValidObjectEnd = i + 1;
    } else if (c === ']' && depth === 0) {
      // Array fechou normalmente — JSON é válido, não precisa reparar
      return null;
    }
  }

  if (lastValidObjectEnd < 0) return null;

  // Constrói JSON reparado: tudo até o último objeto + `]` + `}`
  const reparado = raw.slice(0, lastValidObjectEnd) + ']}';
  try {
    const parsed = JSON.parse(reparado);
    const itens = (parsed as { itens?: unknown[] }).itens ?? [];
    return {
      parsed,
      recuperados: itens.length,
      descartados: 'parcial',
    };
  } catch {
    return null;
  }
}

// Valores aceitos pelo enum `fonte_referencia` no Postgres. Manter
// sincronizado com a migration de bases (SQL ALTER TYPE ADD VALUE).
const FONTES_VALIDAS = new Set([
  'SINAPI', 'SICRO', 'SICRO3', 'SEINFRA', 'ORSE', 'SBC', 'PROPRIA', 'OUTRA',
  'SEDOP', 'SETOP', 'EMBASA', 'FDE', 'CPOS', 'SUDECAP', 'IOPES', 'AGESUL',
  'EMOP', 'SCO', 'DERPR', 'CAEMA', 'CAERN', 'COMPESA', 'SIURB', 'AGETOP', 'MAPP',
]);

/** Normaliza `fonte` do JSON extraído pra um valor aceito pelo enum do banco.
 * Aceita variantes comuns vindas do LLM (SICRO/SICRO3, SICRO2 antigo, etc) e
 * cai em "OUTRA" como fallback defensivo pra não quebrar o insert. */
function normalizeFonte(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const u = String(raw).toUpperCase().trim();
  if (!u) return null;
  // Normalizações conhecidas
  if (u === 'SICRO2' || u === 'SICRO 2') return 'SICRO';
  if (u.startsWith('SICRO')) return u.includes('3') ? 'SICRO3' : 'SICRO';
  if (u.startsWith('AGETOP')) return 'AGETOP';
  if (u.startsWith('SIURB')) return 'SIURB';
  // Aceita direto se está no enum
  if (FONTES_VALIDAS.has(u)) return u;
  // Fallback defensivo: bancos desconhecidos viram OUTRA pro insert
  // não quebrar. Edge Function depois loga warning específico no
  // cadastro pra o usuário ver no painel.
  return 'OUTRA';
}

export async function importarExtracaoManual(
  licitacaoId: string,
  jsonText: string,
  source: 'notebooklm' | 'claude_code' | 'outro',
): Promise<ImportarManualResult> {
  const t0 = Date.now();
  try {
  console.log('[importar] start', { licitacaoId, source, jsonLen: jsonText.length });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  console.log('[importar] auth', { ms: Date.now() - t0, userId: user?.id });
  if (!user) return { error: 'Não autenticado.' };

  // Parse + validate (com recuperação resiliente pra JSON truncado pelo LLM)
  let parsed: ManualJson;
  let jsonReparado = false;
  try {
    const cleaned = stripCodeFences(jsonText);
    try {
      parsed = validateManualJson(JSON.parse(cleaned));
      console.log('[importar] parsed', { ms: Date.now() - t0, itens: parsed.itens.length });
    } catch (parseErr) {
      // Tenta reparar JSON truncado (LLM cortou a resposta no meio).
      // Recupera o que dá, mantém warning explícito no retorno.
      const recovery = tryParseTruncatedJSON(cleaned);
      if (recovery) {
        parsed = validateManualJson(recovery.parsed);
        jsonReparado = true;
        console.warn('[importar] JSON reparado', {
          ms: Date.now() - t0,
          itens: parsed.itens.length,
          erro_original: parseErr instanceof Error ? parseErr.message : String(parseErr),
        });
      } else {
        return {
          error: `JSON inválido e irrecuperável: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. Provavelmente o LLM (NotebookLM/Claude) cortou a resposta no meio — peça pra ele continuar de onde parou ou rode a extração novamente.`,
        };
      }
    }
  } catch (e) {
    return { error: `JSON inválido: ${e instanceof Error ? e.message : String(e)}` };
  }

  const admin = createAdminClient();

  // Verifica licitação
  const { data: licitacao, error: licErr } = await admin
    .from('licitacoes')
    .select('id, status')
    .eq('id', licitacaoId)
    .maybeSingle();
  if (licErr || !licitacao) return { error: 'Licitação não encontrada.' };
  const ALLOWED = new Set(['rascunho', 'aguardando_extracao', 'aguardando_revisao_humana', 'erro']);
  if (!ALLOWED.has(licitacao.status)) {
    return { error: `Licitação está em "${licitacao.status}", precisa estar em rascunho/aguardando_extracao/aguardando_revisao_humana/erro.` };
  }

  // Pega o primeiro arquivo da licitação pra referenciar na extração
  const { data: arquivos } = await admin
    .from('licitacao_arquivos')
    .select('id')
    .eq('licitacao_id', licitacaoId)
    .order('created_at')
    .limit(1);
  const arquivoId = arquivos?.[0]?.id;
  if (!arquivoId) {
    return { error: 'Suba pelo menos um arquivo antes de importar o JSON.' };
  }

  // Limpa extrações antigas — ORDEM IMPORTA porque composicoes_extraidas
  // referencia extracoes_ocr com NO ACTION (não CASCADE). Apagar composicoes
  // primeiro também CASCADE-deleta composicao_propria_itens.
  // Sem isso, a DELETE em extracoes_ocr falha com FK 23503 e a action segue
  // ignorando o erro → INSERT em composicoes_extraidas colide com UNIQUE
  // (licitacao_id, item_codigo) → ação fica em loop/timeout silencioso.
  const { error: delCompsErr } = await admin
    .from('composicoes_extraidas')
    .delete()
    .eq('licitacao_id', licitacaoId);
  if (delCompsErr) {
    console.error('[importar] delete composicoes_extraidas FAILED', delCompsErr);
    return {
      error: `Falha ao limpar composições antigas: ${delCompsErr.message}`,
    };
  }
  const { error: delExtrErr } = await admin
    .from('extracoes_ocr')
    .delete()
    .eq('licitacao_id', licitacaoId);
  if (delExtrErr) {
    console.error('[importar] delete extracoes_ocr FAILED', delExtrErr);
    return {
      error: `Falha ao limpar extrações antigas: ${delExtrErr.message}`,
    };
  }
  console.log('[importar] cleared old extracoes + composicoes', {
    ms: Date.now() - t0,
  });

  // Atualiza campos do cabeçalho na licitação (BDI, bases, municipio, etc.).
  // Faltava: sem isso, orcafascio-cadastrar-edital builda grupos sem municipio
  // (gera nome ambíguo e conflita em retries), e cadastrar-orcamento perde o
  // BDI default. Roda BEFORE de criar a extracao_ocr porque o save dos itens
  // depende da licitação estar consistente.
  const cabecalho = (parsed.cabecalho ?? {}) as Record<string, unknown>;
  const bases = Array.isArray(cabecalho.bases_utilizadas)
    ? (cabecalho.bases_utilizadas as string[])
        .map((b) => normalizeFonte(b))
        .filter((b): b is string => b != null && b !== 'PROPRIA')
        // Remove duplicatas (SICRO + SICRO3 viram dois entries)
        .filter((b, i, arr) => arr.indexOf(b) === i)
    : null;
  const ufRaw = cabecalho.uf;
  const uf = typeof ufRaw === 'string' ? ufRaw.toUpperCase().slice(0, 2) : null;
  const bdiNum = cabecalho.bdi_percentual != null
    ? Number(cabecalho.bdi_percentual)
    : null;
  const leisNum = cabecalho.leis_sociais_percentual != null
    ? Number(cabecalho.leis_sociais_percentual)
    : null;
  await admin
    .from('licitacoes')
    .update({
      municipio: cabecalho.municipio ?? null,
      uf,
      orgao_licitante: cabecalho.orgao ?? null,
      bdi_referencia_edital: bdiNum,
      leis_sociais_referencia: leisNum,
      ...(bases && bases.length > 0 ? { bases_referencia: bases } : {}),
    })
    .eq('id', licitacaoId);

  // Cria extração
  const meta = SOURCE_LABELS[source] ?? SOURCE_LABELS.outro;
  const { data: extr, error: extrErr } = await admin
    .from('extracoes_ocr')
    .insert({
      licitacao_id: licitacaoId,
      arquivo_id: arquivoId,
      llm_provider: meta.provider,
      llm_model: meta.model,
      prompt_versao: 'pavcon-extracao-edital-v1',
      status: 'sucesso',
      json_extraido: parsed,
      tokens_input: 0,
      tokens_output: 0,
      custo_usd: 0,
      duracao_ms: 0,
      concluido_em: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (extrErr || !extr) {
    console.error('[importar] extracao_ocr insert FAILED', extrErr);
    return { error: `Falha ao criar extracao_ocr: ${extrErr?.message}` };
  }
  const extracaoId = extr.id as string;
  console.log('[importar] extracao_ocr created', { ms: Date.now() - t0, extracaoId });

  // Insere composicoes_extraidas — fonte normalizada pelo enum + detecção
  // automática de códigos adaptados (SINAPI/ORSE com sufixo "-ADAP", "-A",
  // "adaptado" OU texto literal "COMPOSIÇÃO XX"): reclassifica como PROPRIA
  // pra criar uma composição própria no MyBase em vez de tentar resolver
  // um code inexistente que zera o preço.
  let reclassificadas = 0;

  // Mesmo padrão do extracao-edital (Edge Function): planilhas com múltiplos
  // blocos/etapas às vezes repetem item_codigo entre blocos, e o LLM usado
  // pra gerar o JSON manual (NotebookLM/Claude) também pode repetir um
  // código por erro de leitura. Como composicoes_extraidas tem
  // UNIQUE(licitacao_id, item_codigo), duplicata dentro do lote derrubava o
  // INSERT inteiro. Desambigua com sufixo "#N" antes de gravar.
  const codigoOcorrenciaManual = new Map<string, number>();
  const codigosDuplicadosManual = new Set<string>();
  for (const item of parsed.itens) {
    const n = (codigoOcorrenciaManual.get(item.item_codigo) ?? 0) + 1;
    codigoOcorrenciaManual.set(item.item_codigo, n);
    if (n > 1) codigosDuplicadosManual.add(item.item_codigo);
  }
  if (codigosDuplicadosManual.size > 0) {
    console.log(`[importar] item_codigo duplicado no JSON manual, desambiguado: ${[...codigosDuplicadosManual].join(', ')}`);
  }

  const codigoVistoManual = new Map<string, number>();
  const compRows = parsed.itens.map((item, idx) => {
    const fonteNormalizada = normalizeFonte(item.fonte);
    const adaptCheck = detectarCodigoAdaptado(fonteNormalizada, item.codigo);
    const fonteFinal = adaptCheck.reclassificarComoPropria ? 'PROPRIA' : fonteNormalizada;
    if (adaptCheck.reclassificarComoPropria) reclassificadas++;

    const ocorrencia = (codigoVistoManual.get(item.item_codigo) ?? 0) + 1;
    codigoVistoManual.set(item.item_codigo, ocorrencia);
    const itemCodigoFinal =
      ocorrencia > 1 ? `${item.item_codigo}#${ocorrencia}` : item.item_codigo;

    // Metadata: rastreabilidade pra fonte original quando reclassificamos
    let metadata: Record<string, unknown> = {};
    if (item.fonte && fonteNormalizada === 'OUTRA' && item.fonte.toUpperCase() !== 'OUTRA') {
      metadata = { fonte_original: item.fonte };
    }
    if (adaptCheck.reclassificarComoPropria) {
      metadata = {
        ...metadata,
        fonte_original: item.fonte ?? null,
        codigo_original: item.codigo ?? null,
        reclassificada_motivo: adaptCheck.motivo,
      };
    }
    if (ocorrencia > 1) {
      metadata = { ...metadata, item_codigo_original: item.item_codigo };
    }

    return {
      licitacao_id: licitacaoId,
      extracao_id: extracaoId,
      item_codigo: itemCodigoFinal,
      item_nivel: item.nivel,
      item_pai_codigo: item.pai,
      tipo_linha: item.tipo,
      codigo: item.codigo,
      fonte: fonteFinal,
      descricao: item.descricao,
      unidade: item.unidade,
      quantidade: item.quantidade,
      preco_unitario_sem_bdi: item.preco_unitario_sem_bdi,
      preco_unitario_com_bdi: item.preco_unitario_com_bdi,
      preco_total: item.preco_total,
      ordem: idx,
      metadata,
    };
  });
  if (reclassificadas > 0) {
    console.log(`[importar] ${reclassificadas} items reclassificados de SINAPI/ORSE pra PROPRIA por sufixo de adaptação`);
  }
  // upsert (não insert puro): se a limpeza acima (delete composicoes_extraidas)
  // não pegar tudo por algum motivo, sobrescreve em vez de colidir com a
  // mesma unique constraint (licitacao_id, item_codigo).
  const { error: cErr } = await admin
    .from('composicoes_extraidas')
    .upsert(compRows, { onConflict: 'licitacao_id,item_codigo' });
  if (cErr) {
    console.error('[importar] composicoes_extraidas insert FAILED', cErr);
    return { error: `Falha ao gravar composicoes_extraidas: ${cErr.message}` };
  }
  // Pareado por índice (ordem 0..n-1), não por item_codigo — códigos podem
  // ter sido desambiguados acima e deixar de ser únicos por si só.
  const { data: persistidas, error: persistErr } = await admin
    .from('composicoes_extraidas')
    .select('id')
    .eq('licitacao_id', licitacaoId)
    .eq('extracao_id', extracaoId)
    .order('ordem');
  if (persistErr || !persistidas) {
    console.error('[importar] releitura composicoes_extraidas FAILED', persistErr);
    return { error: `Falha ao reler composicoes_extraidas: ${persistErr?.message}` };
  }
  console.log('[importar] composicoes inseridas', {
    ms: Date.now() - t0,
    count: persistidas.length,
  });

  // Insere composicao_propria_itens
  const subRows: Array<Record<string, unknown>> = [];
  for (let itemIdx = 0; itemIdx < parsed.itens.length; itemIdx++) {
    const item = parsed.itens[itemIdx];
    if (item.fonte !== 'PROPRIA' || !item.composicao_propria?.itens) continue;
    const compId = persistidas[itemIdx]?.id as string | undefined;
    if (!compId) continue;
    item.composicao_propria.itens.forEach((sub, i) => {
      subRows.push({
        composicao_extraida_id: compId,
        classe: sub.classe,
        codigo: sub.codigo ?? null,
        fonte: sub.fonte,
        descricao: sub.descricao,
        unidade: sub.unidade ?? null,
        coeficiente: sub.coeficiente,
        preco_unitario: sub.preco_unitario ?? null,
        preco_total: sub.preco_unitario != null
          ? sub.coeficiente * sub.preco_unitario
          : null,
        ordem: i,
      });
    });
  }
  if (subRows.length > 0) {
    const { error: subErr } = await admin
      .from('composicao_propria_itens')
      .insert(subRows);
    if (subErr) {
      console.error('[importar] composicao_propria_itens insert FAILED', subErr);
      return { error: `Falha ao gravar sub-itens: ${subErr.message}` };
    }
    console.log('[importar] sub-itens inseridos', {
      ms: Date.now() - t0,
      count: subRows.length,
    });
  }

  // Transições: rascunho/aguardando_extracao → extraindo → extracao_concluida → aguardando_revisao_humana
  if (licitacao.status === 'rascunho') {
    await admin.from('licitacoes').update({ status: 'aguardando_extracao' }).eq('id', licitacaoId);
  }
  if (['rascunho', 'aguardando_extracao'].includes(licitacao.status)) {
    await admin.from('licitacoes').update({ status: 'extraindo' }).eq('id', licitacaoId);
    await admin.from('licitacoes').update({ status: 'extracao_concluida' }).eq('id', licitacaoId);
  }
  await admin
    .from('licitacoes')
    .update({ status: 'aguardando_revisao_humana' })
    .eq('id', licitacaoId);
  console.log('[importar] status final', { ms: Date.now() - t0 });

  revalidatePath(`/licitacoes/${licitacaoId}`);
  console.log('[importar] done', {
    ms: Date.now() - t0,
    comps: compRows.length,
    subs: subRows.length,
  });

  return {
    ok: true,
    composicoes_inseridas: compRows.length,
    sub_itens_inseridos: subRows.length,
    json_reparado: jsonReparado,
  };
  } catch (e) {
    console.error('[importar] uncaught', { ms: Date.now() - t0, err: e });
    return { error: `Erro interno: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function cadastrarNoOrcafascio(
  licitacaoId: string,
): Promise<ActionResult & {
  grupo_descricao?: string;
  composicoes_criadas?: number;
  composicoes_puladas?: number;
  itens_adicionados?: number;
  warnings?: string[];
}> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Não autenticado.' };

  // Pega a credencial Orçafascio ativa (auth_type='api')
  const { data: creds, error: credErr } = await supabase
    .from('api_credentials')
    .select('id, metadata')
    .eq('provider', 'orcafascio')
    .eq('ativo', true);
  if (credErr) return { error: `Falha ao listar credenciais: ${credErr.message}` };
  const cred = (creds ?? []).find(
    (c) => (c.metadata as { auth_type?: string } | null)?.auth_type === 'api',
  );
  if (!cred) {
    return {
      error: 'Nenhuma credencial Orçafascio com auth_type="api" cadastrada. Cadastre uma no Vault primeiro.',
    };
  }

  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/orcafascio-cadastrar-edital`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      licitacao_id: licitacaoId,
      credential_id: cred.id,
    }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch {}

  revalidatePath(`/licitacoes/${licitacaoId}`);

  if (!res.ok) {
    return {
      error: `Cadastro falhou (${res.status}): ${(body.error as string) ?? text.slice(0, 200)}`,
      details: body.details ?? null,
    };
  }

  return {
    ok: true,
    grupo_descricao: body.grupo_descricao as string | undefined,
    composicoes_criadas: body.composicoes_criadas as number | undefined,
    composicoes_puladas: body.composicoes_puladas as number | undefined,
    itens_adicionados: body.itens_adicionados as number | undefined,
    warnings: body.warnings as string[] | undefined,
  };
}

export async function cadastrarOrcamentoCompleto(
  licitacaoId: string,
): Promise<ActionResult & {
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
}> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Não autenticado.' };

  // PASSO 1 IMPLÍCITO: se existem PROPRIA sem orcafascio_composition_id,
  // roda o cadastro no MyBase primeiro. Sem isso, as PROPRIA vão pro
  // orçamento com valor R$ 0,00. Usuário avançado pode pular usando o
  // botão azul direto, mas o caminho normal é fazer tudo em uma jogada.
  const { data: pendentes } = await supabase
    .from('composicoes_extraidas')
    .select('id')
    .eq('licitacao_id', licitacaoId)
    .eq('fonte', 'PROPRIA')
    .eq('tipo_linha', 'servico')
    .is('orcafascio_composition_id', null);

  let mybaseResult: {
    composicoes_criadas: number;
    itens_adicionados: number;
    warnings?: string[];
  } | undefined;

  if (pendentes && pendentes.length > 0) {
    // Garante status compatível com cadastrar-edital (criando_composicoes_edital).
    // Se status estiver em aguardando_revisao_humana, transiciona.
    const { data: licStatus } = await supabase
      .from('licitacoes')
      .select('status')
      .eq('id', licitacaoId)
      .maybeSingle();
    if (licStatus?.status === 'aguardando_revisao_humana') {
      await supabase
        .from('licitacoes')
        .update({ status: 'criando_composicoes_edital' })
        .eq('id', licitacaoId);
    }

    const mybase = await cadastrarNoOrcafascio(licitacaoId);
    if (mybase?.error) {
      return { error: `Falha no Passo 1 (MyBase): ${mybase.error}` };
    }
    mybaseResult = {
      composicoes_criadas: mybase.composicoes_criadas ?? 0,
      itens_adicionados: mybase.itens_adicionados ?? 0,
      warnings: mybase.warnings,
    };
  }

  // Busca a credencial WEB (auth_type='web') — diferente da API (auth_type='api')
  const { data: creds, error: credErr } = await supabase
    .from('api_credentials')
    .select('id, metadata')
    .eq('provider', 'orcafascio')
    .eq('ativo', true);
  if (credErr) return { error: `Falha ao listar credenciais: ${credErr.message}` };
  const cred = (creds ?? []).find(
    (c) => (c.metadata as { auth_type?: string } | null)?.auth_type === 'web',
  );
  if (!cred) {
    return {
      error: 'Nenhuma credencial Orçafascio com auth_type="web" cadastrada. Cadastre a senha do Orçafascio no Vault primeiro.',
    };
  }

  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/orcafascio-cadastrar-orcamento`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ licitacao_id: licitacaoId, credential_id: cred.id }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch {}

  revalidatePath(`/licitacoes/${licitacaoId}`);

  if (!res.ok) {
    return {
      error: `Cadastro do orçamento falhou (${res.status}): ${(body.error as string) ?? text.slice(0, 300)}`,
      details: body.details ?? null,
    };
  }

  return {
    ok: true,
    budget_id: body.budget_id as string | undefined,
    budget_url: body.budget_url as string | undefined,
    etapas_criadas: body.etapas_criadas as number | undefined,
    composicoes_criadas: body.composicoes_criadas as number | undefined,
    total_itens_batch: body.total_itens_batch as number | undefined,
    bdi: body.bdi as number | undefined,
    leis_sociais_horista: body.leis_sociais_horista as number | undefined,
    bancos_configurados: body.bancos_configurados as string[] | undefined,
    warnings: body.warnings as string[] | undefined,
    mybase: mybaseResult,
  };
}

// =============================================================================
// Proposta Readequada — desconto linear seletivo (regras de licitação)
// =============================================================================
// Regras aplicadas:
//   1. BDI da proposta = BDI do edital (NÃO se aplica desconto sobre o BDI).
//   2. Desconto X% NÃO incide sobre custos de mão de obra (insumos com
//      classe='MAO_DE_OBRA'). Só incide sobre materiais, equipamentos, etc.
//
// Math (por item):
//   custo_total_sem_BDI = pu_unitario_sem_BDI × quantidade
//   custo_MO  = Σ (coef × pu) dos insumos com classe=MAO_DE_OBRA × quantidade
//   custo_outros = custo_total_sem_BDI − custo_MO
//   desconto_R$ = custo_outros × (desconto%/100)
//   pu_proposta_sem_BDI = (custo_total_sem_BDI − desconto_R$) / quantidade
//   pu_proposta_com_BDI = pu_proposta_sem_BDI × (1 + BDI/100)
//
// Precisão da decomposição MO:
//   - PROPRIA: exato (temos os sub-itens com classe no nosso banco)
//   - SINAPI/SICRO/etc: estimado por banco via tabela hardcoded (próx iter:
//     buscar do Orçafascio). % conservador defensável em primeira aproximação.

const PCT_MO_DEFAULT_POR_BANCO: Record<string, number> = {
  // Aproximações públicas — em obras civis típicas. Ajustar por edital.
  SINAPI: 27,
  SICRO: 15,
  SICRO3: 15,
  SEINFRA: 25,
  ORSE: 25,
  SBC: 25,
  SETOP: 22,
  EMBASA: 25,
  OUTRA: 25,
};

interface PropostaItem {
  item_codigo: string;
  descricao: string;
  fonte: string | null;
  codigo: string | null;
  quantidade: number;
  unidade: string | null;
  pu_edital_sem_bdi: number;
  pu_edital_com_bdi: number;
  total_edital: number;
  custo_mo_item: number;
  custo_outros_item: number;
  pct_mo: number;
  pu_proposta_sem_bdi: number;
  pu_proposta_com_bdi: number;
  total_proposta: number;
  desconto_efetivo_item_pct: number;
  metodo_mo: 'exato_propria' | 'estimado_banco' | 'sem_mo';
  obs: string;
}

interface PropostaResult {
  ok?: boolean;
  error?: string;
  bdi_edital: number;
  desconto_solicitado_pct: number;
  total_edital_com_bdi: number;
  total_proposta_com_bdi: number;
  economia: number;
  desconto_efetivo_global_pct: number;
  custo_mo_preservado: number;
  custo_outros_descontavel: number;
  itens: PropostaItem[];
  alertas: string[];
}

// Calcula a proposta sem cadastrar no Orçafascio. Pode ser chamado várias
// vezes pra ajustar o desconto e ver o impacto antes de gerar.
export async function calcularProposta(
  licitacaoId: string,
  descontoPercentual: number,
): Promise<PropostaResult> {
  const empty: PropostaResult = {
    bdi_edital: 0,
    desconto_solicitado_pct: descontoPercentual,
    total_edital_com_bdi: 0,
    total_proposta_com_bdi: 0,
    economia: 0,
    desconto_efetivo_global_pct: 0,
    custo_mo_preservado: 0,
    custo_outros_descontavel: 0,
    itens: [],
    alertas: [],
  };
  if (!Number.isFinite(descontoPercentual) || descontoPercentual <= 0 || descontoPercentual >= 100) {
    return { ...empty, error: 'Desconto deve ser entre 0% e 100% (exclusivo).' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ...empty, error: 'Não autenticado.' };

  const admin = createAdminClient();

  const { data: lic } = await admin
    .from('licitacoes')
    .select('id, status, bdi_referencia_edital')
    .eq('id', licitacaoId)
    .maybeSingle();
  if (!lic) return { ...empty, error: 'Licitação não encontrada.' };

  const { data: extr } = await admin
    .from('extracoes_ocr')
    .select('json_corrigido, json_extraido')
    .eq('licitacao_id', licitacaoId)
    .in('status', ['sucesso', 'revisada_humano'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const cabecalho = ((extr?.json_corrigido ?? extr?.json_extraido) as
    { cabecalho?: { bdi_percentual?: number | string } } | null)?.cabecalho;
  const bdiEdital = Number(cabecalho?.bdi_percentual ?? lic.bdi_referencia_edital ?? 22);
  const bdiMul = 1 + bdiEdital / 100;

  const { data: comps } = await admin
    .from('composicoes_extraidas')
    .select(
      'id, item_codigo, descricao, fonte, codigo, quantidade, unidade, preco_unitario_sem_bdi, preco_unitario_com_bdi, preco_total, tipo_linha, ordem',
    )
    .eq('licitacao_id', licitacaoId)
    .eq('tipo_linha', 'servico')
    .order('ordem', { ascending: true });

  if (!comps || comps.length === 0) {
    return { ...empty, bdi_edital: bdiEdital, error: 'Nenhuma composição extraída.' };
  }

  // Pega TODOS os sub-itens das composições PROPRIA pra calcular MO exato
  const propriaIds = comps
    .filter((c) => c.fonte === 'PROPRIA')
    .map((c) => c.id);
  const subitensPorComp = new Map<string, Array<{ classe: string; coeficiente: number; preco_unitario: number | null }>>();
  if (propriaIds.length > 0) {
    const { data: subs } = await admin
      .from('composicao_propria_itens')
      .select('composicao_extraida_id, classe, coeficiente, preco_unitario')
      .in('composicao_extraida_id', propriaIds);
    for (const s of subs ?? []) {
      const k = s.composicao_extraida_id as string;
      if (!subitensPorComp.has(k)) subitensPorComp.set(k, []);
      subitensPorComp.get(k)!.push({
        classe: String(s.classe ?? ''),
        coeficiente: Number(s.coeficiente ?? 0),
        preco_unitario: s.preco_unitario != null ? Number(s.preco_unitario) : null,
      });
    }
  }

  const itens: PropostaItem[] = [];
  const alertas = new Set<string>();
  let totalEditalCom = 0;
  let totalPropostaCom = 0;
  let totalMOPreservado = 0;
  let totalOutrosDescontavel = 0;

  for (const c of comps) {
    const qty = Number(c.quantidade ?? 0);
    const puEditalSem = Number(c.preco_unitario_sem_bdi ?? 0);
    const puEditalCom = Number(c.preco_unitario_com_bdi ?? puEditalSem * bdiMul);
    const totalEditalItem = puEditalCom * qty;
    totalEditalCom += totalEditalItem;

    // Calcula % de mão de obra do item
    let pctMo = 0;
    let metodo: PropostaItem['metodo_mo'] = 'sem_mo';
    let obs = '';

    if (c.fonte === 'PROPRIA') {
      const subs = subitensPorComp.get(c.id) ?? [];
      const moSum = subs
        .filter((s) => s.classe === 'MAO_DE_OBRA')
        .reduce((s, x) => s + x.coeficiente * (x.preco_unitario ?? 0), 0);
      // O puEditalSem deveria ser ≈ Σ(coef*pu) dos sub-itens. Se for, dá o pct
      // exato. Senão, é melhor estimar como ratio.
      if (puEditalSem > 0) {
        pctMo = Math.min(100, (moSum / puEditalSem) * 100);
        metodo = 'exato_propria';
      } else {
        pctMo = PCT_MO_DEFAULT_POR_BANCO.OUTRA;
        metodo = 'estimado_banco';
        obs = 'PU edital zerado, usei % MO default';
      }
    } else if (c.fonte && c.fonte in PCT_MO_DEFAULT_POR_BANCO) {
      pctMo = PCT_MO_DEFAULT_POR_BANCO[c.fonte];
      metodo = 'estimado_banco';
      obs = `% MO estimado por banco ${c.fonte} (${pctMo}%) — não auditado item a item`;
      alertas.add(
        `Composições ${c.fonte}: % MO estimado por média do banco. Pra precisão total, buscar decomposição real no Orçafascio (próx iteração).`,
      );
    } else if (c.fonte) {
      pctMo = PCT_MO_DEFAULT_POR_BANCO.OUTRA;
      metodo = 'estimado_banco';
      obs = `Fonte ${c.fonte} não mapeada, usei ${pctMo}% MO default`;
      alertas.add(`Fonte "${c.fonte}" sem % MO calibrado — usado fallback ${pctMo}%.`);
    } else {
      // Sem fonte → assume sem MO (composição manual sem decomposição)
      pctMo = 0;
      metodo = 'sem_mo';
      obs = 'Sem fonte definida — desconto aplicado integralmente';
    }

    const custoTotalSemBdi = puEditalSem * qty;
    const custoMoItem = custoTotalSemBdi * (pctMo / 100);
    const custoOutrosItem = custoTotalSemBdi - custoMoItem;
    const descontoR$Item = custoOutrosItem * (descontoPercentual / 100);
    const custoTotalPropostaSemBdi = custoTotalSemBdi - descontoR$Item;
    const puPropostaSem = qty > 0 ? custoTotalPropostaSemBdi / qty : 0;
    const puPropostaCom = puPropostaSem * bdiMul;
    const totalPropostaItem = puPropostaCom * qty;
    totalPropostaCom += totalPropostaItem;
    totalMOPreservado += custoMoItem * bdiMul;
    totalOutrosDescontavel += custoOutrosItem * bdiMul;

    const descontoEfetivoItemPct = totalEditalItem > 0
      ? ((totalEditalItem - totalPropostaItem) / totalEditalItem) * 100
      : 0;

    itens.push({
      item_codigo: c.item_codigo,
      descricao: c.descricao,
      fonte: c.fonte,
      codigo: c.codigo,
      quantidade: qty,
      unidade: c.unidade,
      pu_edital_sem_bdi: puEditalSem,
      pu_edital_com_bdi: puEditalCom,
      total_edital: totalEditalItem,
      custo_mo_item: custoMoItem * bdiMul, // com BDI pra comparar com total
      custo_outros_item: custoOutrosItem * bdiMul,
      pct_mo: pctMo,
      pu_proposta_sem_bdi: puPropostaSem,
      pu_proposta_com_bdi: puPropostaCom,
      total_proposta: totalPropostaItem,
      desconto_efetivo_item_pct: descontoEfetivoItemPct,
      metodo_mo: metodo,
      obs,
    });
  }

  const economia = totalEditalCom - totalPropostaCom;
  const descontoEfetivoGlobalPct = totalEditalCom > 0
    ? (economia / totalEditalCom) * 100
    : 0;

  // Persiste no banco
  await admin
    .from('licitacoes')
    .update({
      desconto_percentual: descontoPercentual,
      valor_proposta_pavcon: totalPropostaCom,
    })
    .eq('id', licitacaoId);

  revalidatePath(`/licitacoes/${licitacaoId}`);

  return {
    ok: true,
    bdi_edital: bdiEdital,
    desconto_solicitado_pct: descontoPercentual,
    total_edital_com_bdi: totalEditalCom,
    total_proposta_com_bdi: totalPropostaCom,
    economia,
    desconto_efetivo_global_pct: descontoEfetivoGlobalPct,
    custo_mo_preservado: totalMOPreservado,
    custo_outros_descontavel: totalOutrosDescontavel,
    itens,
    alertas: Array.from(alertas),
  };
}

// Cadastra a proposta no Orçafascio: clona o orçamento base + aplica ajuste de valor.
// O valor final passado pro Orçafascio é o calculado pela nossa regra MO-aware
// (calcularProposta), garantindo que o total respeite "desconto não incide sobre MO".
// O Orçafascio aplica o ajuste linearmente — o total bate, mas a divisão interna
// por item segue o ajuste deles (desconta MO proporcionalmente). Documentamos isso.
export async function cadastrarPropostaOrcafascio(
  licitacaoId: string,
  descontoPercentual: number,
  /** Valor alvo direto da proposta (em reais, COM BDI). Se passado, sobrescreve
   * o cálculo MO-aware e o Orçafascio aplica ajustarValor exatamente nesse
   * número. Útil quando o orçamentista já sabe o valor que quer (ex: porque
   * o cálculo Pavcon não confere com o esperado, ou ele quer testar). */
  valorAlvoDireto?: number,
  /** WORKAROUND do bug Orçafascio: quando true, pula a chamada ajustarValor
   * (que corrompe o budget às vezes). Backend só copia o budget base.
   * O user aplica desconto manualmente no Orçafascio. Mais cliques mas
   * funciona 100%. */
  pularAjustarValor?: boolean,
): Promise<{
  ok?: boolean;
  error?: string;
  budget_id?: string;
  budget_url?: string;
  valor_aplicado?: number;
  warnings?: string[];
}> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Não autenticado.' };

  // 1) Calcula a proposta com regra MO (idempotente — pode rodar de novo).
  // SE veio valor alvo direto, ele tem prioridade sobre o cálculo.
  let valorPropostaFinal: number;
  if (Number.isFinite(valorAlvoDireto) && (valorAlvoDireto as number) > 0) {
    valorPropostaFinal = valorAlvoDireto as number;
  } else {
    const proposta = await calcularProposta(licitacaoId, descontoPercentual);
    if (proposta.error) return { error: `Falha no cálculo MO: ${proposta.error}` };
    valorPropostaFinal = (proposta as { total_proposta_com_bdi: number }).total_proposta_com_bdi;
  }

  // 2) Pega credencial WEB
  const { data: creds } = await supabase
    .from('api_credentials')
    .select('id, metadata')
    .eq('provider', 'orcafascio')
    .eq('ativo', true);
  const cred = (creds ?? []).find(
    (c) => (c.metadata as { auth_type?: string } | null)?.auth_type === 'web',
  );
  if (!cred) {
    return { error: 'Nenhuma credencial Orçafascio "web" cadastrada.' };
  }

  // 3) Chama Edge Function com o valor já MO-aware
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/orcafascio-cadastrar-proposta`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      licitacao_id: licitacaoId,
      credential_id: cred.id,
      desconto_percentual: descontoPercentual,
      valor_proposta: valorPropostaFinal,
      skip_ajustar_valor: pularAjustarValor === true,
    }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch {}

  revalidatePath(`/licitacoes/${licitacaoId}`);

  if (!res.ok) {
    return {
      error: `Cadastro falhou (${res.status}): ${(body.error as string) ?? text.slice(0, 300)}`,
    };
  }

  // MUDANÇA: edge function agora SEMPRE salva o budget_id (mesmo se
  // verificação falhar) porque o budget foi criado de fato — só a UI do
  // Orçafascio pra abrir tá com bug intermitente. Devolve ok:true com
  // warnings; UI mostra os warnings mas dá o link pro user testar.
  return {
    ok: true,
    budget_id: body.budget_id as string | undefined,
    budget_url: body.budget_url as string | undefined,
    valor_aplicado: body.valor_aplicado as number | undefined,
    warnings: body.warnings as string[] | undefined,
  };
}

// Gera CSV pronto pra abrir no Excel/Google Sheets com a proposta detalhada.
// Retorna string CSV (cliente faz o download via Blob).
// CSV com separador ; pra Excel pt-BR não confundir com decimal.
export async function exportPropostaCSV(
  licitacaoId: string,
  descontoPercentual: number,
): Promise<{ ok?: boolean; error?: string; csv?: string; filename?: string }> {
  const proposta = await calcularProposta(licitacaoId, descontoPercentual);
  if (proposta.error) return { error: proposta.error };

  const fmt = (n: number) => n.toFixed(2).replace('.', ',');
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;

  const lines: string[] = [];
  lines.push(
    [
      'Item',
      'Descrição',
      'Fonte',
      'Código',
      'Unidade',
      'Qtd',
      'PU Edital (com BDI)',
      'Total Edital',
      '% MO',
      'Método MO',
      'PU Proposta (com BDI)',
      'Total Proposta',
      'Desconto Efetivo %',
      'Observação',
    ].join(';'),
  );
  for (const it of proposta.itens) {
    lines.push(
      [
        esc(it.item_codigo),
        esc(it.descricao),
        esc(it.fonte ?? ''),
        esc(it.codigo ?? ''),
        esc(it.unidade ?? ''),
        fmt(it.quantidade),
        fmt(it.pu_edital_com_bdi),
        fmt(it.total_edital),
        fmt(it.pct_mo),
        esc(it.metodo_mo),
        fmt(it.pu_proposta_com_bdi),
        fmt(it.total_proposta),
        fmt(it.desconto_efetivo_item_pct),
        esc(it.obs),
      ].join(';'),
    );
  }
  lines.push('');
  lines.push(`"RESUMO";"";"";"";"";"";"";${fmt(proposta.total_edital_com_bdi)};"";"";"";${fmt(proposta.total_proposta_com_bdi)};${fmt(proposta.desconto_efetivo_global_pct)};"Economia: ${fmt(proposta.economia)}"`);
  lines.push(`"";;"BDI edital: ${fmt(proposta.bdi_edital)}%";"";"Desconto solicitado: ${fmt(descontoPercentual)}%";"";"";"";"";"";"";"";"";""`);
  lines.push(`"";;"MO preservada: ${fmt(proposta.custo_mo_preservado)}";"";"Outros descontáveis: ${fmt(proposta.custo_outros_descontavel)}";"";"";"";"";"";"";"";"";""`);

  // BOM UTF-8 pro Excel abrir acentos corretamente
  const csv = '﻿' + lines.join('\r\n');
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `proposta_${licitacaoId.slice(0, 8)}_${descontoPercentual.toString().replace('.', '_')}pct_${stamp}.csv`;

  return { ok: true, csv, filename };
}

// Limpa o estado do Orçafascio pra esta licitação e volta o status pra
// criando_composicoes_edital (onde o botão MyBase fica visível novamente).
// Útil quando alguma chamada Orçafascio falhou no meio e o usuário quer
// retentar do zero sem ter que pedir reset via SQL.
//
// IMPORTANTE: NÃO toca em composicoes_extraidas / extracoes_ocr (dados da
// extração). NÃO deleta nada do MyBase ou do orçamento no Orçafascio web —
// isso o usuário precisa fazer manualmente (ou via API key, futura feature).
export async function resetOrcafascio(licitacaoId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado.' };

  const admin = createAdminClient();

  // 1) Limpa orcafascio_composition_id das composições próprias (pra que
  //    botão MyBase consiga recriar do zero, sem skip de idempotência)
  await admin
    .from('composicoes_extraidas')
    .update({ orcafascio_composition_id: null })
    .eq('licitacao_id', licitacaoId);

  // 2) Invalida sessão web cacheada (força login fresco no próximo retry)
  const { data: creds } = await admin
    .from('api_credentials')
    .select('id, metadata')
    .eq('provider', 'orcafascio')
    .eq('ativo', true);
  const credWebId = (creds ?? []).find(
    (c) => (c.metadata as { auth_type?: string } | null)?.auth_type === 'web',
  )?.id;
  if (credWebId) {
    await admin
      .from('orcafascio_sessoes')
      .delete()
      .eq('credential_id', credWebId);
  }

  // 3) Volta status pra criando_composicoes_edital (botão 1 fica visível).
  //    State machine só permite voltar via 'erro' intermediário.
  await admin
    .from('licitacoes')
    .update({ status: 'erro' })
    .eq('id', licitacaoId);
  const { error: e2 } = await admin
    .from('licitacoes')
    .update({
      status: 'criando_composicoes_edital',
      fase1_concluida_em: null,
    })
    .eq('id', licitacaoId);
  if (e2) return { error: `Falha ao resetar status: ${e2.message}` };

  revalidatePath(`/licitacoes/${licitacaoId}`);
  return { ok: true };
}

export async function resetToDraft(licitacaoId: string): Promise<ActionResult> {
  // Volta pro estado inicial: status='rascunho' + apaga extracoes/composicoes
  // pra o user poder re-extrair do zero. Útil quando JSON do LLM veio
  // muito errado e precisa começar de novo.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado.' };
  const admin = createAdminClient();

  // Ordem: composicoes_extraidas antes de extracoes_ocr (FK NO ACTION).
  // composicao_propria_itens cascade-deleta com composicoes_extraidas.
  await admin.from('composicoes_extraidas').delete().eq('licitacao_id', licitacaoId);
  await admin.from('extracoes_ocr').delete().eq('licitacao_id', licitacaoId);
  // State machine: 'rascunho' só é alcançável via 'erro' a partir de
  // status downstream (aguardando_revisao_humana, fase1_concluida, etc).
  // Mesmo truque do resetToReview — passa por 'erro' (sempre permitido) e
  // depois vai pra 'rascunho' (sempre permitido a partir de 'erro').
  await admin
    .from('licitacoes')
    .update({ status: 'erro' })
    .eq('id', licitacaoId);
  // Zera campos preenchidos pelo cadastramento
  const { error } = await admin
    .from('licitacoes')
    .update({
      status: 'rascunho',
      fase1_concluida_em: null,
      orcafascio_orcamento_base_id: null,
      orcafascio_orcamento_base_codigo: null,
      cadastro_resumo: null,
    })
    .eq('id', licitacaoId);
  if (error) return { error: error.message };
  revalidatePath(`/licitacoes/${licitacaoId}`);
  return { ok: true };
}

/**
 * Volta pra etapa de revisão humana mantendo o JSON extraído.
 * Útil quando o cadastramento gerou problemas e o orçamentista quer
 * ajustar item específico do JSON sem perder o que já foi feito.
 *
 * Faz: zera cadastramento (composition_ids, budget_id, resumo) + volta status
 * pra 'aguardando_revisao_humana'. Preserva extracoes_ocr + composicoes_extraidas.
 */
export async function resetToReview(licitacaoId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Não autenticado.' };
  const admin = createAdminClient();

  // Limpa IDs de cadastramento mas mantém extração e composições extraídas
  await admin
    .from('composicoes_extraidas')
    .update({ orcafascio_composition_id: null })
    .eq('licitacao_id', licitacaoId);
  // State machine: precisa transitar via 'erro' pra chegar em
  // aguardando_revisao_humana de fase1_concluida (não há transição direta)
  await admin
    .from('licitacoes')
    .update({ status: 'erro' })
    .eq('id', licitacaoId);
  const { error } = await admin
    .from('licitacoes')
    .update({
      status: 'aguardando_revisao_humana',
      fase1_concluida_em: null,
      orcafascio_orcamento_base_id: null,
      orcafascio_orcamento_base_codigo: null,
      cadastro_resumo: null,
    })
    .eq('id', licitacaoId);
  if (error) return { error: error.message };
  // Invalida sessão web pra próximo cadastro fazer login fresco
  const { data: creds } = await admin
    .from('api_credentials')
    .select('id, metadata')
    .eq('provider', 'orcafascio')
    .eq('ativo', true);
  const credWebId = (creds ?? []).find(
    (c) => (c.metadata as { auth_type?: string } | null)?.auth_type === 'web',
  )?.id;
  if (credWebId) {
    await admin
      .from('orcafascio_sessoes')
      .delete()
      .eq('credential_id', credWebId);
  }
  revalidatePath(`/licitacoes/${licitacaoId}`);
  return { ok: true };
}

// Tipo compartilhado com a página
export interface ExtractedItem {
  item_codigo: string;
  nivel: number;
  pai: string | null;
  tipo: 'grupo' | 'servico';
  codigo: string | null;
  fonte: string | null;
  descricao: string;
  unidade: string | null;
  quantidade: number | null;
  preco_unitario_sem_bdi: number | null;
  preco_unitario_com_bdi: number | null;
  preco_total: number | null;
  composicao_propria?: {
    itens: Array<{
      classe: string;
      codigo: string | null;
      fonte: string;
      descricao: string;
      unidade: string | null;
      coeficiente: number;
      preco_unitario: number | null;
    }>;
  };
}
