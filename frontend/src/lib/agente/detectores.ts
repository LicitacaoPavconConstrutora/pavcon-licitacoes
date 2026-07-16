// =============================================================================
// Detectores do agente de suporte
// =============================================================================
// Cada detector é uma função pura que recebe contexto da licitação e
// retorna 0+ diagnósticos. Padrão: detectores são fáceis de testar
// isoladamente e fáceis de adicionar.
//
// Adicionar um detector novo:
//   1. Criar função `detectarX(ctx): Diagnostico[]`
//   2. Registrar em DETECTORES no final do arquivo
//   3. Implementar `acao_acionavel` correspondente em ações.ts
// =============================================================================

export type Severidade = 'info' | 'aviso' | 'erro' | 'sucesso';

export interface Diagnostico {
  tipo: string;
  severidade: Severidade;
  titulo: string;
  mensagem?: string;
  sugestao?: string;
  acao_acionavel?: {
    tipo: string;
    params: Record<string, unknown>;
    label: string;
  };
  contexto?: Record<string, unknown>;
}

export interface ContextoAnalise {
  licitacao: {
    id: string;
    status: string;
    titulo: string;
    orcafascio_orcamento_base_id: string | null;
    valor_total_edital?: number | null;
    cadastro_resumo: {
      cadastrado_em?: string;
      bancos_configurados?: string[];
      warnings?: string[];
      total_itens_batch?: number;
    } | null;
  };
  /** Total dos itens 'servico' somados (do banco Pavcon). */
  totalExtraidoServicos?: number;
  /** Total atual do orçamento no Orçafascio (lido via API ou cache). */
  totalOrcamentoOrcafascio?: number | null;
  /** CLAUDIO_PROXY_URL configurado no servidor — habilita "forçar total" via
   * automação de navegador (Playwright), a única forma segura de aplicar o
   * ajuste hoje (a chamada HTTP direta corrompe orçamentos — ver detector 8). */
  claudioProxyDisponivel?: boolean;
  cabecalho: {
    uf?: string;
    bdi_percentual?: number | string;
    data_base_descricao?: string;
    bases_utilizadas?: string[];
    com_desoneracao?: boolean;
  } | null;
  servicos: Array<{
    item_codigo: string;
    descricao: string;
    fonte: string | null;
    codigo: string | null;
    orcafascio_composition_id: string | null;
  }>;
  // Sub-itens com codes na tabela orcafascio_code_mappings sem substituto
  codesPendentes: Array<{
    fonte_original: string;
    codigo_original: string;
    descricao: string | null;
  }>;
  // Composições próprias sem detalhamento (sem sub-itens)
  composicoesVazias: Array<{
    item_codigo: string;
    codigo: string | null;
    descricao: string;
  }>;
}

// =============================================================================
// Detector 1: codes descontinuados (legacy) sem mapeamento
// =============================================================================
function detectarCodesLegacy(ctx: ContextoAnalise): Diagnostico[] {
  if (ctx.codesPendentes.length === 0) return [];
  // Conta por banco pra mensagem clara
  const porBanco = new Map<string, number>();
  for (const c of ctx.codesPendentes) {
    porBanco.set(c.fonte_original, (porBanco.get(c.fonte_original) ?? 0) + 1);
  }
  const breakdown = Array.from(porBanco.entries())
    .map(([b, n]) => `${b} (${n})`)
    .join(', ');
  return [{
    tipo: 'codes_descontinuados',
    severidade: 'erro',
    titulo: `${ctx.codesPendentes.length} código(s) descontinuado(s) sem mapeamento`,
    mensagem: `Banco(s): ${breakdown}. Esses itens ficarão com R$ 0,00 no orçamento.`,
    sugestao:
      'Mapeie cada code pra equivalente moderno em /dashboard/code-mappings. ' +
      'Próximos editais usam a substituição automaticamente.',
    acao_acionavel: {
      tipo: 'mapping_inline',
      params: { codes: ctx.codesPendentes.slice(0, 20) },
      label: '🔁 Mapear codes agora',
    },
    contexto: { codes: ctx.codesPendentes.slice(0, 10) },
  }];
}

