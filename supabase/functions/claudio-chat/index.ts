// =============================================================================
// Edge Function: claudio-chat
// =============================================================================
// Cláudio conversacional plugado com Claude API (Anthropic Messages API).
// Suporta tool use (function calling): Claude raciocina sobre o problema,
// chama ferramentas server-side pra executar auto-fixes determinísticos,
// e devolve resposta em linguagem natural com ações já aplicadas.
//
// Body:
//   {
//     licitacao_id: "uuid",
//     messages: [{role: "user"|"assistant", content: string}],
//     contexto?: {...}     // opcional, frontend pode pré-coletar
//   }
//
// Response (200):
//   {
//     ok: true,
//     resposta: "texto final do Cláudio",
//     acoes_executadas: [{tool: "executar_auto_fix", input: {...}, result: {...}}],
//     tokens_in, tokens_out
//   }
// =============================================================================

import { handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/json.ts';
import { getServiceRoleClient, requireAuthenticatedUser } from '../_shared/supabase.ts';
import { codesPendentesDaLicitacao } from '../_shared/codes-pendentes.ts';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOOL_LOOPS = 8;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | unknown[];
}

interface RequestBody {
  licitacao_id?: string;
  messages?: ChatMessage[];
  contexto?: Record<string, unknown>;
}

// =============================================================================
// System prompt
// =============================================================================
const SYSTEM_PROMPT = `Você é o **Cláudio**, assistente especializado em orçamentos de licitação pública brasileira, plugado no sistema PavCon Licitações.

# Domínio técnico
- **Bancos públicos**: SINAPI (federal), SICRO3 (DNIT), ORSE (Sergipe), SEINFRA (Ceará), SEDOP (Pará), SBC (Bahia), SETOP, EMBASA, FDE, CPOS, SUDECAP, IOPES, AGESUL, EMOP, SCO, DERPR, CAEMA, CAERN, COMPESA, SIURB, AGETOP, MAPP.
- **Orçafascio**: software que usa códigos desses bancos. Códigos descontinuados ou adaptados pelo órgão retornam preço R$ 0,00 silenciosamente.
- **Regras de licitação**: BDI fixo do edital (não muda na proposta), desconto não incide sobre mão de obra, valor da proposta NUNCA pode ultrapassar o edital (desclassificação).
- **Composições adaptadas**: o órgão modifica a composição oficial — sufixos como \`-ADAP\`, \`-A\`, \`adaptado\`, ou texto literal \`COMPOSIÇÃO XX\` no código indicam adaptação. Devem ser tratadas como PROPRIA.

# Seu papel
1. Analisar contexto da licitação que vou te passar
2. Identificar problemas conhecidos
3. **Executar correções automaticamente** via tools quando disponível (não só sugerir — APLICAR)
4. Explicar em linguagem clara o que fez e qual o próximo passo
5. Quando não tiver ferramenta apropriada, ser específico no que o orçamentista precisa fazer manualmente

# Tom
- Direto, em português brasileiro
- Conciso (máximo 3 parágrafos)
- Empático com prazo apertado de licitação
- Vai direto pro ponto
- Use emojis com moderação: 🔍 análise, ✓ sucesso, ⚠️ alerta, 🤖 quando você aplica fix

# Sobre tools
- Quando o problema tiver auto-fix, CHAME a tool imediatamente — não pergunte permissão
- Após executar tools, **dê resposta consolidada** explicando o que aconteceu
- Se uma tool falhar, explique o erro e proponha alternativa`;

