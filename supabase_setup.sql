-- =========================================================
-- SETUP DO DASHBOARD "disparochat" — rode isso no
-- Supabase: Project > SQL Editor > New query > Run
-- =========================================================
-- Premissas (ajuste se não bater com a regra real do seu negócio):
--   - "Envio"     = linha cujo campo `realizado` não é nulo
--   - "Leads"     = total de linhas no filtro
--   - "Interação" = linhas em que `interacao` não é nulo
--   - "Pagas"     = linhas em que `pagas` não é nulo (contagem)
--   - "Gastado"   = soma de `gasto` * 5.15 * 1.10 (conforme campo personalizado do Data Studio)
--   - "Faturado"  = soma de `pagas` (valor monetário) - Gastado
--   - "Valor"     = soma de `valor` em todas as linhas do filtro
--   - "ROI"       = Faturado / Gastado
--   - "Conversão" = Pagas / Leads
--
-- OBS: as colunas `valor` e `pagas` são do tipo texto no banco (às vezes vêm
-- como "erro" em vez de número), então uso uma conversão segura que ignora
-- qualquer valor que não seja um número válido.
-- =========================================================

-- função auxiliar: converte texto para numeric com segurança
-- (retorna null se não for um número válido, em vez de dar erro)
create or replace function safe_numeric(txt text)
returns numeric
language sql
immutable
as $$
  select case
    when txt is null then null
    when trim(txt) ~ '^-?[0-9]+(\.[0-9]+)?$' then trim(txt)::numeric
    else null
  end;
$$;

-- 1) KPIs principais (cards do topo)
-- (precisa dropar antes: mudamos o formato do retorno, adicionando interacao_qtd e tempo_resposta_min)
drop function if exists dashboard_kpis(text, text, text, timestamptz, timestamptz);

create or replace function dashboard_kpis(
  p_campanha text default null,
  p_origem text default null,
  p_meta text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns table (
  total_leads bigint,
  gastado numeric,
  interacao_pct numeric,
  interacao_qtd bigint,
  pagas bigint,
  faturado numeric,
  roi numeric,
  conversao_pct numeric,
  valor numeric,
  tempo_resposta_min numeric
)
language sql
security definer
set search_path = public
stable
as $$
  with base as (
    select *
    from disparochat
    where (p_campanha is null or campanha = p_campanha)
      and (p_origem is null or origem = p_origem)
      and (p_meta is null or meta = p_meta)
      and (p_date_from is null or realizado >= p_date_from)
      and (p_date_to is null or realizado <= p_date_to)
  ),
  agg as (
    select
      count(*) as total_leads,
      coalesce(sum(gasto), 0) as gasto_bruto,
      round(coalesce(sum(gasto), 0) * 5.15 * 1.10, 2) as gastado,
      count(*) filter (where interacao is not null) as interacao_qtd,
      count(*) filter (where pagas is not null) as pagas_count,
      coalesce(sum(pagas), 0) as pagas_valor,
      coalesce(sum(safe_numeric(valor)), 0) as valor_total,
      avg(
        extract(epoch from (data_ultima_interacao - coalesce(reenvio, realizado))) / 60.0
      ) filter (
        where data_ultima_interacao is not null
          and coalesce(reenvio, realizado) is not null
          and data_ultima_interacao >= coalesce(reenvio, realizado)
      ) as tempo_resposta_min
    from base
  )
  select
    total_leads,
    gastado,
    case when total_leads > 0
      then round(100.0 * interacao_qtd / total_leads, 2)
      else 0 end as interacao_pct,
    interacao_qtd,
    pagas_count as pagas,
    round(pagas_valor - gastado, 2) as faturado,
    case when gasto_bruto > 0
      then round((pagas_valor - gastado) / gasto_bruto, 2)
      else 0 end as roi,
    case when total_leads > 0
      then round(100.0 * pagas_count / total_leads, 2)
      else 0 end as conversao_pct,
    round(valor_total, 2) as valor,
    round(tempo_resposta_min, 1) as tempo_resposta_min
  from agg;
$$;

-- 2) Envios por dia (gráfico de barras no topo) — inclui reenvios também
-- (precisa dropar antes: mudamos o formato do retorno, adicionando a coluna reenvios)
drop function if exists dashboard_envios_por_dia(text, text, text, timestamptz, timestamptz);