// =============================================================================
// Detector 2: composições PROPRIA sem detalhamento (criadas em branco)
// =============================================================================
function detectarComposicoesVazias(ctx: ContextoAnalise): Diagnostico[] {
  if (ctx.composicoesVazias.length === 0) return [];
  return [{
    tipo: 'composicoes_vazias',
    severidade: 'aviso',
    titulo: `${ctx.composicoesVazias.length} composição(ões) própria(s) sem detalhamento`,
    mensagem:
      'Essas composições foram criadas no MyBase mas sem sub-itens — o JSON do edital não trouxe a planilha auxiliar. ' +
      'Preço final será R$ 0,00 até preencher manualmente.',
    sugestao:
      'Abra cada composição no Orçafascio e cole os insumos da planilha anexa do órgão. ' +
      'Ou re-extraia o JSON pedindo pro LLM incluir os anexos.',
    contexto: {
      composicoes: ctx.composicoesVazias.slice(0, 10).map((c) => ({
        codigo: c.codigo,
        descricao: c.descricao.slice(0, 80),
      })),
    },
  }];
}

// =============================================================================
// Detector 3: data_base_descricao genérica (alta chance de fallback)
// =============================================================================
function detectarDataBaseGenerica(ctx: ContextoAnalise): Diagnostico[] {
  const desc = ctx.cabecalho?.data_base_descricao ?? '';
  if (!desc) {
    return [{
      tipo: 'data_base_ausente',
      severidade: 'erro',
      titulo: 'data_base_descricao ausente no cabecalho',
      mensagem:
        'Sem data-base, o agente usa o mês passado como fallback. ' +
        'Codes do edital podem cair em versões erradas dos bancos e zerar preço. ' +
        'Causa comum de "código descontinuado" mesmo pra codes válidos.',
      sugestao:
        'Defina a data-base inline aqui (ex: "04/2026" ou "abril/2026"), ' +
        'ou re-extraia o JSON do PDF pedindo pro LLM incluir a data-base.',
      acao_acionavel: {
        tipo: 'definir_data_base_inline',
        params: {},
        label: '📅 Definir data-base agora',
      },
    }];
  }
  // Quando descrição menciona só 1 banco mas o edital usa múltiplos, avisa —
  // só INFORMATIVO: seguimos a data-base exatamente como o órgão declarou no
  // edital, sem inventar/completar nada. "PROPRIA" nunca entra nessa
  // comparação — não é banco de referência externo, não tem "data-base"
  // própria, e sempre ia gerar falso positivo (o edital declara UMA data-base
  // pros bancos de referência; composições próprias não precisam ser citadas).
  const bases = (ctx.cabecalho?.bases_utilizadas ?? []).filter(
    (b) => b.toUpperCase() !== 'PROPRIA',
  );
  const bancosMencionados = bases.filter((b) =>
    new RegExp(b, 'i').test(desc),
  );
  if (bases.length > 1 && bancosMencionados.length < bases.length) {
    return [{
      tipo: 'data_base_incompleta',
      severidade: 'info',
      titulo: 'data_base_descricao cita só parte dos bancos — segue o edital como está',
      mensagem:
        `Edital usa ${bases.join('+')} mas a descrição só cita ${
          bancosMencionados.join('+') || 'nenhum'
        } explicitamente. Isso é esperado quando o órgão declara uma única ` +
        'data-base pro edital inteiro — os demais bancos usam essa mesma data, ' +
        'exatamente como está no documento oficial. Nenhuma correção necessária.',
      contexto: { bases_referencia: bases, data_base_descricao: desc },
    }];
  }
  return [];
}

