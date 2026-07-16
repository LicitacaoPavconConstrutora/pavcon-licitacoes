// =============================================================================
// Edge Function: orcapav-corrigir-gemini
// =============================================================================
// Auto-correção com Gemini Flash (function calling nativo). Alternativa
// gratuita/barata ao orcapav-chat (Claude Sonnet 4.5) — usa quando o user
// não tem créditos Anthropic.
//
// Tools (function declarations) iguais às do claudio-chat:
//   - salvar_mapeamento_code
//   - reclassificar_codes_adaptados
//   - obter_estado_atual
//   - finalizar (sinaliza fim do loop)
//
// Body:
//   { licitacao_id }
//
// Response:
//   { ok, resposta, acoes_executadas: [{tool, input, result}] }
// =============================================================================

import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import { getServiceRoleClient, requireAuthenticatedUser } from '../_shared/supabase.ts';
import { codesPendentesDaLicitacao } from '../_shared/codes-pendentes.ts';

const GEMINI_FLASH = 'gemini-2.5-flash';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_LOOPS = 6;

interface RequestBody {
  licitacao_id?: string;
}

// =============================================================================
// Tools — function declarations no formato Gemini
// =============================================================================
const TOOLS_DECL = {
  function_declarations: [
    {
      name: 'salvar_mapeamento_code',
      description:
        'Salva mapeamento de código antigo → moderno no orcafascio_code_mappings. ' +
        'Use quando souber com confiança >= 70% qual o equivalente moderno do código descontinuado.',
      parameters: {
        type: 'object',
        properties: {
          fonte_original: { type: 'string', description: 'Banco antigo (ex: SINAPI, ORSE, SEINFRA)' },
          codigo_original: { type: 'string', description: 'Código legacy que falhou' },
          fonte_nova: { type: 'string', description: 'Banco do código moderno (geralmente o mesmo)' },
          codigo_nova: { type: 'string', description: 'Código moderno equivalente' },
          justificativa: { type: 'string', description: 'Por que esse é o equivalente correto' },
        },
        required: ['fonte_original', 'codigo_original', 'fonte_nova', 'codigo_nova', 'justificativa'],
      },
    },
    {
      name: 'reclassificar_codes_adaptados',
      description:
        'Reclassifica itens com sufixo -ADAP, -A, ou texto "COMPOSIÇÃO XX" como PROPRIA. ' +
        'Use quando detectar codes mal classificados como SINAPI/ORSE.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'obter_estado_atual',
      description: 'Lê o estado atualizado da licitação: warnings, codes pendentes.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'finalizar',
      description: 'Chame quando não há mais correções a fazer. Encerra o loop.',
      parameters: {
        type: 'object',
        properties: {
          resumo: { type: 'string', description: 'Resumo curto do que foi feito e o que sobrou' },
        },
        required: ['resumo'],
      },
    },
  ],
};

const SYSTEM_PROMPT = `Você é o **OrçaPav AI**, agente autônomo de auto-correção de orçamentos de licitação pública brasileira no Orçafascio.

# Domínio
- **SINAPI labor migrou pra "com encargos complementares"**:
  244→88253 (auxiliar topógrafo), 6111→88316 (servente), 7592→91387 (topógrafo), 88245→88309 (pedreiro), 88247→88310 (mestre de obras), 88248→88311 (encarregado), 88239→88339 (engenheiro civil junior)
- **SINAPI materiais** geralmente mantêm número (cimento 1379, areia 367, brita 4720, etc) mas Orçafascio pode não ter no banco — nesse caso identity mapping NÃO ajuda
- **ORSE / SEINFRA / SEDOP** são bancos regionais — códigos podem estar truly descontinuados sem equivalente
- **Composições adaptadas** (-ADAP, -A, "COMPOSIÇÃO XX") = órgão modificou base oficial → devem ser PROPRIA

# Sua tarefa
1. Analise o contexto da licitação que vou te passar (warnings, codes pendentes)
2. Pra CADA código que você conhece o equivalente moderno, chame \`salvar_mapeamento_code\` IMEDIATAMENTE
3. Se identificar itens mal classificados, chame \`reclassificar_codes_adaptados\`
4. Quando terminar, chame \`finalizar\` com resumo CONCISO do que fez

# Regras
- NÃO peça permissão, aja diretamente
- Confiança < 70% → pule esse código (não chute)
- Pra labor, use a lista acima
- Pra materiais, só sugira se tiver muito certeza (orcamentor.com é referência)
- Após cada tool call, espere o resultado antes de chamar a próxima

# Tom
- Direto, em PT-BR
- Sem bla-bla
- Pragmático`;

