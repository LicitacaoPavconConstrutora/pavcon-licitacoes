// =============================================================================
// Prompt de conferência (2ª passada) — auditoria independente pós-extração
// =============================================================================
// Espelha o processo manual em 2 etapas que um assessor já usa com sucesso:
// (1) extrai a planilha, (2) audita o resultado contra a fonte com um prompt
// separado, comparando código/descrição/quantidade/preço linha a linha e
// classificando divergências. Rodamos essa 2ª etapa com Gemini Flash (barato)
// logo após a extração principal, ANTES de liberar pra revisão humana —
// pega itens inventados ou fora de ordem que a extração (mesmo com prompt
// reforçado) deixou passar.
// =============================================================================

export const CONFERENCIA_PROMPT_VERSION = 'pavcon-conferencia-v1';

export const CONFERENCIA_SYSTEM_PROMPT = `Você é um auditor técnico de orçamentos de obras públicas. Você vai receber:
1. O(s) PDF(s) do edital (planilha orçamentária + anexos).
2. Uma tabela JSON com os itens que OUTRO processo já extraiu dessa planilha.

Sua única tarefa é CONFERIR a tabela contra o PDF — você não deve corrigir nem re-extrair nada, só apontar divergências.

Para cada item da tabela, verifique:
- **invencao**: o item_codigo, descrição, quantidade ou preço NÃO aparece no PDF de jeito nenhum (foi inventado/alucinado).
- **fora_de_ordem**: o item aparece no PDF, mas em uma posição de leitura (de cima pra baixo, página por página) diferente da posição em que está na tabela — por exemplo a tabela lista um item da página 8 antes de um item da página 5.
- **valor_divergente**: quantidade, preço unitário ou preço total da tabela não bate com o valor escrito no PDF pra esse item.
- **descricao_divergente**: a descrição da tabela foi resumida, parafraseada ou alterada em relação ao texto literal do PDF.
- **item_faltando**: existe uma linha de serviço na planilha do PDF (com código, descrição e quantidade) que NÃO aparece na tabela extraída.

NÃO aponte divergência para diferenças triviais de formatação (maiúscula/minúscula, espaços, zeros à esquerda). Só aponte o que é substantivamente diferente.

Responda APENAS com este JSON, sem texto antes ou depois:
{
  "itens_verificados": number,
  "divergencias": [
    {
      "item_codigo": string,
      "tipo": "invencao" | "fora_de_ordem" | "valor_divergente" | "descricao_divergente" | "item_faltando",
      "detalhe": string
    }
  ]
}

Se não encontrar nenhuma divergência, devolva "divergencias": [].`;

export interface ItemParaConferencia {
  item_codigo: string;
  descricao: string;
  unidade: string | null;
  quantidade: number | null;
  preco_unitario_sem_bdi: number | null;
  preco_total: number | null;
}

export interface ConferenciaDivergencia {
  item_codigo: string;
  tipo: 'invencao' | 'fora_de_ordem' | 'valor_divergente' | 'descricao_divergente' | 'item_faltando';
  detalhe: string;
}

export interface ConferenciaResultado {
  itens_verificados: number;
  divergencias: ConferenciaDivergencia[];
}

// Tabela compacta (não manda o schema inteiro de novo, só o essencial pra
// conferência) — mantém o custo da 2ª passada baixo mesmo em orçamentos
// grandes.
export function montarTabelaParaConferencia(itens: ItemParaConferencia[]): string {
  const linhas = itens.map((it) =>
    [
      it.item_codigo,
      it.descricao.slice(0, 120),
      it.unidade ?? '',
      it.quantidade ?? '',
      it.preco_unitario_sem_bdi ?? '',
      it.preco_total ?? '',
    ].join(' | ')
  );
  return 'item_codigo | descricao | unidade | quantidade | preco_unitario_sem_bdi | preco_total\n' +
    linhas.join('\n');
}