// =============================================================================
// Detector 4: bancos com UF fixa configurados com UF do edital
// =============================================================================
const BANCOS_UF_FIXA: Record<string, string> = {
  ORSE: 'SE', SBC: 'BA', SEINFRA: 'CE', SEDOP: 'PA',
  EMBASA: 'BA', SETOP: 'MG', FDE: 'SP', CPOS: 'SP',
  SUDECAP: 'MG', IOPES: 'ES', AGESUL: 'MS', EMOP: 'RJ',
  SCO: 'RJ', DERPR: 'PR', CAEMA: 'MA', CAERN: 'RN',
  COMPESA: 'PE',
};
function detectarBancoUFFixa(ctx: ContextoAnalise): Diagnostico[] {
  const bases = ctx.cabecalho?.bases_utilizadas ?? [];
  const ufEdital = (ctx.cabecalho?.uf ?? '').toUpperCase();
  if (!ufEdital) return [];
  const conflitos: string[] = [];
  for (const b of bases) {
    const fixed = BANCOS_UF_FIXA[b.toUpperCase()];
    if (fixed && fixed !== ufEdital) {
      conflitos.push(`${b} (use ${fixed}, não ${ufEdital})`);
    }
  }
  if (conflitos.length === 0) return [];
  return [{
    tipo: 'banco_uf_fixa_conflito',
    severidade: 'info',
    titulo: `${conflitos.length} banco(s) com UF fixa — agente já trata`,
    mensagem: `Bancos: ${conflitos.join(', ')}. O sistema usa a UF do banco automaticamente, ignorando a UF do edital.`,
    sugestao: 'Nenhuma ação necessária — só pra visibilidade.',
  }];
}

// =============================================================================
// Detector 5: cadastro_resumo NULL com status fase1_concluida (incompleto)
// =============================================================================
function detectarCadastroIncompleto(ctx: ContextoAnalise): Diagnostico[] {
  if (ctx.licitacao.status !== 'fase1_concluida') return [];
  if (ctx.licitacao.cadastro_resumo) return [];
  return [{
    tipo: 'cadastro_incompleto',
    severidade: 'aviso',
    titulo: 'Status fase1_concluida mas sem cadastro_resumo',
    mensagem: 'O cadastro do orçamento (Passo 2) pode não ter rodado completamente.',
    sugestao: 'Clique em "🚀 Cadastrar tudo no Orçafascio" pra completar o Passo 2.',
  }];
}

// =============================================================================
// Detector 6: orçamento com muitos items (>= 280, risco de chunking 300)
// =============================================================================
function detectarOrcamentoGrande(ctx: ContextoAnalise): Diagnostico[] {
  const total = ctx.servicos.length;
  if (total < 280) return [];
  return [{
    tipo: 'orcamento_grande_risco_chunking',
    severidade: 'aviso',
    titulo: `Orçamento com ${total} serviços — próximo do limite de chunk (300)`,
    mensagem:
      'Orçafascio processa batches em transações separadas; quando os items são divididos, ' +
      'alguns macros do segundo chunk podem ficar órfãos.',
    sugestao:
      'Após cadastro, abra o orçamento e confira se todos os macrosserviços estão presentes. ' +
      'Se faltar algum, use "Refazer cadastramento" na seção "Voltar etapa".',
  }];
}

// =============================================================================
// Detector 7: PROPRIA sem code do edital (vai usar COMPOSIC_<item>)
// =============================================================================
function detectarPropriaSemCodigo(ctx: ContextoAnalise): Diagnostico[] {
  const semCode = ctx.servicos.filter(
    (s) => s.fonte === 'PROPRIA' && (!s.codigo || s.codigo.trim() === ''),
  );
  if (semCode.length === 0) return [];
  return [{
    tipo: 'propria_sem_codigo',
    severidade: 'info',
    titulo: `${semCode.length} composição(ões) própria(s) sem código do órgão`,
    mensagem:
      'Essas composições vão receber código gerado pelo sistema (COMPOSIC_<item>). ' +
      'Pode dificultar a auditoria contra a planilha original.',
    sugestao:
      'Se o edital tinha código próprio (ex: "ADM LOCAL", "COMP 09"), edite o JSON na revisão e preencha o campo "codigo".',
    contexto: { exemplos: semCode.slice(0, 5).map((s) => s.item_codigo) },
  }];
}

