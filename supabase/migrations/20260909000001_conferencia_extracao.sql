-- Segunda passada de conferência (auditoria independente pós-extração).
-- Espelha o processo manual em 2 etapas que o assessor usa (extrair, depois
-- conferir contra a fonte) — hoje a Edge Function extracao-edital só extraía,
-- sem checagem cruzada, o que deixava passar itens inventados/fora de ordem.
ALTER TABLE extracoes_ocr
  ADD COLUMN conferencia_resultado JSONB;

COMMENT ON COLUMN extracoes_ocr.conferencia_resultado IS
  'Resultado da auditoria automática (Gemini Flash) comparando os itens extraídos contra o PDF original: {itens_verificados, divergencias: [{item_codigo, tipo, detalhe}]}. NULL quando a conferência não rodou (ex: falha antes dessa etapa).';
