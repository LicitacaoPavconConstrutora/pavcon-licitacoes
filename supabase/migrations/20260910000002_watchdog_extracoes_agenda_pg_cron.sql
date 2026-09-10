-- Roda o watchdog a cada 5 min: extração travada se resolve sozinha, sem
-- ninguém precisar mexer no banco à mão.
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Destrava o que já está preso agora (inclui a licitação de 10/09 e a de 27/08).
SELECT destravar_extracoes_travadas(15);

SELECT cron.schedule(
  'destravar-extracoes-travadas',
  '*/5 * * * *',
  $$SELECT destravar_extracoes_travadas(15);$$
);