// =============================================================================
// Tools (function calling)
// =============================================================================
const TOOLS = [
  {
    name: 'executar_auto_fix',
    description:
      'Executa um auto-fix determinístico na licitação atual. Use quando o problema tem solução padronizada. ' +
      'Retorna mensagem + número de mudanças aplicadas.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: {
          type: 'string',
          enum: ['reclassificar_codes_adaptados', 'aplicar_mapeamentos_pendentes'],
          description:
            'reclassificar_codes_adaptados: converte items SINAPI/ORSE com sufixo -ADAP/COMPOSIÇÃO XX pra PROPRIA. ' +
            'aplicar_mapeamentos_pendentes: limpa MyBase IDs pra recriar com codes mapeados recentemente.',
        },
      },
      required: ['tipo'],
    },
  },
  {
    name: 'obter_estado_atual',
    description:
      'Retorna estado atualizado da licitação: status, total esperado, codes pendentes, diagnósticos. ' +
      'Use quando precisar de dados frescos depois de executar um fix ou quando o contexto inicial parecer desatualizado.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'consultar_codes_pendentes',
    description:
      'Lista os códigos descontinuados que estão pendentes de mapeamento. ' +
      'Use quando o usuário pedir pra ajudar com codes específicos ou listar pendências.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max codes a retornar (default 10)' },
      },
    },
  },
  {
    name: 'sugerir_mapeamento_code',
    description:
      'Salva um mapeamento de code antigo → code novo na tabela orcafascio_code_mappings. ' +
      'Use quando você (Cláudio) souber com confiança alta o código moderno equivalente ' +
      'baseado na descrição do item. Depois disso o orçamentista deve clicar "🚀 Cadastrar tudo" pra aplicar.',
    input_schema: {
      type: 'object',
      properties: {
        fonte_original: { type: 'string', description: 'Banco antigo (ex: SINAPI)' },
        codigo_original: { type: 'string', description: 'Código legacy (ex: 7696)' },
        fonte_substituto: { type: 'string', description: 'Banco novo (geralmente o mesmo)' },
        codigo_substituto: { type: 'string', description: 'Código moderno equivalente' },
        justificativa: { type: 'string', description: 'Por que esse é o equivalente correto' },
      },
      required: ['fonte_original', 'codigo_original', 'fonte_substituto', 'codigo_substituto', 'justificativa'],
    },
  },
];