// =============================================================================
// Detector 8: items reclassificados (SINAPI -ADAP virou PROPRIA)
// =============================================================================
function detectarReclassificados(ctx: ContextoAnalise): Diagnostico[] {
  // Esta detecção precisa que `servicos` tenha metadata exposto. Como não
  // temos isso no contexto atual, deixa pra extensão futura. Por enquanto,
  // detectamos códigos com padrões suspeitos diretamente.
  const suspeitos = ctx.servicos.filter((s) => {
    if (!s.codigo) return false;
    const c = s.codigo.toUpperCase();
    if (s.fonte === 'PROPRIA') return false;
    return (
      /[\s-]ADAPT?(?:AD[OA])?\s*$|^ADAPTAD[OA]\s|\sADAP\s|-A$/i.test(c) ||
      /^COMPOSI[CÇ][ÃA]O\s*[\d_-]+/i.test(c)
    );
  });
  if (suspeitos.length === 0) return [];
  return [{
    tipo: 'codes_adaptados_nao_reclassificados',
    severidade: 'erro',
    titulo: `${suspeitos.length} código(s) adaptado(s) marcado(s) como SINAPI/ORSE`,
    mensagem:
      'Esses items têm sufixo "-ADAP", "-A", "adaptado" ou texto literal "COMPOSIÇÃO XX" — ' +
      'são adaptações do órgão, não codes reais do banco público. Vão zerar no orçamento.',
    sugestao:
      'A normalização nova converte esses items pra PROPRIA automaticamente — ' +
      'volte pra revisão do JSON ("Voltar etapa") e re-importe pra aplicar o fix.',
    contexto: {
      exemplos: suspeitos.slice(0, 5).map((s) => ({
        item: s.item_codigo,
        fonte: s.fonte,
        codigo: s.codigo,
        descricao: s.descricao.slice(0, 60),
      })),
    },
  }];
}

// =============================================================================
// Detector 9: serviços sem fonte/código (planilha anexa faltando)
// =============================================================================
function detectarServicosSemFonte(ctx: ContextoAnalise): Diagnostico[] {
  const semFonte = ctx.servicos.filter((s) => !s.fonte || !s.codigo);
  if (semFonte.length === 0) return [];
  return [{
    tipo: 'servicos_sem_fonte',
    severidade: 'erro',
    titulo: `${semFonte.length} serviço(s) sem fonte/código`,
    mensagem:
      'Esses serviços não têm referência de banco — provavelmente são itens agregadores ' +
      'que tinham detalhamento em planilha anexa que o LLM não capturou.',
    sugestao:
      'Re-extraia o JSON pedindo pro LLM incluir planilhas anexas. ' +
      'Ou edite manualmente o JSON na revisão e adicione a fonte+código apropriados.',
    contexto: {
      exemplos: semFonte.slice(0, 5).map((s) => ({
        item: s.item_codigo,
        descricao: s.descricao.slice(0, 60),
      })),
    },
  }];
}