create or replace function dashboard_envios_por_dia(
  p_campanha text default null,
  p_origem text default null,
  p_meta text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns table (
  dia date,
  envios bigint,
  reenvios bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with envios_dia as (
    select (realizado at time zone 'America/Sao_Paulo')::date as dia, count(*) as envios
    from disparochat
    where realizado is not null
      and (p_campanha is null or campanha = p_campanha)
      and (p_origem is null or origem = p_origem)
      and (p_meta is null or meta = p_meta)
      and (p_date_from is null or realizado >= p_date_from)
      and (p_date_to is null or realizado <= p_date_to)
    group by 1
  ),
  reenvios_dia as (
    select (reenvio at time zone 'America/Sao_Paulo')::date as dia, count(*) as reenvios
    from disparochat
    where reenvio is not null
      and (p_campanha is null or campanha = p_campanha)
      and (p_origem is null or origem = p_origem)
      and (p_meta is null or meta = p_meta)
      and (p_date_from is null or reenvio >= p_date_from)
      and (p_date_to is null or reenvio <= p_date_to)
    group by 1
  )
  select
    coalesce(e.dia, r.dia) as dia,
    coalesce(e.envios, 0) as envios,
    coalesce(r.reenvios, 0) as reenvios
  from envios_dia e
  full outer join reenvios_dia r on e.dia = r.dia
  order by 1;
$$;

-- 3) Tabela de campanhas únicas (Leads + Reenvios)
create or replace function dashboard_campanhas(
  p_origem text default null,
  p_meta text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns table (
  campanha text,
  leads bigint,
  reenvios bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    campanha,
    count(*) as leads,
    count(*) filter (where reenvio is not null) as reenvios
  from disparochat
  where campanha is not null
    and (p_origem is null or origem = p_origem)
    and (p_meta is null or meta = p_meta)
    and (p_date_from is null or realizado >= p_date_from)
    and (p_date_to is null or realizado <= p_date_to)
  group by campanha
  order by leads desc;
$$;

-- 3b) Distribuição de leads por valor de "conversa"
create or replace function dashboard_por_conversa(
  p_campanha text default null,
  p_origem text default null,
  p_meta text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns table (
  valor text,
  leads bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    coalesce(conversa, '(vazio)') as valor,
    count(*) as leads
  from disparochat
  where (p_campanha is null or campanha = p_campanha)
    and (p_origem is null or origem = p_origem)
    and (p_meta is null or meta = p_meta)
    and (p_date_from is null or realizado >= p_date_from)
    and (p_date_to is null or realizado <= p_date_to)
  group by 1
  order by leads desc
  limit 20;
$$;

-- 3c) Distribuição de leads por valor de "meta" (status de entrega da Meta/WhatsApp)
create or replace function dashboard_por_meta(
  p_campanha text default null,
  p_origem text default null,
  p_meta text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns table (
  valor text,
  leads bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    coalesce(meta, '(vazio)') as valor,
    count(*) as leads
  from disparochat
  where (p_campanha is null or campanha = p_campanha)
    and (p_origem is null or origem = p_origem)
    and (p_date_from is null or realizado >= p_date_from)
    and (p_date_to is null or realizado <= p_date_to)
  group by 1
  order by leads desc
  limit 20;
$$;

-- 3d) Distribuição de leads por valor de "mensagem"
create or replace function dashboard_por_mensagem(
  p_campanha text default null,
  p_origem text default null,
  p_meta text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns table (
  valor text,
  leads bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    coalesce(mensagem, '(vazio)') as valor,
    count(*) as leads
  from disparochat
  where (p_campanha is null or campanha = p_campanha)
    and (p_origem is null or origem = p_origem)
    and (p_meta is null or meta = p_meta)
    and (p_date_from is null or realizado >= p_date_from)
    and (p_date_to is null or realizado <= p_date_to)
  group by 1
  order by leads desc
  limit 20;
$$;

-- =========================================================
-- PAINEL "LEILÃO — DETALHADO" (visão de operação em tempo real)
-- Mapeamento de status (coluna meta): sent=enviado, delivered=entregue,
-- read=lido, failed=falha. "Template" = coluna mensagem.
-- =========================================================

-- 5) KPIs do dia — mensagens, entregues/lidas %, falhas %, templates ativos
-- IMPORTANTE: o servidor do Postgres roda em UTC (3h à frente de Brasília), então
-- convertemos os timestamps para America/Sao_Paulo antes de comparar as datas.
-- p_data (opcional) permite escolher outro dia; padrão é hoje (em horário de Brasília).
drop function if exists dashboard_hoje_kpis();

create or replace function dashboard_hoje_kpis(
  p_data date default null,
  p_campanha text default null
)
returns table (
  mensagens_hoje bigint,
  entregues_lidas_qtd bigint,
  entregues_lidas_pct numeric,
  falhas_qtd bigint,
  falhas_pct numeric,
  templates_ativos bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with alvo as (
    select coalesce(p_data, (now() at time zone 'America/Sao_Paulo')::date) as dia
  ),
  hoje as (
    select d.*
    from disparochat d, alvo
    where d.meta in ('sent', 'delivered', 'read', 'failed')
      and (p_campanha is null or d.campanha = p_campanha)
      and (
        (coalesce(d.reenvio, d.realizado) is not null
          and (coalesce(d.reenvio, d.realizado) at time zone 'America/Sao_Paulo')::date = alvo.dia)
        or (d.status_atualizado is not null
          and (d.status_atualizado at time zone 'America/Sao_Paulo')::date = alvo.dia)
      )
  ),
  agg as (
    select
      count(*) as total,
      count(*) filter (where meta in ('delivered', 'read')) as entregues_lidas,
      count(*) filter (where meta = 'failed') as falhas,
      count(distinct mensagem) filter (where mensagem is not null) as templates_ativos
    from hoje
  )
  select
    total,
    entregues_lidas,
    case when total > 0 then round(100.0 * entregues_lidas / total, 1) else 0 end,
    falhas,
    case when total > 0 then round(100.0 * falhas / total, 1) else 0 end,
    templates_ativos
  from agg;
$$;

-- 6) Taxa de falha por minuto (janela recente, default últimos 60 minutos, tempo real)
drop function if exists dashboard_falha_por_minuto(int);

create or replace function dashboard_falha_por_minuto(
  p_minutos int default 60,
  p_campanha text default null
)
returns table (
  minuto timestamptz,
  total bigint,
  falhas bigint,
  falha_pct numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select
    date_trunc('minute', status_atualizado) as minuto,
    count(*) as total,
    count(*) filter (where meta = 'failed') as falhas,
    case when count(*) > 0
      then round(100.0 * count(*) filter (where meta = 'failed') / count(*), 1)
      else 0 end as falha_pct
  from disparochat
  where status_atualizado is not null
    and status_atualizado >= now() - (greatest(p_minutos, 1) || ' minutes')::interval
    and meta in ('sent', 'delivered', 'read', 'failed')
    and (p_campanha is null or campanha = p_campanha)
  group by 1
  order by 1;
$$;

-- 7) Por template (mensagem) — enviados/entregues/lidas/falhas + falha %
-- Só entram templates preenchidos de verdade (mensagem is not null) — a lista
-- é dinâmica, baseada no que existir na base, nunca fixa.
drop function if exists dashboard_por_template_hoje();

create or replace function dashboard_por_template_hoje(
  p_data date default null,
  p_campanha text default null
)
returns table (
  template text,
  enviados bigint,
  entregues bigint,
  lidas bigint,
  falhas bigint,
  falha_pct numeric
)
language sql
security definer
set search_path = public
stable
as $$
  with alvo as (
    select coalesce(p_data, (now() at time zone 'America/Sao_Paulo')::date) as dia
  )
  select
    d.mensagem as template,
    count(*) filter (where d.meta = 'sent') as enviados,
    count(*) filter (where d.meta = 'delivered') as entregues,
    count(*) filter (where d.meta = 'read') as lidas,
    count(*) filter (where d.meta = 'failed') as falhas,
    case when count(*) filter (where d.meta in ('sent', 'delivered', 'read', 'failed')) > 0
      then round(
        100.0 * count(*) filter (where d.meta = 'failed') /
        count(*) filter (where d.meta in ('sent', 'delivered', 'read', 'failed')), 1)
      else 0 end as falha_pct
  from disparochat d, alvo
  where d.mensagem is not null
    and d.meta in ('sent', 'delivered', 'read', 'failed')
    and (p_campanha is null or d.campanha = p_campanha)
    and (
      (coalesce(d.reenvio, d.realizado) is not null
        and (coalesce(d.reenvio, d.realizado) at time zone 'America/Sao_Paulo')::date = alvo.dia)
      or (d.status_atualizado is not null
        and (d.status_atualizado at time zone 'America/Sao_Paulo')::date = alvo.dia)
    )
  group by d.mensagem
  order by (
    count(*) filter (where d.meta = 'sent') + count(*) filter (where d.meta = 'delivered') +
    count(*) filter (where d.meta = 'read') + count(*) filter (where d.meta = 'failed')
  ) desc;
$$;

-- =========================================================
-- PAINEL "ENTRADAS LP" (tabela total_produtos)
-- =========================================================

-- 8) KPIs da visão Entradas LP
create or replace function dashboard_produtos_kpis(
  p_campanha text default null,
  p_produto text default null,
  p_origem text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns table (
  total bigint,
  interacao_qtd bigint,
  interacao_pct numeric,
  aprovados_qtd bigint,
  aprovados_pct numeric,
  reprovados_qtd bigint,
  pagas_qtd bigint,
  valor numeric,
  conversao_total_pct numeric,
  conversao_aprovados_pct numeric
)
language sql
security definer
set search_path = public
stable
as $$
  with base as (
    select *
    from total_produtos
    where (p_campanha is null or campanha = p_campanha)
      and (p_produto is null or produto = p_produto)
      and (p_origem is null or origem = p_origem)
      and (p_date_from is null or created_at >= p_date_from)
      and (p_date_to is null or created_at <= p_date_to)
  ),
  agg as (
    select
      count(*) as total,
      count(*) filter (where interacao = 1) as interacao_qtd,
      count(*) filter (where aprovadas = 1) as aprovados_qtd,
      count(*) filter (where reprovadas = 1) as reprovados_qtd,
      count(*) filter (where pagas = 1) as pagas_qtd,
      coalesce(sum(valor) filter (where pagas = 1), 0) as valor
    from base
  )
  select
    total,
    interacao_qtd,
    case when total > 0 then round(100.0 * interacao_qtd / total, 2) else 0 end,
    aprovados_qtd,
    case when total > 0 then round(100.0 * aprovados_qtd / total, 2) else 0 end,
    reprovados_qtd,
    pagas_qtd,
    round(valor, 2),
    case when total > 0 then round(100.0 * pagas_qtd / total, 2) else 0 end,
    case when aprovados_qtd > 0 then round(100.0 * pagas_qtd / aprovados_qtd, 2) else 0 end
  from agg;
$$;

-- 9) Entradas por dia e produto (formato longo — o front-end pivota pra empilhar)
create or replace function dashboard_produtos_entradas_por_dia(
  p_campanha text default null,
  p_produto text default null,
  p_origem text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns table (
  dia date,
  produto text,
  entradas bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    (created_at at time zone 'America/Sao_Paulo')::date as dia,
    coalesce(produto, '(vazio)') as produto,
    count(*) as entradas
  from total_produtos
  where created_at is not null
    and (p_campanha is null or campanha = p_campanha)
    and (p_produto is null or produto = p_produto)
    and (p_origem is null or origem = p_origem)
    and (p_date_from is null or created_at >= p_date_from)
    and (p_date_to is null or created_at <= p_date_to)
  group by 1, 2
  order by 1;
$$;

-- 10) Aprovadas por dia (linha do gráfico)
create or replace function dashboard_produtos_aprovadas_por_dia(
  p_campanha text default null,
  p_produto text default null,
  p_origem text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns table (
  dia date,
  aprovadas bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    (created_at at time zone 'America/Sao_Paulo')::date as dia,
    count(*) filter (where aprovadas = 1) as aprovadas
  from total_produtos
  where created_at is not null
    and (p_campanha is null or campanha = p_campanha)
    and (p_produto is null or produto = p_produto)
    and (p_origem is null or origem = p_origem)
    and (p_date_from is null or created_at >= p_date_from)
    and (p_date_to is null or created_at <= p_date_to)
  group by 1
  order by 1;
$$;

-- 11) Tabela por campanha + produto
create or replace function dashboard_produtos_campanhas(
  p_produto text default null,
  p_origem text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns table (
  campanha text,
  produto text,
  leads bigint,
  interacao_pct numeric,
  aprovadas bigint,
  conversao_aprovados_pct numeric,
  pagas bigint,
  valor_liberado numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select
    coalesce(campanha, '(vazio)') as campanha,
    coalesce(produto, '(vazio)') as produto,
    count(*) as leads,
    case when count(*) > 0
      then round(100.0 * count(*) filter (where interacao = 1) / count(*), 2)
      else 0 end as interacao_pct,
    count(*) filter (where aprovadas = 1) as aprovadas,
    case when count(*) filter (where aprovadas = 1) > 0
      then round(100.0 * count(*) filter (where pagas = 1) / count(*) filter (where aprovadas = 1), 2)
      else 0 end as conversao_aprovados_pct,
    count(*) filter (where pagas = 1) as pagas,
    coalesce(sum(valor) filter (where pagas = 1), 0) as valor_liberado
  from total_produtos
  where (p_produto is null or produto = p_produto)
    and (p_origem is null or origem = p_origem)
    and (p_date_from is null or created_at >= p_date_from)
    and (p_date_to is null or created_at <= p_date_to)
  group by campanha, produto
  order by leads desc
  limit 60;
$$;

-- 12) Valores distintos para os filtros da visão Entradas LP
create or replace function dashboard_produtos_filtros()
returns table (
  campanhas text[],
  produtos text[],
  origens text[]
)
language sql
security definer
set search_path = public
stable
as $$
  select
    (select array_agg(distinct campanha) from total_produtos where campanha is not null),
    (select array_agg(distinct produto) from total_produtos where produto is not null),
    (select array_agg(distinct origem) from total_produtos where origem is not null);
$$;

-- =========================================================
-- FUNIL — DISPAROS (overlay dentro da visão Disparos)
-- Etapas: Disparado (tudo) -> Entregue (meta preenchido e != failed) ->
-- Interagido (interacao preenchido) -> Simulações com saldo (valor
-- preenchido OU conversa = 'ofertado') -> Pagas (pagas preenchido).
-- Padrão: dia de hoje (horário de Brasília), com filtro opcional de
-- data e campanha.
-- =========================================================
drop function if exists dashboard_funil(date, text);

create or replace function dashboard_funil(
  p_data date default null,
  p_campanha text default null,
  p_origem text default null
)
returns table (
  leads bigint,
  entregues bigint,
  interagidos bigint,
  simulacoes_saldo bigint,
  pagas bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with alvo as (
    select coalesce(p_data, (now() at time zone 'America/Sao_Paulo')::date) as dia
  ),
  base as (
    select d.*
    from disparochat d, alvo
    where (p_campanha is null or d.campanha = p_campanha)
      and (p_origem is null or d.origem = p_origem)
      and coalesce(d.reenvio, d.realizado) is not null
      and (coalesce(d.reenvio, d.realizado) at time zone 'America/Sao_Paulo')::date = alvo.dia
  )
  select
    count(*) as leads,
    count(*) filter (where meta is not null and meta <> 'failed') as entregues,
    count(*) filter (where interacao is not null) as interagidos,
    count(*) filter (where safe_numeric(valor) is not null or conversa = 'ofertado') as simulacoes_saldo,
    count(*) filter (where pagas is not null) as pagas
  from base;
$$;

-- =========================================================
-- FUNIL — ENTRADAS LP (overlay dentro da visão Entradas LP)
-- Etapas: Leads (tudo) -> Interagidos -> Aprovados -> Pagos.
-- Padrão: dia de hoje (horário de Brasília), com filtro opcional de
-- data e campanha.
-- =========================================================
drop function if exists dashboard_funil_produtos(date, text);

create or replace function dashboard_funil_produtos(
  p_data date default null,
  p_campanha text default null,
  p_origem text default null,
  p_produto text default null
)
returns table (
  leads bigint,
  interagidos bigint,
  aprovados bigint,
  pagos bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with alvo as (
    select coalesce(p_data, (now() at time zone 'America/Sao_Paulo')::date) as dia
  ),
  base as (
    select t.*
    from total_produtos t, alvo
    where (p_campanha is null or t.campanha = p_campanha)
      and (p_origem is null or t.origem = p_origem)
      and (p_produto is null or t.produto = p_produto)
      and t.created_at is not null
      and (t.created_at at time zone 'America/Sao_Paulo')::date = alvo.dia
  )
  select
    count(*) as leads,
    count(*) filter (where interacao = 1) as interagidos,
    count(*) filter (where aprovadas = 1) as aprovados,
    count(*) filter (where pagas = 1) as pagos
  from base;
$$;

-- 4) Valores distintos para popular os filtros (dropdowns)
create or replace function dashboard_filtros()
returns table (
  campanhas text[],
  origens text[],
  metas text[]
)
language sql
security definer
set search_path = public
stable
as $$
  select
    (select array_agg(distinct campanha) from disparochat where campanha is not null),
    (select array_agg(distinct origem) from disparochat where origem is not null),
    (select array_agg(distinct meta) from disparochat where meta is not null);
$$;

-- Libera a execução dessas funções para o público (chave anon)
grant execute on function dashboard_kpis to anon;
grant execute on function dashboard_envios_por_dia to anon;
grant execute on function dashboard_campanhas to anon;
grant execute on function dashboard_por_conversa to anon;
grant execute on function dashboard_por_meta to anon;
grant execute on function dashboard_por_mensagem to anon;
grant execute on function dashboard_hoje_kpis to anon;
grant execute on function dashboard_falha_por_minuto to anon;
grant execute on function dashboard_por_template_hoje to anon;
grant execute on function dashboard_produtos_kpis to anon;
grant execute on function dashboard_produtos_entradas_por_dia to anon;
grant execute on function dashboard_produtos_aprovadas_por_dia to anon;
grant execute on function dashboard_produtos_campanhas to anon;
grant execute on function dashboard_produtos_filtros to anon;
grant execute on function dashboard_funil to anon;
grant execute on function dashboard_funil_produtos to anon;
grant execute on function dashboard_filtros to anon;