// =============================================================================
// Tool execution
// =============================================================================
async function executarTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: { licitacaoId: string; userId: string; admin: ReturnType<typeof getServiceRoleClient> },
): Promise<unknown> {
  const { licitacaoId, userId, admin } = ctx;

  if (toolName === 'executar_auto_fix') {
    const tipo = input.tipo as string;
    if (tipo === 'reclassificar_codes_adaptados') {
      const { data: items } = await admin
        .from('composicoes_extraidas')
        .select('id, fonte, codigo, metadata')
        .eq('licitacao_id', licitacaoId)
        .eq('tipo_linha', 'servico');

      const ehAdaptado = (fonte: string | null, codigo: string | null) => {
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
      const aReclassificar = (items ?? []).filter((it) => ehAdaptado(it.fonte, it.codigo));
      for (const it of aReclassificar) {
        const motivo = ehAdaptado(it.fonte, it.codigo);
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
              reclassificada_por: 'claudio_chat',
            },
          })
          .eq('id', it.id);
      }
      return {
        ok: true,
        mudancas: aReclassificar.length,
        mensagem: `${aReclassificar.length} item(ns) reclassificado(s) pra PROPRIA. Próximo: clique "🚀 Cadastrar tudo no Orçafascio".`,
      };
    }
    if (tipo === 'aplicar_mapeamentos_pendentes') {
      const { count } = await admin
        .from('composicoes_extraidas')
        .update({ orcafascio_composition_id: null }, { count: 'exact' })
        .eq('licitacao_id', licitacaoId)
        .eq('fonte', 'PROPRIA')
        .not('orcafascio_composition_id', 'is', null);
      return {
        ok: true,
        mudancas: count ?? 0,
        mensagem: `${count ?? 0} composição(ões) marcada(s) pra recriação com mapeamentos novos.`,
      };
    }
    return { ok: false, erro: `tipo inválido: ${tipo}` };
  }

  if (toolName === 'obter_estado_atual') {
    const { data: licitacao } = await admin
      .from('licitacoes')
      .select('id, titulo, status, orcafascio_orcamento_base_id, cadastro_resumo')
      .eq('id', licitacaoId)
      .maybeSingle();

    const { data: agg } = await admin
      .from('composicoes_extraidas')
      .select('fonte, preco_total, tipo_linha')
      .eq('licitacao_id', licitacaoId);
    const total = (agg ?? [])
      .filter((a) => a.tipo_linha === 'servico')
      .reduce((s, a) => s + Number(a.preco_total ?? 0), 0);
    const porFonte: Record<string, number> = {};
    for (const a of agg ?? []) {
      if (a.tipo_linha !== 'servico') continue;
      const f = a.fonte ?? '(sem fonte)';
      porFonte[f] = (porFonte[f] ?? 0) + Number(a.preco_total ?? 0);
    }

    return {
      licitacao,
      total_edital_com_bdi: total,
      por_fonte: porFonte,
    };
  }

  if (toolName === 'consultar_codes_pendentes') {
    const limit = Math.min(Number(input.limit ?? 10), 50);
    // codesPendentesDaLicitacao já escopa pela licitação antes de aplicar
    // qualquer corte — ver _shared/codes-pendentes.ts. O `limit` aqui é só
    // pra não devolver uma lista gigante pro Claude, aplicado DEPOIS do
    // escopo (antes disso, o .limit() ia direto na query global e podia
    // cortar antes mesmo de saber quais eram relevantes pra esta licitação).
    const codes = (await codesPendentesDaLicitacao(admin, licitacaoId)).slice(0, limit);
    return { codes };
  }

  if (toolName === 'sugerir_mapeamento_code') {
    const fonteOrig = (input.fonte_original as string).toUpperCase();
    const codOrig = input.codigo_original as string;
    const fonteSubst = (input.fonte_substituto as string).toUpperCase();
    const codSubst = input.codigo_substituto as string;
    const just = (input.justificativa as string) ?? '';

    await admin.from('orcafascio_code_mappings').upsert({
      fonte_original: fonteOrig,
      codigo_original: codOrig,
      fonte_substituto: fonteSubst,
      codigo_substituto: codSubst,
      motivo: `Cláudio: ${just}`.slice(0, 500),
    }, { onConflict: 'fonte_original,codigo_original' });

    return {
      ok: true,
      mensagem: `Mapeamento ${fonteOrig}/${codOrig} → ${fonteSubst}/${codSubst} salvo.`,
    };
  }

  return { ok: false, erro: `tool desconhecida: ${toolName}` };
}

// =============================================================================
// Handler principal
// =============================================================================
Deno.serve(async (req: Request) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse(405, 'Use POST.');

  let body: RequestBody;
  try { body = await req.json(); } catch { return errorResponse(400, 'JSON inválido.'); }

  if (!body.licitacao_id) return errorResponse(400, 'licitacao_id obrigatório.');
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse(400, 'messages obrigatório (array com pelo menos 1 mensagem).');
  }

  let userId: string;
  try {
    const u = await requireAuthenticatedUser(req);
    userId = u.id;
  } catch {
    return errorResponse(401, 'Não autenticado.');
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  const proxyUrl = Deno.env.get('CLAUDIO_PROXY_URL');
  const proxyToken = Deno.env.get('CLAUDIO_PROXY_TOKEN') ?? '';

  // 3 modos de operação, em ordem de preferência (API > Proxy > Stub):
  //   1. API Anthropic direta (sk-ant-...) — mais confiável, 24/7
  //   2. Proxy local (Claude Code via subscription Max) — só se API não tem
  //   3. Stub mode (nenhum dos 2 configurado)
  // Mudança histórica: prioridade era proxy-first, mas o proxy depende de PC
  // ligado + Claude Desktop logado como subprocess externo (instável). Quando
  // a API key está setada, ela é sempre a melhor escolha.
  if (!apiKey && !proxyUrl) {
    return jsonResponse({
      ok: false,
      stub: true,
      resposta:
        'Oi, sou o OrçaPav AI! 🤖\n\n' +
        'Ainda não fui plugado com a Claude API. O admin precisa configurar:\n' +
        '• `ANTHROPIC_API_KEY` (API direta), OU\n' +
        '• `CLAUDIO_PROXY_URL` (proxy local com Claude Code Max)\n\n' +
        'Enquanto isso, use o botão "🤖 OrçaPav AI resolver agora" nos diagnósticos detectados ' +
        'pra eu aplicar auto-fixes determinísticos.',
    });
  }

  const admin = getServiceRoleClient();

  // Anexa contexto inicial à primeira mensagem do user
  const contextoStr = body.contexto
    ? `\n\n<contexto_da_licitacao>${JSON.stringify(body.contexto)}</contexto_da_licitacao>`
    : '';

  const messages: Array<{ role: string; content: unknown }> = body.messages.map((m, i) => ({
    role: m.role,
    content: typeof m.content === 'string'
      ? (i === 0 && m.role === 'user' ? m.content + contextoStr : m.content)
      : m.content,
  }));

  const acoesExecutadas: Array<{ tool: string; input: unknown; result: unknown }> = [];

  // Despacha pro modo configurado — API tem prioridade.
  if (apiKey) {
    return await chatViaAnthropicAPI({
      apiKey,
      messages,
      licitacaoId: body.licitacao_id!,
      userId,
      admin,
      acoesExecutadas,
    });
  }

  return await chatViaProxy({
    proxyUrl: proxyUrl!,
    proxyToken,
    messages,
    licitacaoId: body.licitacao_id!,
    userId,
    admin,
    acoesExecutadas,
  });
});

