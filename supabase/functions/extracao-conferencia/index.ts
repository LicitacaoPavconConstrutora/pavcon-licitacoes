// =============================================================================
// Edge Function: extracao-conferencia
// =============================================================================
// 2ª passada de auditoria sobre uma extração já concluída: compara os itens
// extraídos contra o(s) PDF(s) original(is) e grava as divergências em
// extracoes_ocr.conferencia_resultado.
//
// POR QUE UMA FUNÇÃO SEPARADA (e não dentro de extracao-edital):
// o runExtractionAsync da extracao-edital roda dentro de
// EdgeRuntime.waitUntil, que mantém a function viva por ~400s. A extração em
// si já consome 120-180s (e até ~440s no pior caso, quando dispara uma
// rodada de continuação perto do TEMPO_LIMITE_CONTINUACAO_MS de 260s).
// Enfiar mais uma chamada ao Gemini com re-upload dos PDFs nesse mesmo
// orçamento de tempo faria o processo ser morto antes de gravar o resultado
// da extração — a extração ficaria presa em 'processando'. Aqui a
// conferência tem orçamento de tempo próprio.
//
// Idempotente: se a extração já tem conferencia_resultado, não re-roda (a não
// ser com force=true) — evita custo repetido a cada abertura do painel.
// =============================================================================

import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import {
  getServiceRoleClient,
  HttpError,
  requireAuthenticatedUser,
} from '../_shared/supabase.ts';
import { callGemini, GeminiError, type GeminiPart } from '../_shared/gemini.ts';
import {
  CONFERENCIA_PROMPT_VERSION,
  CONFERENCIA_SYSTEM_PROMPT,
  type ConferenciaDivergencia,
  type ConferenciaResultado,
  type ItemParaConferencia,
  montarTabelaParaConferencia,
} from './prompt.ts';

// Flash: barato e rápido. A tarefa aqui é conferir, não extrair — não precisa
// do Pro. Mesmo modelo usado em pdf-classificar-paginas e orcapav-corrigir-gemini.
const GEMINI_FLASH_MODEL = 'gemini-2.5-flash';
// A saída é só a lista de divergências, não a planilha inteira.
const MAX_OUTPUT_TOKENS = 8192;

interface RequestBody {
  licitacao_id?: string;
  // Re-roda mesmo se já existe conferencia_resultado.
  force?: boolean;
  trace_id?: string;
}

const TIPOS_VALIDOS = new Set<ConferenciaDivergencia['tipo']>([
  'invencao',
  'fora_de_ordem',
  'valor_divergente',
  'descricao_divergente',
  'item_faltando',
]);

function stripCodeFences(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : s.trim();
}

// O Flash às vezes devolve JSON com vírgula sobrando ou aspas inconsistentes.
// Mesma escada de recuperação da extracao-edital, sem o passo de truncagem
// (aqui a saída é pequena; se não parsear, é melhor falhar do que salvar
// divergências pela metade).
async function parseResposta(texto: string): Promise<unknown> {
  const limpo = stripCodeFences(texto);
  try {
    return JSON.parse(limpo);
  } catch {
    const { jsonrepair } = await import('https://esm.sh/jsonrepair@3.12.0');
    return JSON.parse(jsonrepair(limpo));
  }
}

