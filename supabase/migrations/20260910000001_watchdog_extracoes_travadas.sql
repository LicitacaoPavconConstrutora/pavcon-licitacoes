-- Watchdog de extração travada.
--
-- PADRÃO DETECTADO (set/2026): quando o worker da Edge Function é encerrado
-- antes de terminar (limite de tempo/memória do EdgeRuntime), o bloco catch
-- do runExtractionAsync nunca roda — a linha fica em 'processando' e a
-- licitação em 'extraindo' PARA SEMPRE. Como 'extraindo' não está em
-- VALID_START_STATUSES, o orçamentista não consegue nem reextrair: fica preso
-- num loop de "tentar novamente" que sempre falha. Aconteceu em 27/08 e
-- 10/09.
--
-- Esta função fecha essas extrações órfãs e devolve a licitação pra 'erro'
-- (transição sempre permitida), estado do qual o retry já funciona.
CREATE OR REPLACE FUNCTION destravar_extracoes_travadas(p_limite_minutos INT DEFAULT 15)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_licitacoes UUID[];
  v_total INT := 0;
BEGIN
  WITH travadas AS (
    UPDATE extracoes_ocr
       SET status = 'falha',
           concluido_em = now(),
           erro_detalhe = left(
             coalesce(erro_detalhe || ' | ', '') ||
             '[watchdog] Sem conclusão há mais de ' || p_limite_minutos ||
             ' min — o worker da Edge Function foi encerrado antes de gravar o resultado ' ||
             '(limite de tempo/memória do EdgeRuntime). Reextraia; se repetir, o PDF pode ' ||
             'estar grande demais pro modo inline.', 2000)
     WHERE status = 'processando'
       AND created_at < now() - make_interval(mins => p_limite_minutos)
    RETURNING licitacao_id
  )
  SELECT array_agg(DISTINCT licitacao_id), count(*)
    INTO v_licitacoes, v_total
    FROM travadas;

  IF v_licitacoes IS NOT NULL THEN
    UPDATE licitacoes
       SET status = 'erro'
     WHERE id = ANY(v_licitacoes)
       AND status IN ('extraindo', 'aguardando_extracao');
  END IF;

  RETURN coalesce(v_total, 0);
END;
$$;

COMMENT ON FUNCTION destravar_extracoes_travadas(INT) IS
  'Fecha extracoes_ocr presas em processando (worker morto sem gravar) e devolve a licitação pra erro, liberando o retry. Roda via pg_cron a cada 5 min.';

REVOKE ALL ON FUNCTION destravar_extracoes_travadas(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION destravar_extracoes_travadas(INT) TO service_role;
