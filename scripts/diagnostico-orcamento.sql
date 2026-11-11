-- =============================================================================
-- scripts/diagnostico-orcamento.sql
--
-- Por que um orcamento do Orcafascio ficou vazio ou incompleto?
--
-- Como usar: troque o ID na linha "alvo_budget" abaixo, cole tudo no
-- SQL Editor do Supabase (projeto cwgjjjlyccgivscngzgz) e rode.
-- So le. Nao altera nada.
--
-- Devolve UMA linha com um JSON de tres partes:
--   licitacoes  - quem o sistema acha que e dono desse orcamento, e o resumo
--                 que ele gravou do ultimo cadastro
--   composicoes - quantas linhas a extracao gerou e, das composicoes
--                 proprias, quantas ja tem cadastro no MyBase (Passo 1)
--   chamadas    - as ultimas chamadas feitas ao Orcafascio por essa licitacao
--
-- Leitura rapida:
--   licitacoes = null            -> o sistema nao criou esse orcamento
--   proprias_sem_mybase > 0      -> o Passo 1 nao rodou ou nao terminou
--   nenhuma chamada a /items/    -> o envio dos itens nunca aconteceu
-- =============================================================================
with parametros as (
  select '6af4bc31a5dde5d5c5ae16a8'::text as alvo_budget
),
alvo as (
  select l.*
  from licitacoes l, parametros p
  where l.orcafascio_orcamento_base_id = p.alvo_budget
     or l.orcafascio_proposta_id = p.alvo_budget
     or l.cadastro_resumo::text like '%' || p.alvo_budget || '%'
),
resumo_composicoes as (
  select
    c.licitacao_id,
    count(*)                                                        as linhas,
    count(*) filter (where c.tipo_linha = 'grupo')                  as grupos,
    count(*) filter (where c.tipo_linha = 'servico')                as servicos,
    count(*) filter (where c.tipo_linha = 'servico'
                       and coalesce(btrim(c.codigo), '') = '')      as servicos_sem_codigo,
    count(*) filter (where c.tipo_linha = 'servico'
                       and upper(coalesce(c.fonte, '')) = 'PROPRIA') as proprias,
    count(*) filter (where c.tipo_linha = 'servico'
                       and upper(coalesce(c.fonte, '')) = 'PROPRIA'
                       and c.orcafascio_composition_id is null)     as proprias_sem_mybase
  from composicoes_extraidas c
  where c.licitacao_id in (select id from alvo)
  group by c.licitacao_id
),
ultimas_chamadas as (
  select
    a.created_at,
    a.metodo_http,
    a.endpoint,
    a.response_status,
    a.duracao_ms,
    left(a.response_payload::text, 400) as resposta
  from audit_log_integracoes a
  where a.licitacao_id in (select id from alvo)
  order by a.created_at desc
  limit 40
)
select jsonb_pretty(jsonb_build_object(
  'licitacoes', (
    select jsonb_agg(jsonb_build_object(
      'id', a.id,
      'titulo', left(a.titulo, 80),
      'status', a.status,
      'atualizada_em', a.updated_at,
      'orcamento_base_id', a.orcafascio_orcamento_base_id,
      'cadastro_resumo', a.cadastro_resumo
    ))
    from alvo a
  ),
  'composicoes', (select jsonb_agg(to_jsonb(r)) from resumo_composicoes r),
  'chamadas',    (select jsonb_agg(to_jsonb(u)) from ultimas_chamadas u)
)) as diagnostico;