// =============================================================================
// Detector 10: orçamento Orçafascio muito abaixo do total extraído
// =============================================================================
// Quando o cadastramento gera composições em branco (sub-itens faltando) ou
// codes que falham, o total do orçamento no Orçafascio fica MUITO abaixo do
// total extraído da planilha do edital. Cláudio detecta o gap e oferece
// "forçar total" via ajustarValor — fix pragmático enquanto a re-extração
// completa não roda.
function detectarOrcamentoAbaixoDoEdital(ctx: ContextoAnalise): Diagnostico[] {
  // HISTÓRICO (jun/2026): a ação "Forçar total" chamava ajustarValor via HTTP
  // direto, que CORROMPEU o budget no Orçafascio duas vezes (visto em SEFIR
  // 02, SEINFRA, SEGOV — budget virava 500 ao abrir). Causa raiz: as duas
  // tentativas adivinhavam a sequência de campos/URLs do endpoint interno em
  // vez de reproduzir o que o navegador real faz.
  //
  // jul/2026: reativado COM ação, mas só quando `claudioProxyDisponivel` —
  // nesse caso a ação roda via automação de navegador (Playwright, no
  // Cláudio Proxy) que clica no formulário real em vez de adivinhar a API.
  // Sem o proxy configurado, continua só o aviso manual de antes.
  if (!ctx.licitacao.orcafascio_orcamento_base_id) return [];
  const totalExtraido = ctx.totalExtraidoServicos ?? 0;
  if (totalExtraido <= 0) return [];
  const temComposVazias = (ctx.composicoesVazias?.length ?? 0) > 0;
  if (!temComposVazias) return [];
  const moeda = (n: number) =>
    n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  if (ctx.claudioProxyDisponivel) {
    return [{
      tipo: 'orcamento_abaixo_do_edital_auto',
      severidade: 'aviso',
      titulo: `Total deve ser ${moeda(totalExtraido)} — abaixo do edital no Orçafascio`,
      mensagem:
        `${ctx.composicoesVazias?.length ?? 0} composição(ões) em branco contribuem R$ 0,00 ` +
        `— total do Orçafascio fica abaixo do edital.`,
      sugestao:
        `Clique pra ajustar via Cláudio Proxy (automação de navegador — clica no formulário ` +
        `real do Orçafascio, não usa mais a API que corrompia orçamentos). ` +
        `Primeira vez usando essa ação numa licitação real: confira o orçamento no Orçafascio ` +
        `depois pra confirmar que aplicou certo.`,
      acao_acionavel: {
        tipo: 'forcar_total_inline',
        params: { valor_alvo: totalExtraido },
        label: '💰 Forçar total agora (via navegador)',
      },
      contexto: { total_extraido: totalExtraido },
    }];
  }

  // Sem proxy configurado: mantém só o aviso manual (comportamento anterior).
  return [{
    tipo: 'orcamento_abaixo_do_edital_manual',
    severidade: 'aviso',
    titulo: `Total deve ser ${moeda(totalExtraido)} — ajustar MANUAL no Orçafascio`,
    mensagem:
      `${ctx.composicoesVazias?.length ?? 0} composição(ões) em branco contribuem R$ 0,00 ` +
      `— total do Orçafascio fica abaixo do edital. NÃO use a API ajustarValor direto ` +
      `(corrompe budgets — bug deles). Configure o Cláudio Proxy (claudio-proxy/) pra ` +
      `habilitar o ajuste automático via navegador.`,
    sugestao:
      `Abre o orçamento no Orçafascio, vai em "Editar → Ajustar valor", ` +
      `cola ${moeda(totalExtraido)} e confirma. A UI deles aplica certinho.`,
    contexto: { total_extraido: totalExtraido },
  }];
}

// =============================================================================
// Orchestrator
// =============================================================================
export const DETECTORES: Array<(ctx: ContextoAnalise) => Diagnostico[]> = [
  detectarCodesLegacy,
  detectarComposicoesVazias,
  detectarDataBaseGenerica,
  detectarBancoUFFixa,
  detectarCadastroIncompleto,
  detectarOrcamentoGrande,
  detectarPropriaSemCodigo,
  detectarReclassificados,
  detectarServicosSemFonte,
  detectarOrcamentoAbaixoDoEdital,
];

export function rodarAnalise(ctx: ContextoAnalise): Diagnostico[] {
  const todos: Diagnostico[] = [];
  for (const detector of DETECTORES) {
    try {
      todos.push(...detector(ctx));
    } catch (e) {
      // Detector individual quebrou — log e segue
      console.error('[agente] detector falhou:', e);
    }
  }
  return todos;
}