// =============================================================================
// Modo 1: API Anthropic direta com tool use estruturado
// =============================================================================
async function chatViaAnthropicAPI(args: {
  apiKey: string;
  messages: Array<{ role: string; content: unknown }>;
  licitacaoId: string;
  userId: string;
  admin: ReturnType<typeof getServiceRoleClient>;
  acoesExecutadas: Array<{ tool: string; input: unknown; result: unknown }>;
}): Promise<Response> {
  const { apiKey, messages, licitacaoId, userId, admin, acoesExecutadas } = args;
  let tokensIn = 0;
  let tokensOut = 0;

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    const resp = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return errorResponse(502, `Claude API ${resp.status}: ${errText.slice(0, 400)}`);
    }
    const data = await resp.json();
    tokensIn += data.usage?.input_tokens ?? 0;
    tokensOut += data.usage?.output_tokens ?? 0;
    messages.push({ role: 'assistant', content: data.content });

    if (data.stop_reason !== 'tool_use') {
      const text = (data.content as Array<{ type: string; text?: string }>)
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n')
        .trim();
      return jsonResponse({
        ok: true,
        resposta: text || '(Cláudio não respondeu nada)',
        acoes_executadas: acoesExecutadas,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        loops: loop + 1,
        via: 'anthropic-api',
      });
    }

    const toolUses = (data.content as Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }>)
      .filter((b) => b.type === 'tool_use');
    const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
    for (const tu of toolUses) {
      try {
        const result = await executarTool(tu.name!, tu.input ?? {}, { licitacaoId, userId, admin });
        acoesExecutadas.push({ tool: tu.name!, input: tu.input, result });
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id!, content: JSON.stringify(result) });
      } catch (e) {
        const erro = e instanceof Error ? e.message : String(e);
        acoesExecutadas.push({ tool: tu.name!, input: tu.input, result: { erro } });
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id!, content: JSON.stringify({ ok: false, erro }) });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return jsonResponse({
    ok: true,
    resposta: '(Excedi o limite de iterações. Tente reformular.)',
    acoes_executadas: acoesExecutadas,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    loops: MAX_TOOL_LOOPS,
    via: 'anthropic-api',
  });
}

