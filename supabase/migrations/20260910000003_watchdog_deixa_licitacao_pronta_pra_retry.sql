-- Ajuste no watchdog: deixar a licitação em 'erro' não bastava.
-- 'erro' NÃO está em VALID_START_STATUSES da Edge Function, e startExtraction
-- chama a function direto (sem resetar status) — então destravar pra 'erro'
-- ainda obrigava o orçamentista a clicar "resetar" antes de reextrair.
-- Deixando em 'aguardando_extracao' o botão de extrair volta a funcionar de
-- primeira. O erro em si continua visível na linha de extracoes_ocr ('falha'
-- + mensagem do watchdog), então nada de informação se perde.
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
             '(limite de tempo/memória do EdgeRuntime). A licitação foi liberada: clique ' ||
             'em extrair novamente. Se repetir, o PDF pode estar grande demais pro modo inline.', 2000)
     WHERE status = 'processando'
       AND created_at < now() - make_interval(mins => p_limite_minutos)
    RETURNING licitacao_id
  )
  SELECT array_agg(DISTINCT licitacao_id), count(*)
    INTO v_licitacoes, v_total
    FROM travadas;

  IF v_licitacoes IS NOT NULL THEN
    -- 'extraindo' -> 'erro' é sempre permitido pelo trigger, e sair de 'erro'
    -- pra qualquer estado também. Dois passos porque 'extraindo' ->
    -- 'aguardando_extracao' não é uma transição válida direta.
    UPDATE licitacoes SET status = 'erro'
     WHERE id = ANY(v_licitacoes) AND status = 'extraindo';
    UPDATE licitacoes SET status = 'aguardando_extracao'
     WHERE id = ANY(v_licitacoes) AND status = 'erro';
  END IF;

  RETURN coalesce(v_total, 0);
END;
$$;
