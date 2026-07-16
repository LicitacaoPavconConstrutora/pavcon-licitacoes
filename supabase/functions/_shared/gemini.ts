// Cliente leve para a API REST do Gemini.
// Usado pela Edge Function extracao-edital pra enviar PDFs ao Gemini
// (atualmente gemini-3.1-pro-preview) e receber JSON estruturado.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { logIntegration } from './audit.ts';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Pricing aproximado de 2026 (gemini-3.1-pro-preview, mesmo tier que 2.5 Pro).
//   <200K input: $1.25/M tokens   |  >200K: $2.50/M
//   <200K output: $10.00/M tokens |  >200K: $15.00/M
// Atualizar conforme Google publica preços oficiais do 3.1.
const PRICE_INPUT_LOW = 1.25 / 1_000_000;
const PRICE_INPUT_HIGH = 2.50 / 1_000_000;
const PRICE_OUTPUT_LOW = 10.0 / 1_000_000;
const PRICE_OUTPUT_HIGH = 15.0 / 1_000_000;
const TIER_THRESHOLD = 200_000;

export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

export interface GeminiCallResult {
  status: number;
  text: string | null;
  usage: GeminiUsage;
  rawJson: unknown;
  estimatedCostUsd: number;
  // "STOP" = terminou normal. "MAX_TOKENS" = cortado pelo teto de
  // maxOutputTokens no meio da resposta — texto pode estar incompleto.
  finishReason?: string;
}

export interface GeminiInlinePart {
  inlineData: { mimeType: string; data: string };
}

export interface GeminiTextPart {
  text: string;
}

export interface GeminiFilePart {
  fileData: { mimeType: string; fileUri: string };
}

export type GeminiPart = GeminiInlinePart | GeminiTextPart | GeminiFilePart;

// Um turno de conversa multi-turn (usado pra continuação de respostas
// cortadas por MAX_TOKENS — reenvia a resposta anterior do model como
// contexto em vez de reenviar os PDFs originais).
export interface GeminiTurn {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

// ---------------------------------------------------------------------------
// Gemini Files API — upload raw bytes (sem base64) e referencia via file_uri.
// Necessário pra PDFs grandes: inlineData força base64 + JSON.stringify do
// payload inteiro em memória, estourando WORKER_RESOURCE_LIMIT (546) no
// Edge Function (150-256 MB). Files API faz streaming raw.
// ---------------------------------------------------------------------------

const GEMINI_FILES_UPLOAD_BASE = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const GEMINI_FILES_BASE = 'https://generativelanguage.googleapis.com/v1beta/files';

export interface GeminiUploadedFile {
  name: string;       // "files/abc123"
  uri: string;        // "https://generativelanguage.googleapis.com/v1beta/files/abc123"
  mimeType: string;
  sizeBytes?: string;
  state?: string;     // "PROCESSING" | "ACTIVE" | "FAILED"
}

/**
 * Upload um arquivo (raw bytes) pra Gemini Files API e devolve {uri, mimeType}.
 * Espera o state virar ACTIVE (PDFs ficam em PROCESSING segundos).
 * Arquivos expiram em 48h no Gemini — não precisa deletar manualmente.
 */
export async function uploadGeminiFile(opts: {
  apiKey: string;
  bytes: Uint8Array;
  mimeType: string;
  displayName?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}): Promise<GeminiUploadedFile> {
  const { apiKey, bytes, mimeType, displayName } = opts;
  const pollInterval = opts.pollIntervalMs ?? 1500;
  const pollTimeout = opts.pollTimeoutMs ?? 60_000;

  // Upload "raw" protocol — body são os bytes do arquivo direto, sem multipart.
  const uploadUrl = `${GEMINI_FILES_UPLOAD_BASE}?key=${apiKey}`;
  const uploadResp = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'raw',
      'X-Goog-Upload-File-Name': displayName ?? 'upload.bin',
      'Content-Type': mimeType,
    },
    body: bytes,
  });
  const uploadText = await uploadResp.text();
  if (!uploadResp.ok) {
    throw new GeminiError(
      uploadResp.status,
      `Gemini Files upload falhou (${uploadResp.status}).`,
      uploadText.slice(0, 500),
    );
  }
  let parsed: { file?: GeminiUploadedFile };
  try {
    parsed = JSON.parse(uploadText);
  } catch {
    throw new GeminiError(502, 'Gemini Files upload: resposta não-JSON.', uploadText.slice(0, 500));
  }
  const file = parsed.file;
  if (!file?.uri) {
    throw new GeminiError(502, 'Gemini Files upload: sem file.uri.', parsed);
  }

  // Poll até ACTIVE (PDFs grandes ficam em PROCESSING por alguns segundos).
  const fileId = file.name.replace(/^files\//, '');
  const started = Date.now();
  let current = file;
  while (current.state === 'PROCESSING') {
    if (Date.now() - started > pollTimeout) {
      throw new GeminiError(504, `Gemini Files: timeout aguardando ACTIVE (${pollTimeout}ms).`);
    }
    await new Promise((r) => setTimeout(r, pollInterval));
    const statusResp = await fetch(`${GEMINI_FILES_BASE}/${fileId}?key=${apiKey}`);
    if (!statusResp.ok) {
      throw new GeminiError(statusResp.status, 'Gemini Files: falha ao consultar status.');
    }
    current = await statusResp.json();
  }
  if (current.state && current.state !== 'ACTIVE') {
    throw new GeminiError(502, `Gemini Files: state=${current.state}.`, current);
  }
  return current;
}