// =============================================================================
// Modo 2: Proxy local via Claude Code CLI (subscription Max do orçamentista)
// =============================================================================
// O CLI não suporta tool use estruturado — Claude responde texto puro.
// Estratégia: instruimos no system prompt o uso de XML tags pra tool calls,
// parseamos as tags na resposta, executamos, e mandamos resultado de volta
// pro Claude formatar a resposta final.
// =============================================================================
async function chatViaProxy(args: {
  proxyUrl: string;
  proxyToken: string;
  messages: Array<{ role: string; content: unknown }>;
  licitacaoId: string;
  userId: string;
  admin: ReturnType<typeof getServiceRoleClient>;
  acoesExecutadas: Array<{ tool: string; input: unknown; result: unknown }>;
}): Promise<Response> {
  const { proxyUrl, proxyToken, messages, licitacaoId, userId, admin, acoesExecutadas } = args;

  // System prompt aumentado pra instruir uso de XML tags pra tool calls
  const SYSTEM_COM_TOOLS = SYSTEM_PROMPT + `

# Tools disponíveis (via XML tags)

Como você está rodando via Claude Code CLI (que não tem function calling estruturado),
chame ferramentas usando XML tags. Eu vou parsear e executar.

Formato:
<tool_call>
{"name": "nome_da_tool", "input": {...}}
</tool_call>

Ferramentas disponíveis:
${TOOLS.map((t) => `- **${t.name}**: ${t.description}\n  Input schema: ${JSON.stringify(t.input_schema.properties)}`).join('\n')}

Regras:
1. Pra usar uma tool, escreva SÓ a tag <tool_call>...</tool_call> com JSON dentro. Eu executo e mando o resultado na próxima mensagem.
2. Quando tiver tudo que precisa, responda em texto natural sem tags.
3. Sempre uma tool por vez (não múltiplas tags numa só resposta).`;

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    const resp = await fetch(`${proxyUrl}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(proxyToken ? { authorization: `Bearer ${proxyToken}` } : {}),
      },
      body: JSON.stringify({
        system: SYSTEM_COM_TOOLS,
        messages: messages.map((m) => ({
          role: m.role,
          content: typeof m.content === 'string'
            ? m.content
            : JSON.stringify(m.content),
        })),
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return errorResponse(502, `Proxy Cláudio ${resp.status}: ${errText.slice(0, 400)}`);
    }
    const data = await resp.json();
    const texto: string = data.resposta ?? '';
    messages.push({ role: 'assistant', content: texto });

    // Parseia <tool_call>...</tool_call>
    const match = texto.match(/<tool_call>\s*([\s\S]+?)\s*<\/tool_call>/);
    if (!match) {
      // Sem tool call — resposta final
      return jsonResponse({
        ok: true,
        resposta: texto.trim(),
        acoes_executadas: acoesExecutadas,
        loops: loop + 1,
        via: 'proxy-claude-code',
      });
    }

    // Executa a tool
    let toolCall: { name?: string; input?: Record<string, unknown> };
    try {
      toolCall = JSON.parse(match[1]);
    } catch (e) {
      messages.push({
        role: 'user',
        content: `JSON inválido na tag tool_call: ${e instanceof Error ? e.message : String(e)}. Tenta de novo com JSON válido.`,
      });
      continue;
    }
    if (!toolCall.name) {
      messages.push({ role: 'user', content: 'Faltou "name" na tool_call.' });
      continue;
    }
    try {
      const result = await executarTool(toolCall.name, toolCall.input ?? {}, { licitacaoId, userId, admin });
      acoesExecutadas.push({ tool: toolCall.name, input: toolCall.input, result });
      messages.push({
        role: 'user',
        content: `<tool_result name="${toolCall.name}">${JSON.stringify(result)}</tool_result>`,
      });
    } catch (e) {
      const erro = e instanceof Error ? e.message : String(e);
      acoesExecutadas.push({ tool: toolCall.name, input: toolCall.input, result: { erro } });
      messages.push({
        role: 'user',
        content: `<tool_result name="${toolCall.name}" erro="true">${JSON.stringify({ ok: false, erro })}</tool_result>`,
      });
    }
  }
  return jsonResponse({
    ok: true,
    resposta: '(Excedi o limite de iterações via proxy.)',
    acoes_executadas: acoesExecutadas,
    loops: MAX_TOOL_LOOPS,
    via: 'proxy-claude-code',
  });
}