// Só aceita divergências no formato esperado — o modelo pode inventar um
// `tipo` fora do enum, e isso viraria uma pendência sem sentido no painel.
function normalizarResultado(
  bruto: unknown,
  totalItens: number,
): ConferenciaResultado {
  const obj = (bruto ?? {}) as Partial<ConferenciaResultado>;
  const divergencias = Array.isArray(obj.divergencias) ? obj.divergencias : [];
  const validas: ConferenciaDivergencia[] = [];
  for (const d of divergencias) {
    if (!d || typeof d !== 'object') continue;
    const item = d as Partial<ConferenciaDivergencia>;
    if (!item.tipo || !TIPOS_VALIDOS.has(item.tipo)) continue;
    validas.push({
      item_codigo: String(item.item_codigo ?? '(sem código)'),
      tipo: item.tipo,
      detalhe: String(item.detalhe ?? '').slice(0, 600),
    });
  }
  return {
    itens_verificados: typeof obj.itens_verificados === 'number'
      ? obj.itens_verificados
      : totalItens,
    divergencias: validas,
  };
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

  const licitacaoId = body.licitacao_id?.trim();
  if (!licitacaoId) {
    return errorResponse(400, 'licitacao_id é obrigatório.');
  }
  const traceId = body.trace_id ?? crypto.randomUUID();
  const admin = getServiceRoleClient();

  try {
    const user = await requireAuthenticatedUser(req);

    // ---- 1) Extração mais recente concluída --------------------------------
    const { data: extracao, error: extracaoErr } = await admin
      .from('extracoes_ocr')
      .select('id, json_extraido, json_corrigido, conferencia_resultado')
      .eq('licitacao_id', licitacaoId)
      .in('status', ['sucesso', 'revisada_humano'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (extracaoErr) {
      return errorResponse(500, 'Falha ao ler extracoes_ocr.', extracaoErr.message);
    }
    if (!extracao) {
      return errorResponse(404, 'Nenhuma extração concluída pra esta licitação.');
    }
    if (extracao.conferencia_resultado && !body.force) {
      return jsonResponse({
        extracao_id: extracao.id,
        status: 'já_conferida',
        conferencia_resultado: extracao.conferencia_resultado,
        trace_id: traceId,
      });
    }

    // Confere sempre a versão que vai pro cadastro (json_corrigido quando o
    // orçamentista já revisou; senão o extraído cru).
    const fonteJson = (extracao.json_corrigido ?? extracao.json_extraido) as
      { itens?: ItemParaConferencia[] } | null;
    const itens = Array.isArray(fonteJson?.itens) ? fonteJson!.itens : [];
    if (itens.length === 0) {
      return errorResponse(422, 'Extração não tem itens pra conferir.');
    }

    // ---- 2) PDFs originais -------------------------------------------------
    const { data: arquivos, error: arquivosErr } = await admin
      .from('licitacao_arquivos')
      .select('storage_bucket, storage_path, filename_original, mime_type')
      .eq('licitacao_id', licitacaoId)
      .order('created_at', { ascending: true });
    if (arquivosErr) {
      return errorResponse(500, 'Falha ao ler licitacao_arquivos.', arquivosErr.message);
    }
    const pdfs = (arquivos ?? []).filter((a) => a.mime_type === 'application/pdf');
    if (pdfs.length === 0) {
      return errorResponse(404, 'Nenhum PDF encontrado pra conferir.');
    }

    // ---- 3) Credencial Gemini ----------------------------------------------
    const { data: creds, error: credsErr } = await admin
      .from('api_credentials')
      .select('id, vault_secret_id, ativo, escopo, owner_id')
      .eq('provider', 'gemini')
      .eq('ativo', true)
      .order('escopo', { ascending: true });
    if (credsErr) {
      return errorResponse(500, 'Falha ao listar credenciais Gemini.', credsErr.message);
    }
    const cred = creds?.find((c) => c.escopo === 'organizacional' || c.owner_id === user.id);
    if (!cred) {
      return errorResponse(422, 'Nenhuma credencial Gemini ativa cadastrada.');
    }
    const { data: apiKey, error: vaultErr } = await admin.rpc('read_vault_secret', {
      p_secret_id: cred.vault_secret_id,
    });
    if (vaultErr || typeof apiKey !== 'string' || !apiKey) {
      return errorResponse(500, 'Vault não retornou a API key do Gemini.', vaultErr?.message);
    }

    // =========================================================================
    // Background: baixar PDFs + chamar o Flash passa de 150s em edital grande.
    // Responde 202 na hora; o painel lê conferencia_resultado depois.
    // =========================================================================
    const rodarConferencia = async () => {
      try {
        const parts: GeminiPart[] = [
          { text: CONFERENCIA_SYSTEM_PROMPT },
          {
            text: `TABELA EXTRAÍDA (${itens.length} itens):\n` +
              montarTabelaParaConferencia(itens),
          },
        ];
        for (const a of pdfs) {
          const { data: blob, error: dlErr } = await admin
            .storage
            .from(a.storage_bucket)
            .download(a.storage_path);
          if (dlErr || !blob) {
            throw new Error(
              `Falha ao baixar "${a.filename_original}": ${dlErr?.message ?? 'sem dado'}`,
            );
          }
          const bytes = new Uint8Array(await blob.arrayBuffer());
          // Converte em pedaços — String.fromCharCode com o array inteiro
          // estoura a pilha em PDF grande.
          let binary = '';
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
          }
          parts.push({
            inlineData: { mimeType: 'application/pdf', data: btoa(binary) },
          });
        }

        const resp = await callGemini({
          model: GEMINI_FLASH_MODEL,
          apiKey,
          parts,
          responseJson: true,
          temperature: 0,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          admin,
          callerUserId: user.id,
          licitacaoId,
          traceId,
        });

        const resultado = normalizarResultado(
          await parseResposta(resp.text ?? ''),
          itens.length,
        );

        const { error: upErr } = await admin
          .from('extracoes_ocr')
          .update({ conferencia_resultado: { ...resultado, versao: CONFERENCIA_PROMPT_VERSION } })
          .eq('id', extracao.id);
        if (upErr) {
          throw new Error(`Falha ao gravar conferencia_resultado: ${upErr.message}`);
        }
        console.log(
          `[extracao-conferencia] OK extracao=${extracao.id} itens=${itens.length} divergencias=${resultado.divergencias.length}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[extracao-conferencia] FALHOU extracao=${extracao.id}: ${msg}`);
        // Registra a falha no próprio campo pra o painel poder dizer "a
        // conferência não rodou" em vez de ficar silenciosamente sem auditoria.
        await admin
          .from('extracoes_ocr')
          .update({
            conferencia_resultado: {
              itens_verificados: 0,
              divergencias: [],
              erro: msg.slice(0, 500),
              versao: CONFERENCIA_PROMPT_VERSION,
            },
          })
          .eq('id', extracao.id);
      }
    };

    // @ts-expect-error EdgeRuntime é provido pelo runtime Supabase
    if (typeof EdgeRuntime !== 'undefined') {
      // @ts-expect-error idem
      EdgeRuntime.waitUntil(rodarConferencia());
    } else {
      rodarConferencia();
    }

    return jsonResponse({
      extracao_id: extracao.id,
      licitacao_id: licitacaoId,
      status: 'iniciada',
      itens: itens.length,
      trace_id: traceId,
    }, 202);
  } catch (err) {
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.message, err.details);
    }
    if (err instanceof GeminiError) {
      return errorResponse(502, err.message, err.details);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[extracao-conferencia] erro:', err);
    return errorResponse(500, msg);
  }
});
