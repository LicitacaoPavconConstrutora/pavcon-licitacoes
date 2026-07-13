// =============================================================================
// Edge Function: extracao-edital
// =============================================================================
// Pipeline:
//   1. Lê arquivo de licitacao_arquivos (precisa estar em Storage 'editais')
//   2. Valida licitacao.status (rascunho ou aguardando_extracao)
//   3. Resolve credencial Gemini ativa (provider='gemini') e o API key do Vault
//   4. Transição: licitacao.status = 'extraindo'
//   5. Cria extracoes_ocr (status='processando')
//   6. Baixa PDF do Storage, base64, manda pro Gemini 2.5 Pro
//   7. Parseia JSON, valida shape mínimo
//   8. Persiste:
//        extracoes_ocr (status='sucesso', json_extraido, custo, tokens)
//        composicoes_extraidas (uma linha por item)
//        composicao_propria_itens (quando fonte=PROPRIA)
//   9. Transição: 'extracao_concluida' → 'aguardando_revisao_humana'
//
// Erros de qualquer etapa após (4) viram extracoes_ocr.status='falha' +
// licitacao.status='erro'.
// =============================================================================

import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import {
  getServiceRoleClient,
  HttpError,
  requireAuthenticatedUser,
} from '../_shared/supabase.ts';
// Edge Function usa Gemini 2.5 Pro como padrão (key cadastrada + cota free razoável).
// Pra trocar pra Claude (Opus), basta cadastrar credencial Anthropic e mudar
// LLM_PROVIDER abaixo pra 'anthropic' + importar de '../_shared/anthropic.ts'.
import { callGemini, GeminiError } from '../_shared/gemini.ts';
import { callClaude, type ClaudeContent } from '../_shared/anthropic.ts';
import { PROMPT_VERSION, SYSTEM_PROMPT } from './prompt.ts';

// gemini-2.5-pro (definitivo). Tentamos 3.1-pro-preview duas vezes mas com
// thinking mode ele estoura o cap de 400s do EdgeRuntime em PDFs reais —
// audit log fica vazio, processo morto antes de retornar. 2.5 Pro completa
// em 120-180s típico. JSON corrompido eventual (~10% das vezes) é tratado
// pelas 3 camadas de recuperação (v8): JSON.parse direto + jsonrepair +
// truncate-to-last-valid. Mais robusto pro pipeline atual.
const GEMINI_MODEL = 'gemini-2.5-pro';
// Claude Sonnet 4.5 (snapshot 20250929, mesmo usado no claudio-chat).
// Boa qualidade pra parsing de planilhas complexas, custo $3/$15 por M
// tokens. Anthropic API exige ID com versão completa — nomes curtos
// (claude-sonnet-4-5) retornam 400 "invalid model".
const CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';
const LLM_PROVIDER = 'gemini';
const VALID_START_STATUSES = new Set(['rascunho', 'aguardando_extracao']);

interface RequestBody {
  // Modo legado (1 arquivo). Continua suportado.
  arquivo_id?: string;
  // Modo novo (todos os arquivos da licitação). Preferido.
  licitacao_id?: string;
  trace_id?: string;
  // Escolha do provedor LLM. Default 'gemini' (mais barato, ~85% dos casos).
  // 'anthropic' usa Claude Sonnet 4.5 — melhor parsing de planilhas complexas,
  // ~5× mais caro mas raramente trunca. Requer credencial anthropic ativa.
  provider?: 'gemini' | 'anthropic';
}