export class GeminiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

export function estimateGeminiCost(usage: GeminiUsage): number {
  const inputTokens = usage.promptTokenCount ?? 0;
  const outputTokens = usage.candidatesTokenCount ?? 0;
  const inputPrice = inputTokens > TIER_THRESHOLD ? PRICE_INPUT_HIGH : PRICE_INPUT_LOW;
  const outputPrice = outputTokens > TIER_THRESHOLD
    ? PRICE_OUTPUT_HIGH
    : PRICE_OUTPUT_LOW;
  return inputTokens * inputPrice + outputTokens * outputPrice;
}

interface CallGeminiOpts {
  model: string;            // ex.: "gemini-2.5-pro"
  apiKey: string;
  parts: GeminiPart[];
  // Turnos anteriores da conversa (opcional) — prepostos antes de `parts`
  // como o turno 'user' final. Usado pra continuação multi-rodada sem
  // precisar reenviar PDFs grandes a cada chamada.
  priorTurns?: GeminiTurn[];
  responseJson?: boolean;   // exige application/json (default: true)
  temperature?: number;     // default: 0.1 (extração estruturada)
  maxOutputTokens?: number; // default: 32768
  // Para audit log:
  admin: SupabaseClient;
  callerUserId: string;
  licitacaoId?: string | null;
  traceId?: string;
}

// Status transitórios do lado do Google (sobrecarga/rate-limit) — vale a
// pena tentar de novo. 400/401/403/404/etc são determinísticos: o mesmo
// request malformado só ia falhar de novo, então NÃO entram aqui.
const STATUS_RETRIAVEIS = new Set([429, 503]);
const RETRY_DELAYS_MS = [5000, 15000]; // 2 tentativas extras (3 no total)

/**
 * Chama generateContent no Gemini, audita a chamada e devolve o texto +
 * tokens usados + custo estimado. Lança GeminiError em status não-2xx.
 *
 * Retenta automaticamente em 429 (rate limit) e 503 (modelo sobrecarregado)
 * — erros transitórios do lado do Google, sem relação com o conteúdo do
 * request. Antes, um único 503 passageiro derrubava a extração inteira
 * (visto em SINFRA 031/2026: 400 e 503 alternados nas tentativas manuais
 * do orçamentista, sem nenhum retry automático).
 */
