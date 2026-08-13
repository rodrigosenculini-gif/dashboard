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
  pagas bigint,
  faturado numeric,
  roi numeric,
  conversao_pct numeric,
  valor numeric
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
      case when count(*) > 0
        then round(100.0 * count(*) filter (where interacao is not null) / count(*), 2)
        else 0 end as interacao_pct,
      count(*) filter (where pagas is not null) as pagas_count,
      coalesce(sum(pagas), 0) as pagas_valor,
      coalesce(sum(safe_numeric(valor)), 0) as valor_total
    from base
  )
  select
    total_leads,
    gastado,
    interacao_pct,
    pagas_count as pagas,
    round(pagas_valor - gastado, 2) as faturado,
    case when gasto_bruto > 0
      then round((pagas_valor - gastado) / gasto_bruto, 2)
      else 0 end as roi,
    case when total_leads > 0
      then round(100.0 * pagas_count / total_leads, 2)
      else 0 end as conversao_pct,
    round(valor_total, 2) as valor
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
    select date(realizado) as dia, count(*) as envios
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
    select date(reenvio) as dia, count(*) as reenvios
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
grant execute on function dashboard_filtros to anon;