interface ExtractedItem {
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

interface ExtractedJson {
  cabecalho: Record<string, unknown>;
  itens: ExtractedItem[];
}

function validateExtractedJson(obj: unknown): ExtractedJson {
  if (!obj || typeof obj !== 'object') {
    throw new Error('JSON do Gemini não é objeto.');
  }
  const o = obj as Record<string, unknown>;
  if (!o.cabecalho || typeof o.cabecalho !== 'object') {
    throw new Error('Faltou "cabecalho" no JSON.');
  }
  if (!Array.isArray(o.itens)) {
    throw new Error('Faltou "itens" (array) no JSON.');
  }
  return { cabecalho: o.cabecalho as Record<string, unknown>, itens: o.itens as ExtractedItem[] };
}

function uint8ToBase64(bytes: Uint8Array): string {
  // Converte sem estourar pilha (PDFs grandes).
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

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

  const traceId = body.trace_id ?? crypto.randomUUID();
  const admin = getServiceRoleClient();
  let licitacaoId: string | null = body.licitacao_id?.trim() ?? null;
  let extracaoId: string | null = null;
  // Provider escolhido pelo usuário: 'gemini' (default) ou 'anthropic'.
  const providerEscolhido: 'gemini' | 'anthropic' =
    body.provider === 'anthropic' ? 'anthropic' : 'gemini';

  try {
    const user = await requireAuthenticatedUser(req);

    // ---- 1) Carrega arquivos da licitação ----------------------------------
    // Aceita 2 modos:
    //   - body.licitacao_id → pega TODOS os PDFs da licitação
    //   - body.arquivo_id   → modo legado, 1 arquivo só
    if (!licitacaoId && body.arquivo_id) {
      const { data: arquivoLeg, error: arqLegErr } = await admin
        .from('licitacao_arquivos')
        .select('licitacao_id')
        .eq('id', body.arquivo_id.trim())
        .maybeSingle();
      if (arqLegErr || !arquivoLeg) {
        return errorResponse(404, 'arquivo_id não encontrado.', arqLegErr?.message);
      }
      licitacaoId = arquivoLeg.licitacao_id;
    }
    if (!licitacaoId) {
      return errorResponse(400, 'licitacao_id (ou arquivo_id) é obrigatório.');
    }

    const { data: arquivos, error: arquivosErr } = await admin
      .from('licitacao_arquivos')
      .select(
        'id, licitacao_id, storage_bucket, storage_path, mime_type, filename_original, size_bytes, tipo',
      )
      .eq('licitacao_id', licitacaoId)
      .order('created_at', { ascending: true });
    if (arquivosErr) {
      return errorResponse(500, 'Falha ao ler licitacao_arquivos.', arquivosErr.message);
    }
    if (!arquivos || arquivos.length === 0) {
      return errorResponse(404, 'Nenhum arquivo encontrado pra esta licitação.');
    }
    const naoPdf = arquivos.find((a) => a.mime_type !== 'application/pdf');
    if (naoPdf) {
      return errorResponse(
        415,
        `Arquivo "${naoPdf.filename_original}" tem MIME ${naoPdf.mime_type}, só PDF é aceito.`,
      );
    }

    const { data: licitacao, error: licitErr } = await admin
      .from('licitacoes')
      .select('id, status')
      .eq('id', licitacaoId)
      .maybeSingle();
    if (licitErr || !licitacao) {
      return errorResponse(500, 'Falha ao carregar licitação.', licitErr?.message);
    }
    if (!VALID_START_STATUSES.has(licitacao.status)) {
      return errorResponse(
        409,
        `Licitação está em "${licitacao.status}", esperado um de: ${[...VALID_START_STATUSES].join(', ')}.`,
      );
    }

    // ---- 2) Resolve credencial Gemini --------------------------------------
    const { data: gCreds, error: gCredsErr } = await admin
      .from('api_credentials')
      .select('id, vault_secret_id, ativo, escopo, owner_id')
      .eq('provider', 'gemini')
      .eq('ativo', true)
      .order('escopo', { ascending: true });
    if (gCredsErr) {
      return errorResponse(500, 'Falha ao listar credenciais Gemini.', gCredsErr.message);
    }
    const gCred = gCreds?.find((c) =>
      c.escopo === 'organizacional' || c.owner_id === user.id
    );
    if (!gCred) {
      return errorResponse(
        422,
        'Nenhuma credencial Gemini ativa cadastrada (provider="gemini").',
      );
    }
    const { data: apiKey, error: vaultErr } = await admin.rpc(
      'read_vault_secret',
      { p_secret_id: gCred.vault_secret_id },
    );
    if (vaultErr || typeof apiKey !== 'string' || !apiKey) {
      return errorResponse(500, 'Vault não retornou a API key do Gemini.', vaultErr?.message);
    }

    // ---- 2.5) Configuração Claude: proxy local OU API key Anthropic --------
    // Quando provider='anthropic', prefere a env CLAUDIO_PROXY_URL+TOKEN
    // (subscription Claude Max via Claude Code CLI rodando na máquina do
    // orçamentista). Sem proxy, cai pra API key Anthropic (créditos próprios).
    // Sem nenhum dos dois, retorna 422.
    let anthropicApiKey: string | null = null;
    let claudioProxyUrl: string | null = null;
    let claudioProxyToken: string | null = null;
    if (providerEscolhido === 'anthropic') {
      claudioProxyUrl = Deno.env.get('CLAUDIO_PROXY_URL') ?? null;
      claudioProxyToken = Deno.env.get('CLAUDIO_PROXY_TOKEN') ?? null;

      if (!claudioProxyUrl) {
        // Fallback pra API key direta
        const { data: aCreds, error: aCredsErr } = await admin
          .from('api_credentials')
          .select('id, vault_secret_id, ativo, escopo, owner_id')
          .eq('provider', 'anthropic')
          .eq('ativo', true)
          .order('escopo', { ascending: true });
        if (aCredsErr) {
          return errorResponse(500, 'Falha ao listar credenciais Anthropic.', aCredsErr.message);
        }
        const aCred = aCreds?.find((c) =>
          c.escopo === 'organizacional' || c.owner_id === user.id
        );
        if (!aCred) {
          return errorResponse(
            422,
            'Sem CLAUDIO_PROXY_URL e sem credencial Anthropic ativa. Configure uma das duas.',
          );
        }
        const { data: aKey, error: aVaultErr } = await admin.rpc('read_vault_secret', {
          p_secret_id: aCred.vault_secret_id,
        });
        if (aVaultErr || typeof aKey !== 'string' || !aKey) {
          return errorResponse(500, 'Vault não retornou a API key Anthropic.', aVaultErr?.message);
        }
        anthropicApiKey = aKey;
      }
    }

    // ---- 3) Transição: rascunho → aguardando_extracao (se preciso) → extraindo
    // A máquina de estados (validate_licitacao_status_transition) exige passar
    // por aguardando_extracao antes de extraindo.
    if (licitacao.status === 'rascunho') {
      const { error: stPre } = await admin
        .from('licitacoes')
        .update({ status: 'aguardando_extracao' })
        .eq('id', licitacaoId);
      if (stPre) {
        return errorResponse(500, 'Falha ao transicionar rascunho → aguardando_extracao.', stPre.message);
      }
    }
    const { error: stT1 } = await admin
      .from('licitacoes')
      .update({ status: 'extraindo' })
      .eq('id', licitacaoId);
    if (stT1) {
      return errorResponse(500, 'Falha ao transicionar para extraindo.', stT1.message);
    }

    // ---- 3.5) AUTO-CLEANUP: limpa composicoes_extraidas antigas -------------
    // PADRÃO DETECTADO (jun/2026, SEFIR 02): quando o orçamentista reextrai
    // uma licitação, as composicoes_extraidas antigas continuam com
    // orcafascio_composition_id setado. O cadastro_edital vê esses IDs como
    // "idempotente" e PULA as composições — orçamento final fica parcial
    // ("Já cadastradas: 16, Itens criados: 15" → total errado).
    //
    // Fix: toda extração nova é tabula rasa. Apaga composicoes_extraidas +
    // composicao_propria_itens da licitação. O agente "aprende" desse padrão
    // sem precisar do orçamentista lembrar de resetar manualmente.
    //
    // Composicao_propria_itens cai por cascata (FK ON DELETE CASCADE).
    const { error: cleanupErr } = await admin
      .from('composicoes_extraidas')
      .delete()
      .eq('licitacao_id', licitacaoId);
    if (cleanupErr) {
      console.error(
        `[extracao-edital] auto-cleanup falhou (não fatal): ${cleanupErr.message}`,
      );
      // Não aborta — cadastro pode acontecer com dados misturados, mas o
      // user pode ver e corrigir manualmente.
    }

    // arquivo_id principal: o primeiro de tipo planilha_orcamentaria,
    // ou o primeiro arquivo em geral
    const arquivoPrincipal =
      arquivos.find((a) => a.tipo === 'planilha_orcamentaria') ?? arquivos[0];

    const { data: extr, error: extrErr } = await admin
      .from('extracoes_ocr')
      .insert({
        licitacao_id: licitacaoId,
        arquivo_id: arquivoPrincipal.id,
        llm_provider: providerEscolhido,
        llm_model: providerEscolhido === 'anthropic' ? CLAUDE_MODEL : GEMINI_MODEL,
        prompt_versao: PROMPT_VERSION,
        status: 'processando',
      })
      .select('id')
      .single();
    if (extrErr || !extr) {
      return errorResponse(500, 'Falha ao criar extracoes_ocr.', extrErr?.message);
    }
    extracaoId = extr.id;

    // =========================================================================
    // ASYNC BACKGROUND: tudo daqui pra baixo roda DEPOIS da gente retornar 202
    // pro cliente. EdgeRuntime.waitUntil mantém a função viva por até ~400s
    // (vs 150s do request timeout). Necessário pq gemini-3.1-pro-preview com
    // thinking tokens leva ~150-300s pra extrair edital grande, e antes a
    // chamada morria silenciosamente no meio.
    //
    // O cliente recebe 202 com o extracao_id e fica polling o status do
    // registro extracoes_ocr até virar 'sucesso' ou 'falha'.
    // =========================================================================
    const runExtractionAsync = async () => {
      try {
    // ---- 4) Baixa TODOS PDFs + chama Gemini --------------------------------
    const startedAt = Date.now();

    const tipoLabel: Record<string, string> = {
      planilha_orcamentaria: 'Planilha orçamentária (principal)',
      memorial_descritivo: 'Memorial descritivo / composições',
      projeto_tecnico: 'Projeto técnico',
      edital: 'Edital (texto)',
      anexo: 'Anexo (BDI, leis sociais ou outro)',
    };

    // Texto introdutório quando há mais de um PDF (mesma copy nos 2 providers)
    const introMultiArquivo = arquivos.length > 1
      ? `\nESTE EDITAL FOI ENVIADO EM ${arquivos.length} ARQUIVOS. A ordem dos PDFs anexados abaixo é:\n` +
        arquivos.map((a, i) =>
          `  [${i + 1}] ${tipoLabel[a.tipo] ?? a.tipo} — ${a.filename_original}`
        ).join('\n') +
        '\nLeia todos antes de produzir o JSON. Use a planilha orçamentária como fonte primária dos itens, e o memorial/anexos pra preencher cabecalho (BDI, leis sociais, desoneração) e detalhes de composições próprias.\n'
      : '';

    // Baixa todos os PDFs em base64 uma única vez (compartilhado entre providers)
    const pdfsBase64: Array<{ filename: string; b64: string }> = [];
    for (const a of arquivos) {
      const { data: blob, error: dlErr } = await admin
        .storage
        .from(a.storage_bucket)
        .download(a.storage_path);
      if (dlErr || !blob) {
        throw new Error(`Falha ao baixar "${a.filename_original}" do Storage: ${dlErr?.message ?? 'sem dado'}`);
      }
      const buffer = new Uint8Array(await blob.arrayBuffer());
      pdfsBase64.push({ filename: a.filename_original, b64: uint8ToBase64(buffer) });
    }

    // Chama o provider escolhido. Ambos retornam { text } pra o pipeline
    // de parse/validação ser identico abaixo. Usage normalizado pra
    // {promptTokenCount, candidatesTokenCount} (formato Gemini histórico)
    // pra não precisar mexer no UPDATE de extracoes_ocr abaixo.
    let resultText: string | null;
    let resultUsage = { promptTokenCount: 0, candidatesTokenCount: 0 };
    let resultCustoUsd = 0;
    if (providerEscolhido === 'anthropic' && claudioProxyUrl) {
      // Caminho A: proxy local (Claude Code CLI com sub Max). Usa fluxo
      // ASSÍNCRONO porque Cloudflare Quick Tunnel mata HTTP requests em 100s
      // e Claude CLI extrai em 3-8 min. Proxy responde com job_id na hora,
      // a gente faz polling pra esperar terminar.
      const proxyBase = claudioProxyUrl.replace(/\/$/, '');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (claudioProxyToken) headers['Authorization'] = `Bearer ${claudioProxyToken}`;

      const startResp = await fetch(`${proxyBase}/extract`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          system: SYSTEM_PROMPT,
          user_intro: introMultiArquivo,
          pdfs: pdfsBase64.map((p) => ({ filename: p.filename, b64: p.b64 })),
          trailing_instruction:
            'Responda APENAS com o JSON do edital extraído, sem texto antes ou depois. Comece com `{` e termine com `}`.',
        }),
      });
      const startJson = await startResp.json().catch(() => ({}));
      if (!startResp.ok || !startJson.job_id) {
        throw new Error(
          `Cláudio proxy /extract POST falhou (${startResp.status}): ${startJson.error ?? 'sem job_id'}`,
        );
      }
      const jobId = startJson.job_id;
      console.log(`[extracao-edital] proxy job=${jobId} iniciado, polling…`);

      // Polling: até 12 min (720s) total, com backoff curto
      const MAX_POLL_MS = 720_000;
      const POLL_INTERVAL_MS = 5000;
      const pollStarted = Date.now();
      let proxyText: string | null = null;
      while (Date.now() - pollStarted < MAX_POLL_MS) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const pollResp = await fetch(`${proxyBase}/extract/${jobId}`, { headers });
        if (!pollResp.ok) {
          // 404 = job expirou; outros 5xx = tunnel/proxy off
          throw new Error(`Cláudio proxy poll falhou (${pollResp.status})`);
        }
        const pollJson = await pollResp.json();
        if (pollJson.status === 'done') {
          proxyText = pollJson.text ?? '';
          console.log(`[extracao-edital] proxy job=${jobId} done em ${pollJson.duration_ms}ms`);
          break;
        }
        if (pollJson.status === 'error') {
          throw new Error(`Cláudio CLI falhou: ${pollJson.error}`);
        }
        // status: 'queued' ou 'running' → continua polling
      }
      if (proxyText === null) {
        throw new Error(`Cláudio proxy: timeout aguardando job (>${MAX_POLL_MS / 1000}s).`);
      }
      resultText = proxyText;
      resultUsage = { promptTokenCount: 0, candidatesTokenCount: 0 };
      resultCustoUsd = 0;
    } else if (providerEscolhido === 'anthropic') {
      // Caminho B: Anthropic API direta (consome créditos console.anthropic.com)
      const claudeUserContent: ClaudeContent[] = [];
      if (introMultiArquivo) claudeUserContent.push({ type: 'text', text: introMultiArquivo });
      for (const pdf of pdfsBase64) {
        claudeUserContent.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdf.b64 },
        });
      }
      claudeUserContent.push({
        type: 'text',
        text: 'Responda APENAS com o JSON do edital extraído, sem texto antes ou depois. Comece com `{` e termine com `}`.',
      });
      const r = await callClaude({
        model: CLAUDE_MODEL,
        apiKey: anthropicApiKey!,
        systemPrompt: SYSTEM_PROMPT,
        userContent: claudeUserContent,
        maxTokens: 16000,
        temperature: 0.1,
        admin,
        callerUserId: user.id,
        licitacaoId,
        traceId,
      });
      resultText = r.text;
      resultUsage = {
        promptTokenCount: r.usage.input_tokens ?? 0,
        candidatesTokenCount: r.usage.output_tokens ?? 0,
      };
      resultCustoUsd = r.estimatedCostUsd;
    } else {
      // Gemini: parts levam system prompt + intro + PDFs como inlineData.
      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
        { text: SYSTEM_PROMPT },
      ];
      if (introMultiArquivo) parts.push({ text: introMultiArquivo });
      for (const pdf of pdfsBase64) {
        parts.push({ inlineData: { mimeType: 'application/pdf', data: pdf.b64 } });
      }
      const r = await callGemini({
        model: GEMINI_MODEL,
        apiKey,
        parts,
        responseJson: true,
        temperature: 0.1,
        admin,
        callerUserId: user.id,
        licitacaoId,
        traceId,
      });
      resultText = r.text;
      resultUsage = {
        promptTokenCount: r.usage.promptTokenCount ?? 0,
        candidatesTokenCount: r.usage.candidatesTokenCount ?? 0,
      };
      resultCustoUsd = r.estimatedCostUsd;
    }
    // Resto do código espera result.text/usage/estimatedCostUsd —
    // mantém compatibilidade com o UPDATE de extracoes_ocr abaixo.
    const result = {
      text: resultText,
      usage: resultUsage,
      estimatedCostUsd: resultCustoUsd,
    };
    const duracaoMs = Date.now() - startedAt;

    // ---- 5) Parse + validação --------------------------------------------------
    function stripCodeFences(s: string): string {
      const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m) return m[1].trim();
      return s.trim();
    }

    // Recuperação resiliente do JSON do Gemini:
    // 1) JSON.parse direto
    // 2) jsonrepair (corrige aspas faltando, vírgulas finais, etc — comum em LLM)
    // 3) Truncar ao último item válido em `itens: [...]` (fallback de emergência
    //    — preserva o que deu pra extrair mesmo com syntax error no meio)
    //
    // Observação: o passo (3) é destrutivo (perde os items após o erro), mas
    // 99% melhor que descartar tudo e exigir re-extração manual. Item que
    // ficou trunco vira warning na metadata.extracao_warnings.
    async function tentarParse(textOriginal: string): Promise<{
      obj: unknown;
      warnings: string[];
    }> {
      const cleaned = stripCodeFences(textOriginal);
      const warnings: string[] = [];

      // (1) Direto
      try {
        return { obj: JSON.parse(cleaned), warnings };
      } catch (e1) {
        warnings.push(
          `JSON do Gemini não parseou direto (${e1 instanceof Error ? e1.message.slice(0, 120) : 'erro'}). Tentando jsonrepair…`,
        );
      }

      // (2) jsonrepair
      try {
        const { jsonrepair } = await import('https://esm.sh/jsonrepair@3.12.0');
        const repaired = jsonrepair(cleaned);
        const obj = JSON.parse(repaired);
        warnings.push('JSON recuperado via jsonrepair (havia vírgulas/aspas inconsistentes).');
        return { obj, warnings };
      } catch (e2) {
        warnings.push(
          `jsonrepair também falhou (${e2 instanceof Error ? e2.message.slice(0, 120) : 'erro'}). Tentando truncar ao último item válido…`,
        );
      }

      // (3) Truncar manualmente ao último item válido
      // Estratégia: localizar `"itens": [` e iterar fechando `]}` em cada
      // posição de `}, {` até achar prefixo que valida.
      const itensIdx = cleaned.indexOf('"itens"');
      if (itensIdx === -1) {
        throw new Error('JSON do Gemini sem "itens" — não dá pra recuperar nada.');
      }
      const arrStart = cleaned.indexOf('[', itensIdx);
      if (arrStart === -1) {
        throw new Error('JSON do Gemini sem array de itens — não dá pra recuperar.');
      }
      // Procura todos os candidatos `}, {` no array — cada um marca o fim de
      // um item. Tenta do mais recente pro mais antigo até parsear OK.
      const boundaries: number[] = [];
      let pos = arrStart;
      while (true) {
        const next = cleaned.indexOf('},', pos + 1);
        if (next === -1) break;
        boundaries.push(next + 1); // posição depois do `}` (antes da vírgula)
        pos = next;
      }
      // Tenta truncar e fechar como `]}`. Do último candidato pro primeiro.
      for (let i = boundaries.length - 1; i >= 0; i--) {
        const truncado = cleaned.slice(0, boundaries[i]) + ']}';
        try {
          const obj = JSON.parse(truncado);
          warnings.push(
            `JSON truncado ao último item válido (${boundaries.length - i} item(ns) perdidos a partir da posição ~${boundaries[i]}). Re-extraia o JSON se precisar do detalhamento completo dos últimos items.`,
          );
          return { obj, warnings };
        } catch {
          // tenta o anterior
        }
      }

      throw new Error(
        `JSON do Gemini totalmente irrecuperável após 3 tentativas. ` +
        `Início: ${cleaned.slice(0, 200)}`,
      );
    }

    let parsed: ExtractedJson;
    const extracaoWarnings: string[] = [];
    try {
      const { obj, warnings } = await tentarParse(result.text!);
      extracaoWarnings.push(...warnings);
      parsed = validateExtractedJson(obj);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      throw new Error(`JSON do Gemini inválido: ${msg}. Início: ${result.text?.slice(0, 200)}`);
    }

    // ---- 6) Persistir composições -------------------------------------------
    // PADRÃO DETECTADO (jul/2026): planilhas com múltiplos blocos/etapas às
    // vezes reiniciam ou repetem a numeração (ex: "1.1" aparece em ETAPA 1 e
    // ETAPA 2 do mesmo edital), e o Gemini ocasionalmente repete um
    // item_codigo por erro de leitura de tabela complexa. Como
    // composicoes_extraidas tem UNIQUE(licitacao_id, item_codigo), qualquer
    // duplicata dentro do próprio lote derrubava o INSERT inteiro (todos os
    // itens, não só o duplicado) e a extração inteira falhava.
    // Fix: desambigua duplicatas dentro do lote adicionando um sufixo
    // "#N" e guarda o código original em metadata pra auditoria/revisão.
    const codigoSeen = new Map<string, number>();
    const codigosDuplicados = new Set<string>();
    for (const item of parsed.itens) {
      const n = (codigoSeen.get(item.item_codigo) ?? 0) + 1;
      codigoSeen.set(item.item_codigo, n);
      if (n > 1) codigosDuplicados.add(item.item_codigo);
    }
    if (codigosDuplicados.size > 0) {
      extracaoWarnings.push(
        `item_codigo duplicado no lote extraído: ${[...codigosDuplicados].join(', ')}. ` +
        `Duplicatas foram desambiguadas com sufixo "#N" (código original em metadata.item_codigo_original) — revise manualmente.`,
      );
    }
    const codigoOcorrencia = new Map<string, number>();
    const composicoesRows = parsed.itens.map((item, idx) => {
      const ocorrencia = (codigoOcorrencia.get(item.item_codigo) ?? 0) + 1;
      codigoOcorrencia.set(item.item_codigo, ocorrencia);
      const itemCodigoFinal =
        ocorrencia > 1 ? `${item.item_codigo}#${ocorrencia}` : item.item_codigo;
      return {
        licitacao_id: licitacaoId!,
        extracao_id: extracaoId!,
        item_codigo: itemCodigoFinal,
        item_nivel: item.nivel,
        item_pai_codigo: item.pai,
        tipo_linha: item.tipo,
        codigo: item.codigo,
        fonte: item.fonte,
        descricao: item.descricao,
        unidade: item.unidade,
        quantidade: item.quantidade,
        preco_unitario_sem_bdi: item.preco_unitario_sem_bdi,
        preco_unitario_com_bdi: item.preco_unitario_com_bdi,
        preco_total: item.preco_total,
        ordem: idx,
        metadata: ocorrencia > 1 ? { item_codigo_original: item.item_codigo } : {},
      };
    });

    if (composicoesRows.length > 0) {
      // upsert (não insert puro) como cinto-e-suspensório: se o auto-cleanup
      // do passo 3.5 falhar silenciosamente (é "não fatal" por design),
      // sobrescreve a linha antiga em vez de colidir com a mesma unique
      // constraint (licitacao_id, item_codigo).
      const { error: cErr } = await admin
        .from('composicoes_extraidas')
        .upsert(composicoesRows, { onConflict: 'licitacao_id,item_codigo' });
      if (cErr) {
        throw new Error(`Falha ao gravar composicoes_extraidas: ${cErr.message}`);
      }
    }

    // Pega de volta os ids pra montar composicao_propria_itens (mantém ordem).
    // Pareado por índice (ordem 0..n-1), não por item_codigo — códigos podem
    // ter sido desambiguados acima e deixar de ser únicos por si só.
    const { data: composicoesPersistidas, error: cpErr } = await admin
      .from('composicoes_extraidas')
      .select('id')
      .eq('licitacao_id', licitacaoId!)
      .eq('extracao_id', extracaoId!)
      .order('ordem');
    if (cpErr) {
      throw new Error(`Falha ao reler composicoes_extraidas: ${cpErr.message}`);
    }

    const subItens: Array<Record<string, unknown>> = [];
    for (let i = 0; i < parsed.itens.length; i++) {
      const item = parsed.itens[i];
      if (item.fonte !== 'PROPRIA' || !item.composicao_propria?.itens) continue;
      const compId = composicoesPersistidas?.[i]?.id;
      if (!compId) continue;
      item.composicao_propria.itens.forEach((sub, idx) => {
        subItens.push({
          composicao_extraida_id: compId,
          classe: sub.classe,
          codigo: sub.codigo,
          fonte: sub.fonte,
          descricao: sub.descricao,
          unidade: sub.unidade,
          coeficiente: sub.coeficiente,
          preco_unitario: sub.preco_unitario,
          preco_total: sub.preco_unitario != null
            ? sub.coeficiente * sub.preco_unitario
            : null,
          ordem: idx,
        });
      });
    }
    if (subItens.length > 0) {
      const { error: subErr } = await admin
        .from('composicao_propria_itens')
        .insert(subItens);
      if (subErr) {
        throw new Error(`Falha ao gravar composicao_propria_itens: ${subErr.message}`);
      }
    }

    // ---- 7) Concluir extração + transição licitação ------------------------
    const { error: doneErr } = await admin
      .from('extracoes_ocr')
      .update({
        status: 'sucesso',
        json_extraido: { cabecalho: parsed.cabecalho, itens: parsed.itens },
        tokens_input: result.usage.promptTokenCount ?? null,
        tokens_output: result.usage.candidatesTokenCount ?? null,
        custo_usd: result.estimatedCostUsd,
        duracao_ms: duracaoMs,
        concluido_em: new Date().toISOString(),
      })
      .eq('id', extracaoId);
    if (doneErr) {
      throw new Error(`Falha ao concluir extracoes_ocr: ${doneErr.message}`);
    }

    // Transições em sequência (validate_licitacao_status_transition checa)
    await admin.from('licitacoes').update({ status: 'extracao_concluida' }).eq('id', licitacaoId);
    await admin.from('licitacoes').update({ status: 'aguardando_revisao_humana' }).eq('id', licitacaoId);

    // Persiste warnings de recuperação no erro_detalhe (pra reanálise/auditoria)
    if (extracaoWarnings.length > 0 && extracaoId) {
      await admin.from('extracoes_ocr').update({
        erro_detalhe: `[recuperação] ${extracaoWarnings.join(' | ')}`,
      }).eq('id', extracaoId);
    }

        // Background completou com sucesso — só loga. Cliente vai descobrir
        // via polling do status do extracoes_ocr.
        console.log(`[extracao-edital][bg] OK extracao=${extracaoId} itens=${parsed.itens.length} duracao_ms=${duracaoMs}`);
      } catch (err) {
        // Background falhou — atualiza DB pro cliente ver via polling.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[extracao-edital][bg] FALHOU extracao=${extracaoId}: ${msg}`);
        if (extracaoId) {
          await admin.from('extracoes_ocr').update({
            status: 'falha',
            erro_detalhe: msg,
            concluido_em: new Date().toISOString(),
          }).eq('id', extracaoId);
        }
        if (licitacaoId) {
          await admin.from('licitacoes').update({ status: 'erro' }).eq('id', licitacaoId);
        }
      }
    }; // fim runExtractionAsync

    // Dispatch da extração em background. EdgeRuntime.waitUntil é global do
    // Supabase Edge Runtime (Deno) — mantém a função viva sem bloquear o response.
    // @ts-expect-error EdgeRuntime é provido pelo runtime Supabase
    if (typeof EdgeRuntime !== 'undefined') {
      // @ts-expect-error idem
      EdgeRuntime.waitUntil(runExtractionAsync());
    } else {
      // Fallback dev local: roda sem await
      runExtractionAsync();
    }

    // Retorna 202 IMEDIATAMENTE — cliente fica polling /licitacoes/[id]
    // que recarrega via PollRefresher quando status muda.
    return jsonResponse({
      extracao_id: extracaoId,
      licitacao_id: licitacaoId,
      status: 'iniciada',
      message: 'Extração iniciada em background. A página vai recarregar quando terminar.',
      trace_id: traceId,
    }, 202);
  } catch (err) {
    // Failover do FAST PATH (antes do background começar).
    // Marca extração como falha e licitação como erro.
    const msg = err instanceof Error ? err.message : String(err);
    const details = err instanceof GeminiError ? err.details : null;
    if (extracaoId) {
      await admin.from('extracoes_ocr').update({
        status: 'falha',
        erro_detalhe: msg,
        concluido_em: new Date().toISOString(),
      }).eq('id', extracaoId);
    }
    if (licitacaoId) {
      await admin.from('licitacoes').update({ status: 'erro' }).eq('id', licitacaoId);
    }
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.message, err.details);
    }
    if (err instanceof GeminiError) {
      return errorResponse(502, err.message, details);
    }
    console.error('[extracao-edital] erro:', err);
    return errorResponse(500, msg, details);
  }
});