// =============================================================================
// Tool execution
// =============================================================================
async function executarTool(
  name: string,
  input: Record<string, unknown>,
  ctx: { licitacaoId: string; userId: string; admin: ReturnType<typeof getServiceRoleClient> },
): Promise<unknown> {
  const { licitacaoId, admin } = ctx;

  if (name === 'salvar_mapeamento_code') {
    const { fonte_original, codigo_original, fonte_nova, codigo_nova, justificativa } = input as {
      fonte_original: string;
      codigo_original: string;
      fonte_nova: string;
      codigo_nova: string;
      justificativa?: string;
    };
    if (!fonte_original || !codigo_original || !fonte_nova || !codigo_nova) {
      return { ok: false, error: 'Campos obrigatórios faltando.' };
    }
    const { error } = await admin
      .from('orcafascio_code_mappings')
      .upsert(
        {
          fonte_original: fonte_original.toUpperCase(),
          codigo_original,
          fonte_substituto: fonte_nova.toUpperCase(),
          codigo_substituto: codigo_nova,
          motivo: `OrçaPav AI (Gemini Flash): ${justificativa ?? 'mapeamento automatico'}`,
        },
        { onConflict: 'fonte_original,codigo_original' },
      );
    if (error) return { ok: false, error: error.message };
    // Limpa composition_ids pra que o retry aplique
    await admin
      .from('composicoes_extraidas')
      .update({ orcafascio_composition_id: null })
      .eq('licitacao_id', licitacaoId)
      .eq('fonte', 'PROPRIA');
    return {
      ok: true,
      mensagem: `Mapping ${fonte_original}/${codigo_original} → ${fonte_nova}/${codigo_nova} salvo. ` +
        'Composition_ids limpos pra retry.',
    };
  }

  if (name === 'reclassificar_codes_adaptados') {
    const { data: items } = await admin
      .from('composicoes_extraidas')
      .select('id, fonte, codigo, metadata')
      .eq('licitacao_id', licitacaoId)
      .eq('tipo_linha', 'servico');
    const ehAdaptado = (fonte: string | null, codigo: string | null): string | null => {
      if (!codigo || !fonte) return null;
      const f = fonte.toUpperCase();
      if (f === 'PROPRIA' || f === 'OUTRA') return null;
      const c = codigo.toUpperCase().trim();
      if (/^COMPOSI[CÇ][ÃA]O\s*[\d_-]+/i.test(c)) return 'texto literal "COMPOSIÇÃO XX"';
      if (/[\s-]ADAPT?(?:AD[OA])?\s*$|^ADAPTAD[OA]\s|\sADAP\s|-A$|-ADAP$/i.test(c)) {
        return 'sufixo de adaptação';
      }
      return null;
    };
    let count = 0;
    for (const it of items ?? []) {
      const motivo = ehAdaptado(it.fonte, it.codigo);
      if (!motivo) continue;
      const metaAtual = (it.metadata as Record<string, unknown> | null) ?? {};
      await admin
        .from('composicoes_extraidas')
        .update({
          fonte: 'PROPRIA',
          orcafascio_composition_id: null,
          metadata: {
            ...metaAtual,
            fonte_original: it.fonte,
            codigo_original: it.codigo,
            reclassificada_motivo: motivo,
            reclassificada_em: new Date().toISOString(),
            reclassificada_por: 'orcapav_gemini',
          },
        })
        .eq('id', it.id);
      count++;
    }
    return {
      ok: true,
      mudancas: count,
      mensagem: `${count} item(ns) reclassificado(s) pra PROPRIA.`,
    };
  }

  if (name === 'obter_estado_atual') {
    const { data: lic } = await admin
      .from('licitacoes')
      .select('status, cadastro_resumo')
      .eq('id', licitacaoId)
      .maybeSingle();
    const codes = await codesPendentesDaLicitacao(admin, licitacaoId);
    return {
      status: lic?.status,
      warnings_recentes:
        (lic?.cadastro_resumo as { warnings?: string[] } | null)?.warnings?.slice(0, 10) ?? [],
      codes_pendentes: codes.slice(0, 15),
    };
  }

  if (name === 'finalizar') {
    return { ok: true, finalizado: true };
  }

  return { ok: false, error: `Tool desconhecida: ${name}` };
}

// codesPendentesDaLicitacao agora vem de ../_shared/codes-pendentes.ts —
// ver esse arquivo pro histórico do bug de escopo (jul/2026) e pra evitar
// uma 4ª cópia divergente desta mesma lógica.