export async function callGemini(
  opts: CallGeminiOpts,
): Promise<GeminiCallResult> {
  const url = `${GEMINI_API_BASE}/models/${opts.model}:generateContent?key=${opts.apiKey}`;

  const body = {
    contents: [
      ...(opts.priorTurns ?? []).map((t) => ({ role: t.role, parts: t.parts })),
      { role: 'user', parts: opts.parts },
    ],
    generationConfig: {
      temperature: opts.temperature ?? 0.1,
      maxOutputTokens: opts.maxOutputTokens ?? 32768,
      ...(opts.responseJson !== false
        ? { responseMimeType: 'application/json' }
        : {}),
    },
  };

  // Mascarar a API key na URL antes de logar
  const safeUrl = url.replace(/key=[^&]+/, 'key=***');

  let response!: Response;
  let rawText = '';
  let parsed: unknown = null;
  let startedAt = Date.now();

  for (let tentativa = 0; tentativa <= RETRY_DELAYS_MS.length; tentativa++) {
    startedAt = Date.now();
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    rawText = await response.text();
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }

    await logIntegration(opts.admin, {
      user_id: opts.callerUserId,
      licitacao_id: opts.licitacaoId ?? null,
      provider: 'gemini',
      endpoint: safeUrl,
      metodo_http: 'POST',
      request_payload: {
        model: opts.model,
        tentativa: tentativa + 1,
        parts_summary: opts.parts.map((p) => {
          if ('text' in p) return { type: 'text', length: p.text.length };
          if ('inlineData' in p) {
            return { type: 'inline', mime: p.inlineData.mimeType, bytes_b64: p.inlineData.data.length };
          }
          return { type: 'file', mime: p.fileData.mimeType, uri: p.fileData.fileUri };
        }),
        generationConfig: body.generationConfig,
      },
      response_status: response.status,
      response_payload: parsed
        ? {
          candidates_summary:
            (parsed as { candidates?: Array<{ finishReason?: string }> }).candidates
              ?.map((c) => ({ finishReason: c.finishReason })) ?? null,
          usageMetadata: (parsed as { usageMetadata?: GeminiUsage }).usageMetadata,
        }
        : { raw: rawText.slice(0, 500) },
      duracao_ms: Date.now() - startedAt,
      custo_usd: parsed
        ? estimateGeminiCost(
          (parsed as { usageMetadata?: GeminiUsage }).usageMetadata ?? {},
        )
        : null,
      trace_id: opts.traceId ?? null,
    });

    if (response.ok) break;
    const podeRetentar = STATUS_RETRIAVEIS.has(response.status) &&
      tentativa < RETRY_DELAYS_MS.length;
    if (!podeRetentar) break;
    console.warn(
      `[gemini] status ${response.status} (tentativa ${tentativa + 1}/${RETRY_DELAYS_MS.length + 1}) — ` +
        `retentando em ${RETRY_DELAYS_MS[tentativa]}ms`,
    );
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[tentativa]));
  }

  if (!response.ok) {
    throw new GeminiError(
      response.status,
      `Gemini respondeu ${response.status}.`,
      parsed ?? rawText.slice(0, 500),
    );
  }
  if (!parsed) {
    throw new GeminiError(502, 'Resposta do Gemini não é JSON válido.', rawText.slice(0, 500));
  }

  const candidates = (parsed as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
  }).candidates;
  if (!candidates || candidates.length === 0) {
    throw new GeminiError(502, 'Gemini não retornou candidates.', parsed);
  }
  const finishReason = candidates[0].finishReason;
  const text = candidates[0].content?.parts?.[0]?.text ?? null;
  if (!text) {
    throw new GeminiError(
      502,
      `Gemini terminou com finishReason="${finishReason}" mas sem texto.`,
      parsed,
    );
  }

  const usage = (parsed as { usageMetadata?: GeminiUsage }).usageMetadata ?? {};
  return {
    status: response.status,
    text,
    usage,
    rawJson: parsed,
    estimatedCostUsd: estimateGeminiCost(usage),
    finishReason,
  };
}