// =============================================================================
// Coleta inicial do contexto pra mandar pro Gemini
// =============================================================================
async function coletarContexto(
  licitacaoId: string,
  admin: ReturnType<typeof getServiceRoleClient>,
): Promise<Record<string, unknown>> {
  const { data: lic } = await admin
    .from('licitacoes')
    .select('id, titulo, status, cadastro_resumo')
    .eq('id', licitacaoId)
    .maybeSingle();

  const warnings = (lic?.cadastro_resumo as { warnings?: string[] } | null)?.warnings ?? [];

  const codesPend = await codesPendentesDaLicitacao(admin, licitacaoId);

  // composições proprias da licitação (pra detectar -ADAP)
  const { data: comps } = await admin
    .from('composicoes_extraidas')
    .select('item_codigo, codigo, fonte, descricao')
    .eq('licitacao_id', licitacaoId)
    .eq('tipo_linha', 'servico');

  return {
    licitacao: { id: lic?.id, titulo: lic?.titulo, status: lic?.status },
    warnings_passo1: warnings.slice(0, 25),
    codes_pendentes_mapeamento: codesPend.slice(0, 30),
    composicoes_amostra: (comps ?? []).slice(0, 20),
  };
}

// =============================================================================
// Main handler
// =============================================================================
Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse(405, 'Use POST.');

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'JSON inválido.');
  }

  const licitacaoId = body.licitacao_id?.trim();
  if (!licitacaoId) return errorResponse(400, 'licitacao_id é obrigatório.');

  const admin = getServiceRoleClient();

  try {
    const user = await requireAuthenticatedUser(req);

    // Resolve credencial Gemini
    const { data: gCreds } = await admin
      .from('api_credentials')
      .select('id, vault_secret_id, escopo, owner_id')
      .eq('provider', 'gemini')
      .eq('ativo', true)
      .order('escopo', { ascending: true });
    const gCred = gCreds?.find((c) =>
      c.escopo === 'organizacional' || c.owner_id === user.id
    );
    if (!gCred) return errorResponse(422, 'Credencial Gemini não cadastrada.');
    const { data: apiKey } = await admin.rpc('read_vault_secret', {
      p_secret_id: gCred.vault_secret_id,
    });
    if (typeof apiKey !== 'string' || !apiKey) {
      return errorResponse(500, 'Vault retornou API key inválida.');
    }

    const contexto = await coletarContexto(licitacaoId, admin);
    const userPrompt = `Iniciada auto-correção da licitação.

<contexto>
${JSON.stringify(contexto, null, 2)}
</contexto>

Use as ferramentas pra resolver o máximo possível. Quando terminar, chame finalizar.`;

    const conversation: Array<{
      role: 'user' | 'model' | 'function';
      parts: Array<Record<string, unknown>>;
    }> = [
      { role: 'user', parts: [{ text: userPrompt }] },
    ];

    const acoesExecutadas: Array<{ tool: string; input: unknown; result: unknown }> = [];
    let respostaFinal = '';

    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      const resp = await fetch(
        `${GEMINI_API}/models/${GEMINI_FLASH}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: conversation,
            tools: [TOOLS_DECL],
            generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
          }),
        },
      );
      if (!resp.ok) {
        const errText = await resp.text();
        return errorResponse(502, `Gemini Flash ${resp.status}: ${errText.slice(0, 300)}`);
      }
      const data = await resp.json();
      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];

      // Detecta function call no resultado
      let functionCall: { name: string; args: Record<string, unknown> } | null = null;
      let textContent = '';
      for (const part of parts) {
        if (part.functionCall) {
          functionCall = {
            name: part.functionCall.name,
            args: part.functionCall.args ?? {},
          };
        }
        if (part.text) textContent += part.text;
      }

      if (!functionCall) {
        // Sem tool call — modelo respondeu só com texto. Considera finalizado.
        respostaFinal = textContent || 'Sem ações sugeridas.';
        break;
      }

      // Executa a tool
      const result = await executarTool(functionCall.name, functionCall.args, {
        licitacaoId, userId: user.id, admin,
      });
      acoesExecutadas.push({
        tool: functionCall.name,
        input: functionCall.args,
        result,
      });

      // Se chamou finalizar, sai do loop
      if (functionCall.name === 'finalizar') {
        respostaFinal = (functionCall.args.resumo as string) ?? 'Finalizado.';
        break;
      }

      // Senão, anexa ao histórico e continua
      conversation.push({
        role: 'model',
        parts: [{ functionCall: functionCall as unknown as Record<string, unknown> }],
      });
      conversation.push({
        role: 'function',
        parts: [{
          functionResponse: {
            name: functionCall.name,
            response: result as Record<string, unknown>,
          },
        }],
      });
    }

    return jsonResponse({
      ok: true,
      resposta: respostaFinal || `Loop max (${MAX_LOOPS}) atingido sem chamada de finalizar.`,
      acoes_executadas: acoesExecutadas,
      provider: 'gemini-flash',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(500, `Erro: ${msg}`);
  }
});
