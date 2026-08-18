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
  p_date_to timestamptz default null,
  p_hora_inicio int default null,
  p_hora_fim int default null
)
returns table (
  total_leads bigint,
  gastado numeric,
  interacao_pct numeric,
  interacao_qtd bigint,
  pagas bigint,
  valor_pago numeric,
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
      and (
        p_date_from is null and p_date_to is null
        or ((p_date_from is null or realizado >= p_date_from) and (p_date_to is null or realizado <= p_date_to))
        or (reenvio is not null and (p_date_from is null or reenvio >= p_date_from) and (p_date_to is null or reenvio <= p_date_to))
      )
      and (
        p_hora_inicio is null and p_hora_fim is null
        or extract(hour from coalesce(realizado, reenvio) at time zone 'America/Sao_Paulo') between coalesce(p_hora_inicio, 0) and coalesce(p_hora_fim, 23)
      )
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
    round(pagas_valor, 2) as valor_pago,
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
  p_date_to timestamptz default null,
  p_hora_inicio int default null,
  p_hora_fim int default null
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
      and (p_hora_inicio is null or extract(hour from realizado at time zone 'America/Sao_Paulo') >= p_hora_inicio)
      and (p_hora_fim is null or extract(hour from realizado at time zone 'America/Sao_Paulo') <= p_hora_fim)
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
      and (p_hora_inicio is null or extract(hour from reenvio at time zone 'America/Sao_Paulo') >= p_hora_inicio)
      and (p_hora_fim is null or extract(hour from reenvio at time zone 'America/Sao_Paulo') <= p_hora_fim)
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
    and (
      p_date_from is null and p_date_to is null
      or (
        (p_date_from is null or realizado >= p_date_from) and (p_date_to is null or realizado <= p_date_to)
      )
      or (
        reenvio is not null
        and (p_date_from is null or reenvio >= p_date_from)
        and (p_date_to is null or reenvio <= p_date_to)
      )
    )
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
    conversa as valor,
    count(*) as leads
  from disparochat
  where conversa is not null
    and (p_campanha is null or campanha = p_campanha)
    and (p_origem is null or origem = p_origem)
    and (p_meta is null or meta = p_meta)
    and (
      p_date_from is null and p_date_to is null
      or ((p_date_from is null or realizado >= p_date_from) and (p_date_to is null or realizado <= p_date_to))
      or (reenvio is not null and (p_date_from is null or reenvio >= p_date_from) and (p_date_to is null or reenvio <= p_date_to))
    )
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
    meta as valor,
    count(*) as leads
  from disparochat
  where meta is not null
    and (p_campanha is null or campanha = p_campanha)
    and (p_origem is null or origem = p_origem)
    and (
      p_date_from is null and p_date_to is null
      or ((p_date_from is null or realizado >= p_date_from) and (p_date_to is null or realizado <= p_date_to))
      or (reenvio is not null and (p_date_from is null or reenvio >= p_date_from) and (p_date_to is null or reenvio <= p_date_to))
    )
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
    mensagem as valor,
    count(*) as leads
  from disparochat
  where mensagem is not null
    and (p_campanha is null or campanha = p_campanha)
    and (p_origem is null or origem = p_origem)
    and (p_meta is null or meta = p_meta)
    and (
      p_date_from is null and p_date_to is null
      or ((p_date_from is null or realizado >= p_date_from) and (p_date_to is null or realizado <= p_date_to))
      or (reenvio is not null and (p_date_from is null or reenvio >= p_date_from) and (p_date_to is null or reenvio <= p_date_to))
    )
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
-- p_date_from/p_date_to (opcionais) definem o intervalo; padrão é hoje (Brasília).
drop function if exists dashboard_hoje_kpis(date, text);

drop function if exists dashboard_hoje_kpis(timestamptz, timestamptz, text);

create or replace function dashboard_hoje_kpis(
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_campanha text default null,
  p_hora_inicio int default null,
  p_hora_fim int default null
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
    select
      coalesce(p_date_from, (((now() at time zone 'America/Sao_Paulo')::date)::timestamp at time zone 'America/Sao_Paulo')) as de,
      coalesce(p_date_to, (((now() at time zone 'America/Sao_Paulo')::date)::timestamp at time zone 'America/Sao_Paulo') + interval '1 day' - interval '1 second') as ate
  ),
  hoje as (
    select d.*
    from disparochat d, alvo
    where d.meta in ('sent', 'delivered', 'read', 'failed')
      and (p_campanha is null or d.campanha = p_campanha)
      and (
        (d.realizado is not null and d.realizado between alvo.de and alvo.ate)
        or (d.reenvio is not null and d.reenvio between alvo.de and alvo.ate)
        or (d.status_atualizado is not null
          and d.status_atualizado between alvo.de and alvo.ate)
      )
      and (
        p_hora_inicio is null and p_hora_fim is null
        or extract(hour from coalesce(d.reenvio, d.realizado, d.status_atualizado) at time zone 'America/Sao_Paulo')
           between coalesce(p_hora_inicio, 0) and coalesce(p_hora_fim, 23)
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
drop function if exists dashboard_por_template_hoje(date, text);

create or replace function dashboard_por_template_hoje(
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
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
    select
      coalesce(p_date_from, (((now() at time zone 'America/Sao_Paulo')::date)::timestamp at time zone 'America/Sao_Paulo')) as de,
      coalesce(p_date_to, (((now() at time zone 'America/Sao_Paulo')::date)::timestamp at time zone 'America/Sao_Paulo') + interval '1 day' - interval '1 second') as ate
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
      (d.realizado is not null and d.realizado between alvo.de and alvo.ate)
      or (d.reenvio is not null and d.reenvio between alvo.de and alvo.ate)
      or (d.status_atualizado is not null
        and d.status_atualizado between alvo.de and alvo.ate)
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
drop function if exists dashboard_produtos_kpis(text, text, text, timestamptz, timestamptz);

create or replace function dashboard_produtos_kpis(
  p_campanha text default null,
  p_produto text default null,
  p_origem text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_hora_inicio int default null,
  p_hora_fim int default null
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
      and (p_hora_inicio is null or extract(hour from created_at at time zone 'America/Sao_Paulo') >= p_hora_inicio)
      and (p_hora_fim is null or extract(hour from created_at at time zone 'America/Sao_Paulo') <= p_hora_fim)
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
drop function if exists dashboard_produtos_entradas_por_dia(text, text, text, timestamptz, timestamptz);

create or replace function dashboard_produtos_entradas_por_dia(
  p_campanha text default null,
  p_produto text default null,
  p_origem text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_hora_inicio int default null,
  p_hora_fim int default null
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
    and (p_hora_inicio is null or extract(hour from created_at at time zone 'America/Sao_Paulo') >= p_hora_inicio)
    and (p_hora_fim is null or extract(hour from created_at at time zone 'America/Sao_Paulo') <= p_hora_fim)
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
-- intervalo de datas e campanha/origem.
-- =========================================================
drop function if exists dashboard_funil(date, text, text);

create or replace function dashboard_funil(
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
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
    select
      coalesce(p_date_from, (((now() at time zone 'America/Sao_Paulo')::date)::timestamp at time zone 'America/Sao_Paulo')) as de,
      coalesce(p_date_to, (((now() at time zone 'America/Sao_Paulo')::date)::timestamp at time zone 'America/Sao_Paulo') + interval '1 day' - interval '1 second') as ate
  ),
  base as (
    select d.*
    from disparochat d, alvo
    where (p_campanha is null or d.campanha = p_campanha)
      and (p_origem is null or d.origem = p_origem)
      and coalesce(d.reenvio, d.realizado) is not null
      and coalesce(d.reenvio, d.realizado) between alvo.de and alvo.ate
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
-- intervalo de datas, campanha, origem e produto.
-- =========================================================
drop function if exists dashboard_funil_produtos(date, text, text, text);

create or replace function dashboard_funil_produtos(
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
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
    select
      coalesce(p_date_from, (((now() at time zone 'America/Sao_Paulo')::date)::timestamp at time zone 'America/Sao_Paulo')) as de,
      coalesce(p_date_to, (((now() at time zone 'America/Sao_Paulo')::date)::timestamp at time zone 'America/Sao_Paulo') + interval '1 day' - interval '1 second') as ate
  ),
  base as (
    select t.*
    from total_produtos t, alvo
    where (p_campanha is null or t.campanha = p_campanha)
      and (p_origem is null or t.origem = p_origem)
      and (p_produto is null or t.produto = p_produto)
      and t.created_at is not null
      and t.created_at between alvo.de and alvo.ate
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

-- =========================================================
-- VENDEDORAS (tabela vendedoras_analise + cruzamento com
-- disparochat / total_produtos / leads_chatwoot)
-- =========================================================

-- Normaliza CPF pra sempre 11 dígitos (remove pontuação, completa com
-- zero à esquerda se vier mais curto)
create or replace function norm_cpf(txt text)
returns text
language sql
immutable
as $$
  select lpad(regexp_replace(coalesce(txt, ''), '[^0-9]', '', 'g'), 11, '0');
$$;

-- Converte texto "DD/MM/AAAA" em date, com segurança (retorna null se o
-- formato não bater, em vez de dar erro)
create or replace function safe_date_br(txt text)
returns date
language sql
immutable
as $$
  select case
    when txt ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' then to_date(txt, 'DD/MM/YYYY')
    else null
  end;
$$;

-- Coluna extra pra saber a qual sistema de conversas o covnersation_id
-- pertence ("vendeai" ou "chatwoot"), já que os dois têm links diferentes
alter table vendedoras_analise add column if not exists conversa_sistema text;

-- Sincronização manual (botão "Sincronizar" na tela) — NÃO roda sozinha:
-- 1) Preenche whatsapp/covnersation_id/conversa_sistema na vendedoras_analise,
--    buscando por CPF (normalizado) recente (últimos 7 dias):
--      - disparochat -> sistema "vendeai" (crm.vendeaitecnologia.com.br)
--      - leads_chatwoot, só quando conta = 'chatwoot' -> sistema "chatwoot"
--        (chatwoot.querosacarfgts.com.br). Se conta for outra coisa, o
--        conversation_id dessa tabela não é usado (não sabemos o link certo).
--      - total_produtos: só whatsapp (essa tabela não tem conversation_id).
-- 2) Marca como paga (usando o valor da vendedoras_analise) qualquer
--    registro correspondente nessas 3 tabelas que ainda não estivesse pago.
create or replace function dashboard_vendedoras_sync()
returns table (
  atualizados_vendedoras int,
  atualizados_disparochat int,
  atualizados_total_produtos int,
  atualizados_leads_chatwoot int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v1 int := 0;
  v2 int := 0;
  v3 int := 0;
  v4 int := 0;
begin
  -- 1) enriquece com disparochat (sistema "vendeai")
  with match_d as (
    select distinct on (norm_cpf(d.cpf))
      norm_cpf(d.cpf) as cpf_norm, d.whatsapp, d.conversation_id
    from disparochat d
    where coalesce(d.reenvio, d.realizado, d.status_atualizado) >= now() - interval '7 days'
      and d.cpf is not null
    order by norm_cpf(d.cpf), coalesce(d.reenvio, d.realizado, d.status_atualizado) desc
  )
  update vendedoras_analise v
  set covnersation_id = coalesce(v.covnersation_id, m.conversation_id),
      conversa_sistema = coalesce(v.conversa_sistema, case when m.conversation_id is not null then 'vendeai' end),
      whatsapp = coalesce(v.whatsapp, m.whatsapp)
  from match_d m
  where norm_cpf(v.cpf) = m.cpf_norm
    and (v.covnersation_id is null or v.whatsapp is null);
  get diagnostics v1 = row_count;

  -- 1b) completa o que faltou com leads_chatwoot (sempre busca, independente
  -- de "conta" — a diferença é só o link: conta='chatwoot' usa o domínio
  -- chatwoot.querosacarfgts.com.br, qualquer outro valor usa o vendeai)
  with match_l as (
    select distinct on (norm_cpf(l.cpf))
      norm_cpf(l.cpf) as cpf_norm, l.whatsapp, l.conversation_id,
      case when l.conta = 'chatwoot' then 'chatwoot' else 'vendeai' end as sistema
    from leads_chatwoot l
    where coalesce(l.atualizacao, l.entrada_tabela) >= now() - interval '7 days'
      and l.cpf is not null
    order by norm_cpf(l.cpf), coalesce(l.atualizacao, l.entrada_tabela) desc
  )
  update vendedoras_analise v
  set covnersation_id = coalesce(v.covnersation_id, m.conversation_id),
      conversa_sistema = coalesce(v.conversa_sistema, case when m.conversation_id is not null then m.sistema end),
      whatsapp = coalesce(v.whatsapp, m.whatsapp)
  from match_l m
  where norm_cpf(v.cpf) = m.cpf_norm
    and (v.covnersation_id is null or v.whatsapp is null);

  -- 1c) completa com total_produtos (agora também tem conversation_id,
  -- sistema "vendeai" — não tem coluna "conta" pra diferenciar como o
  -- leads_chatwoot tem)
  with match_t as (
    select distinct on (norm_cpf(t.cpf))
      norm_cpf(t.cpf) as cpf_norm, t.whatsapp, t.conversation_id
    from total_produtos t
    where t.created_at >= now() - interval '7 days'
      and t.cpf is not null
    order by norm_cpf(t.cpf), t.created_at desc
  )
  update vendedoras_analise v
  set covnersation_id = coalesce(v.covnersation_id, m.conversation_id),
      conversa_sistema = coalesce(v.conversa_sistema, case when m.conversation_id is not null then 'vendeai' end),
      whatsapp = coalesce(v.whatsapp, m.whatsapp)
  from match_t m
  where norm_cpf(v.cpf) = m.cpf_norm
    and (v.covnersation_id is null or v.whatsapp is null);

  -- 1d) backfill de conversa_sistema pra quem já tinha covnersation_id
  -- preenchido (ex: veio assim no arquivo original) mas nunca soube de qual
  -- sistema é — tenta casar direto pelo id, sem depender de cpf/recência
  update vendedoras_analise v
  set conversa_sistema = 'vendeai'
  where v.covnersation_id is not null
    and v.conversa_sistema is null
    and exists (select 1 from disparochat d where d.conversation_id = v.covnersation_id);

  update vendedoras_analise v
  set conversa_sistema = 'vendeai'
  where v.covnersation_id is not null
    and v.conversa_sistema is null
    and exists (select 1 from total_produtos t where t.conversation_id = v.covnersation_id);

  update vendedoras_analise v
  set conversa_sistema = coalesce(l.sistema, 'vendeai')
  from (
    select conversation_id, case when conta = 'chatwoot' then 'chatwoot' else 'vendeai' end as sistema
    from leads_chatwoot
    where conversation_id is not null
  ) l
  where v.covnersation_id is not null
    and v.conversa_sistema is null
    and v.covnersation_id = l.conversation_id;

  select count(*) into v1 from vendedoras_analise where covnersation_id is not null or whatsapp is not null;

  -- 2) reconcilia pagamento nas tabelas de origem
  with vs as (
    select norm_cpf(cpf) as cpf_norm, valor
    from vendedoras_analise
    where valor is not null and cpf is not null
  )
  update disparochat d
  set pagas = vs.valor
  from vs
  where norm_cpf(d.cpf) = vs.cpf_norm
    and coalesce(d.reenvio, d.realizado, d.status_atualizado) >= now() - interval '7 days'
    and d.pagas is null;
  get diagnostics v2 = row_count;

  with vs as (
    select norm_cpf(cpf) as cpf_norm, valor
    from vendedoras_analise
    where valor is not null and cpf is not null
  )
  update total_produtos t
  set valor = vs.valor, pagas = 1
  from vs
  where norm_cpf(t.cpf) = vs.cpf_norm
    and t.created_at >= now() - interval '7 days'
    and (t.pagas is null or t.pagas <> 1);
  get diagnostics v3 = row_count;

  with vs as (
    select norm_cpf(cpf) as cpf_norm, valor
    from vendedoras_analise
    where valor is not null and cpf is not null
  )
  update leads_chatwoot l
  set valor = vs.valor, pagas = 1
  from vs
  where norm_cpf(l.cpf) = vs.cpf_norm
    and coalesce(l.atualizacao, l.entrada_tabela) >= now() - interval '7 days'
    and (l.pagas is null or l.pagas <> 1);
  get diagnostics v4 = row_count;

  return query select v1, v2, v3, v4;
end;
$$;

-- KPIs gerais (sem filtro de vendedor)
drop function if exists dashboard_vendedoras_kpis_geral(timestamptz, timestamptz);

create or replace function dashboard_vendedoras_kpis_geral(
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  top_qtd_vendedor text,
  top_qtd_valor bigint,
  top_valor_vendedor text,
  top_valor_valor numeric,
  banco_top text,
  banco_top_qtd bigint,
  dia_maior_valor date,
  dia_maior_valor_total numeric
)
language sql
security definer
set search_path = public
stable
as $$
  with base as (
    select vendedor, banco, valor, data_status as dia
    from vendedoras_analise
    where (p_date_from is null or data_status >= p_date_from)
      and (p_date_to is null or data_status <= p_date_to)
  ),
  por_vendedor as (
    select vendedor, count(*) as qtd, coalesce(sum(valor), 0) as total
    from base
    where vendedor is not null
    group by vendedor
  ),
  por_banco as (
    select banco, count(*) as qtd
    from base
    where banco is not null
    group by banco
  ),
  por_dia as (
    select dia, coalesce(sum(valor), 0) as total
    from base
    where dia is not null
    group by dia
  )
  select
    (select vendedor from por_vendedor order by qtd desc limit 1),
    (select qtd from por_vendedor order by qtd desc limit 1),
    (select vendedor from por_vendedor order by total desc limit 1),
    (select total from por_vendedor order by total desc limit 1),
    (select banco from por_banco order by qtd desc limit 1),
    (select qtd from por_banco order by qtd desc limit 1),
    (select dia from por_dia order by total desc limit 1),
    (select total from por_dia order by total desc limit 1);
$$;

-- KPIs de um vendedor específico
drop function if exists dashboard_vendedoras_kpis_vendedor(text, timestamptz, timestamptz);

drop function if exists dashboard_vendedoras_kpis_vendedor(text, date, date);

create or replace function dashboard_vendedoras_kpis_vendedor(
  p_vendedor text,
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  maior_venda numeric,
  dia_mais_vendas date,
  dia_mais_vendas_qtd bigint,
  valor_total numeric,
  qtd_total bigint,
  banco_top text,
  banco_top_qtd bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with base as (
    select valor, banco, data_status as dia
    from vendedoras_analise
    where vendedor = p_vendedor
      and (p_date_from is null or data_status >= p_date_from)
      and (p_date_to is null or data_status <= p_date_to)
  ),
  por_dia as (
    select dia, count(*) as qtd from base where dia is not null group by dia
  ),
  por_banco as (
    select banco, count(*) as qtd from base where banco is not null group by banco
  )
  select
    (select coalesce(max(valor), 0) from base),
    (select dia from por_dia order by qtd desc limit 1),
    (select qtd from por_dia order by qtd desc limit 1),
    (select coalesce(sum(valor), 0) from base),
    (select count(*) from base),
    (select banco from por_banco order by qtd desc limit 1),
    (select qtd from por_banco order by qtd desc limit 1);
$$;

-- Vendas por dia e por vendedora (gráfico) — formato longo
drop function if exists dashboard_vendedoras_por_dia(text, timestamptz, timestamptz);

create or replace function dashboard_vendedoras_por_dia(
  p_vendedor text default null,
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  dia date,
  vendedor text,
  vendas bigint,
  valor_total numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select data_status as dia, vendedor, count(*) as vendas, coalesce(sum(valor), 0) as valor_total
  from vendedoras_analise
  where data_status is not null
    and (p_vendedor is null or vendedor = p_vendedor)
    and (p_date_from is null or data_status >= p_date_from)
    and (p_date_to is null or data_status <= p_date_to)
  group by 1, 2
  order by 1;
$$;

-- Tabela de vendas paginada
drop function if exists dashboard_vendedoras_tabela(text, timestamptz, timestamptz, int, int);

create or replace function dashboard_vendedoras_tabela(
  p_vendedor text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_limit int default 10,
  p_offset int default 0
)
returns table (
  vendedor text,
  valor numeric,
  cpf text,
  banco text,
  dia date,
  covnersation_id bigint,
  conversa_sistema text,
  total_count bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    vendedor, valor, cpf, banco, data_status as dia, covnersation_id, conversa_sistema,
    count(*) over() as total_count
  from vendedoras_analise
  where (p_vendedor is null or vendedor = p_vendedor)
    and (p_date_from is null or data_status >= p_date_from)
    and (p_date_to is null or data_status <= p_date_to)
  order by data_status desc nulls last, id desc
  limit p_limit offset p_offset;
$$;

-- Ranking de vendedoras (valor total, qtd total, banco mais vendido),
-- em ordem decrescente de valor total
drop function if exists dashboard_vendedoras_ranking(timestamptz, timestamptz);

create or replace function dashboard_vendedoras_ranking(
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  vendedor text,
  valor_total numeric,
  qtd_total bigint,
  banco_top text
)
language sql
security definer
set search_path = public
stable
as $$
  with base as (
    select vendedor, banco, valor
    from vendedoras_analise
    where vendedor is not null
      and (p_date_from is null or data_status >= p_date_from)
      and (p_date_to is null or data_status <= p_date_to)
  ),
  agg as (
    select vendedor, coalesce(sum(valor), 0) as valor_total, count(*) as qtd_total
    from base
    group by vendedor
  ),
  banco_rank as (
    select vendedor, banco, count(*) as qtd,
      row_number() over (partition by vendedor order by count(*) desc) as rn
    from base
    where banco is not null
    group by vendedor, banco
  )
  select a.vendedor, a.valor_total, a.qtd_total, br.banco
  from agg a
  left join banco_rank br on br.vendedor = a.vendedor and br.rn = 1
  order by a.valor_total desc;
$$;

-- Importação de vendas via CSV (botão "Importar" na tela). Recebe um array
-- jsonb já normalizado pelo front-end (cpf com 11 dígitos, data em
-- AAAA-MM-DD, valor com ponto decimal). Duplicata = mesmo cpf + adesao já
-- existente na tabela; nesse caso a linha é ignorada. CPF igual com adesao
-- diferente entra como uma nova venda (linha nova).
create or replace function dashboard_vendedoras_import(p_rows jsonb)
returns table (inseridos int, ignorados int, total int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inseridos int := 0;
  v_total int := 0;
begin
  select count(*) into v_total from jsonb_array_elements(p_rows);

  with novos as (
    select
      nullif(r->>'data_status', '')::date as data_status,
      nullif(r->>'banco', '') as banco,
      nullif(r->>'adesao', '')::bigint as adesao,
      norm_cpf(r->>'cpf') as cpf,
      nullif(r->>'nome', '') as nome,
      nullif(r->>'vendedor', '') as vendedor,
      nullif(r->>'tabela', '') as tabela,
      nullif(r->>'valor', '')::numeric as valor
    from jsonb_array_elements(p_rows) r
  ),
  dedup_input as (
    -- remove duplicatas dentro do próprio arquivo (mesmo cpf+adesao repetido no CSV)
    select distinct on (cpf, coalesce(adesao, -1)) *
    from novos
  ),
  a_inserir as (
    select n.* from dedup_input n
    where not exists (
      select 1 from vendedoras_analise v
      where norm_cpf(v.cpf) = n.cpf
        and coalesce(v.adesao, -1) = coalesce(n.adesao, -1)
    )
  )
  insert into vendedoras_analise (data_status, banco, adesao, cpf, nome, vendedor, tabela, valor)
  select data_status, banco, adesao, cpf, nome, vendedor, tabela, valor from a_inserir;

  get diagnostics v_inseridos = row_count;

  return query select v_inseridos, (v_total - v_inseridos), v_total;
end;
$$;

-- Lista de vendedoras pro filtro
create or replace function dashboard_vendedoras_filtros()
returns table (vendedores text[])
language sql
security definer
set search_path = public
stable
as $$
  select array_agg(distinct vendedor) from vendedoras_analise where vendedor is not null;
$$;

grant execute on function norm_cpf to anon;
grant execute on function safe_date_br to anon;
grant execute on function dashboard_vendedoras_sync to anon;
grant execute on function dashboard_vendedoras_import to anon;
grant execute on function dashboard_vendedoras_kpis_geral to anon;
grant execute on function dashboard_vendedoras_kpis_vendedor to anon;
grant execute on function dashboard_vendedoras_por_dia to anon;
grant execute on function dashboard_vendedoras_ranking to anon;
grant execute on function dashboard_vendedoras_tabela to anon;
grant execute on function dashboard_vendedoras_filtros to anon;

-- =========================================================
-- META / PROJEÇÃO / ADIÇÃO DE VENDA (portal da vendedora)
-- =========================================================

-- Resumo do mês corrente: total feito, dias úteis passados/do mês,
-- projeção (regra de três simples: total ÷ dias úteis passados × dias úteis
-- do mês inteiro) e o valor da semana atual (meta de R$100.000/semana).
-- "Dia útil" aqui = segunda a sexta (não desconta feriados).
create or replace function dashboard_vendedoras_meta(p_vendedor text)
returns table (
  total_mes_atual numeric,
  dias_uteis_passados int,
  dias_uteis_mes int,
  projecao_mes numeric,
  semana_atual_valor numeric,
  meta_semana numeric
)
language sql
security definer
set search_path = public
stable
as $$
  with hoje as (
    select (now() at time zone 'America/Sao_Paulo')::date as d
  ),
  mes as (
    select
      date_trunc('month', d)::date as inicio,
      (date_trunc('month', d) + interval '1 month - 1 day')::date as fim
    from hoje
  ),
  du_passados as (
    select count(*) as n
    from generate_series((select inicio from mes), (select d from hoje), interval '1 day') g(dia)
    where extract(isodow from g.dia) < 6
  ),
  du_mes as (
    select count(*) as n
    from generate_series((select inicio from mes), (select fim from mes), interval '1 day') g(dia)
    where extract(isodow from g.dia) < 6
  ),
  total_mes as (
    select coalesce(sum(valor), 0) as v
    from vendedoras_analise, mes, hoje
    where vendedor = p_vendedor
      and data_status >= mes.inicio
      and data_status <= hoje.d
  ),
  semana_atual as (
    select coalesce(sum(valor), 0) as v
    from vendedoras_analise, hoje
    where vendedor = p_vendedor
      and data_status >= (hoje.d - (extract(isodow from hoje.d)::int - 1))
      and data_status <= hoje.d
  )
  select
    (select v from total_mes),
    (select n from du_passados),
    (select n from du_mes),
    case when (select n from du_passados) > 0
      then round((select v from total_mes) / (select n from du_passados) * (select n from du_mes), 2)
      else 0 end,
    (select v from semana_atual),
    100000;
$$;

-- Vendas por semana do mês corrente (cada semana = segunda a domingo).
-- "passada" indica se a semana já terminou (usado pro front-end saber o que
-- é real e o que é projeção/transparente no gráfico).
create or replace function dashboard_vendedoras_semanas_mes(p_vendedor text)
returns table (
  semana int,
  semana_label text,
  inicio date,
  fim date,
  valor_semana numeric,
  passada boolean
)
language sql
security definer
set search_path = public
stable
as $$
  with hoje as (select (now() at time zone 'America/Sao_Paulo')::date as d),
  mes as (
    select
      date_trunc('month', d)::date as inicio,
      (date_trunc('month', d) + interval '1 month - 1 day')::date as fim
    from hoje
  ),
  semanas as (
    select
      row_number() over (order by semana_inicio_bruto) as semana,
      greatest(semana_inicio_bruto, (select inicio from mes)) as semana_inicio,
      least(semana_inicio_bruto + 6, (select fim from mes)) as semana_fim
    from (
      select distinct (date_trunc('week', dia))::date as semana_inicio_bruto
      from generate_series((select inicio from mes), (select fim from mes), interval '1 day') dia
    ) s
  )
  select
    s.semana::int,
    to_char(s.semana_inicio, 'DD/MM') || '-' || to_char(s.semana_fim, 'DD/MM'),
    s.semana_inicio,
    s.semana_fim,
    coalesce((
      select sum(v.valor) from vendedoras_analise v
      where v.vendedor = p_vendedor and v.data_status between s.semana_inicio and s.semana_fim
    ), 0),
    (s.semana_fim <= (select d from hoje))
  from semanas s
  order by s.semana;
$$;

-- Adicionar uma venda avulsa (portal da vendedora). data_status e vendedor
-- são sempre definidos automaticamente pelo servidor — nunca pelo cliente.
create or replace function dashboard_vendedoras_add_venda(
  p_vendedor text,
  p_adesao bigint,
  p_cpf text,
  p_nome text,
  p_valor numeric,
  p_banco text
)
returns table (ok boolean, mensagem text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cpf text;
begin
  if p_vendedor is null or p_adesao is null or p_cpf is null or p_nome is null
     or p_valor is null or p_banco is null or trim(p_cpf) = '' or trim(p_nome) = '' or trim(p_banco) = '' then
    return query select false, 'Preencha adesão, cpf, nome, valor e banco.';
    return;
  end if;

  v_cpf := norm_cpf(p_cpf);

  if exists (
    select 1 from vendedoras_analise
    where norm_cpf(cpf) = v_cpf and coalesce(adesao, -1) = p_adesao
  ) then
    return query select false, 'Já existe uma venda com esse CPF e adesão.';
    return;
  end if;

  insert into vendedoras_analise (data_status, banco, adesao, cpf, nome, vendedor, valor)
  values ((now() at time zone 'America/Sao_Paulo')::date, p_banco, p_adesao, v_cpf, p_nome, p_vendedor, p_valor);

  -- espelha também na visão geral de Vendas (se ainda não existir lá)
  if not exists (
    select 1 from vendas_gerais
    where norm_cpf(cpf) = v_cpf and coalesce(adesao, -1) = p_adesao
  ) then
    insert into vendas_gerais (data, banco, adesao, cpf, nome, valor)
    values ((now() at time zone 'America/Sao_Paulo')::date, p_banco, p_adesao, v_cpf, p_nome, p_valor);
  end if;

  return query select true, 'Venda adicionada com sucesso.';
end;
$$;

grant execute on function dashboard_vendedoras_meta to anon;
grant execute on function dashboard_vendedoras_semanas_mes to anon;
grant execute on function dashboard_vendedoras_add_venda to anon;

-- =========================================================
-- VENDAS (visão geral de vendas — tabela vendas_gerais)
-- =========================================================

create table if not exists vendas_gerais (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  adesao bigint,
  cpf text,
  tabela text,
  nome text,
  valor numeric,
  peso numeric,
  ponto numeric,
  data date,
  produto text,
  banco text,
  parcelas int,
  seguro text,
  whatsapp bigint,
  covnersation_id bigint,
  conversa_sistema text,
  campanha text,
  origem text
);

-- Classifica o produto automaticamente a partir de banco/tabela:
--   tabela contém "refin"  -> REFIN
--   banco é crefaz         -> ENERGIA
--   banco é novo saque     -> FGTS
--   qualquer outro caso    -> CLT
create or replace function calc_produto_vendas(p_banco text, p_tabela text)
returns text
language sql
immutable
as $$
  select case
    when upper(coalesce(p_tabela, '')) like '%REFIN%' then 'REFIN'
    when upper(coalesce(p_banco, '')) like '%CREFAZ%' then 'ENERGIA'
    when upper(coalesce(p_banco, '')) like '%NOVO SAQUE%' or upper(coalesce(p_banco, '')) like '%NOVOSAQUE%' then 'FGTS'
    else 'CLT'
  end;
$$;

-- Calcula o peso automaticamente a partir de banco + tabela (código) +
-- parcelas + seguro, seguindo as tabelas de comissão de cada banco.
create or replace function calc_peso_vendas(
  p_banco text,
  p_tabela text,
  p_parcelas int,
  p_seguro text
)
returns numeric
language plpgsql
immutable
as $$
declare
  banco_norm text := upper(coalesce(p_banco, ''));
  tabela_norm text := upper(coalesce(p_tabela, ''));
  codigo text;
  tem_seguro boolean := upper(coalesce(p_seguro, '')) in ('SIM', 'S', 'TRUE', '1', 'COM SEGURO', 'COM');
begin
  -- extrai um código numérico de 4 a 6 dígitos do texto da tabela (se houver)
  codigo := substring(tabela_norm from '[0-9]{4,6}');

  -- FACTA
  if banco_norm like '%FACTA%' then
    return case codigo
      when '69205' then 1.45
      when '69191' then 1.35
      when '69183' then 1.35
      when '69035' then 1.35
      when '69027' then 1.35
      when '69043' then 1.35
      when '69051' then 1.35
      when '69167' then 1.25
      when '69175' then 1.25
      when '69159' then 1.20
      when '69140' then 1.15
      when '69060' then 1.15
      when '69132' then 1.10
      when '692213' then 1.10
      when '69221' then 1.10
      when '69230' then 1.10 -- ambíguo na planilha original (aparece também como 0,70)
      when '69078' then 0.90
      when '69086' then 0.90
      when '69213' then 0.90
      when '69116' then 0.90
      when '69019' then 0.80
      when '69094' then 0.80
      when '69272' then 0.90
      when '69264' then 0.80
      when '69256' then 0.70
      when '69280' then 0.60
      when '61107' then 0.35
      when '61093' then 0.35
      when '61085' then 0.35
      when '69299' then 0.35
      when '69302' then 0.35
      when '64815' then 0.00
      when '64823' then 0.00
      when '64831' then 0.00
      else null
    end;
  end if;

  -- CREFAZ
  if banco_norm like '%CREFAZ%' then
    if p_parcelas is null then return null; end if;
    if p_parcelas between 9 and 24 then return 1.65; end if;
    if p_parcelas between 1 and 8 then return 1.30; end if;
    return null;
  end if;

  -- PAN
  if banco_norm like '%PAN%' then
    return 0.80;
  end if;

  -- MERCANTIL
  if banco_norm like '%MERCANTIL%' then
    return 1.10;
  end if;

  -- PRESENÇA
  if banco_norm like '%PRESEN%' then
    return case p_parcelas
      when 48 then 1.75
      when 36 then 1.25
      when 26 then 0.75
      when 24 then 0.60
      when 18 then 0.20
      else null
    end;
  end if;

  -- SOMA (por código de tabela quando disponível)
  if banco_norm like '%SOMA%' then
    if codigo is not null then
      return case codigo
        when '2267' then 1.50
        when '2266' then 1.35
        when '2265' then 1.15
        when '2283' then 1.15
        when '2264' then 0.80
        when '2282' then 0.80
        when '2263' then 0.65
        when '2281' then 0.60
        when '2280' then 0.45
        when '2275' then 0.45
        when '2274' then 0.45
        when '2273' then 0.30
        when '2272' then 0.30
        when '2279' then 0.25
        when '2271' then 0.15
        else null
      end;
    end if;
    -- sem código: usa parcelas + seguro (aproximação — usa a tabela Celcoin
    -- quando existe ambiguidade entre bancarizadoras)
    if tem_seguro then
      return case p_parcelas
        when 48 then 1.50
        when 42 then 1.35
        when 36 then 1.15
        when 30 then 0.80
        when 24 then 0.65
        when 18 then 0.45
        when 12 then 0.25
        else null
      end;
    else
      return case p_parcelas
        when 48 then 0.45
        when 42 then 0.45
        when 36 then 0.30
        when 30 then 0.30
        when 24 then 0.15
        else null
      end;
    end if;
  end if;

  -- NOVO SAQUE (por nome da tabela)
  if banco_norm like '%NOVO SAQUE%' or banco_norm like '%NOVOSAQUE%' then
    if tabela_norm like '%CAMPANHA%' then return 9.50; end if;
    if tabela_norm like '%DIAMANTE%' then return 7.50; end if;
    if tabela_norm like '%GOLD%' then return 6.00; end if;
    if tabela_norm like '%MONEY%' then return 4.50; end if;
    if tabela_norm like '%LIGHT%' then return 3.50; end if;
    if tabela_norm like '%SOFT%' then return 2.00; end if;
    if tabela_norm like '%SMART%' then return 1.10; end if;
    if tabela_norm like '%ZERO%' then return 0.70; end if;
    if tabela_norm like '%NS%' or tabela_norm like '%NOVO SAQUE%' then return 12.00; end if;
    return null;
  end if;

  return null;
end;
$$;

-- Gatilho: toda vez que uma linha for inserida/atualizada em vendas_gerais,
-- recalcula produto/peso/ponto automaticamente — nunca fica por conta de
-- quem inseriu os dados (CSV, formulário da vendedora, etc.)
create or replace function trg_vendas_gerais_calcula()
returns trigger
language plpgsql
as $$
begin
  new.produto := calc_produto_vendas(new.banco, new.tabela);
  new.peso := calc_peso_vendas(new.banco, new.tabela, new.parcelas, new.seguro);
  new.ponto := coalesce(new.peso, 0) * coalesce(new.valor, 0);
  return new;
end;
$$;

drop trigger if exists vendas_gerais_calcula on vendas_gerais;
create trigger vendas_gerais_calcula
before insert or update on vendas_gerais
for each row execute function trg_vendas_gerais_calcula();

grant execute on function calc_produto_vendas to anon;
grant execute on function calc_peso_vendas to anon;

-- Sincronização manual da visão Vendas (botão "Sincronizar") — igual à de
-- vendedoras_analise, mas também traz campanha/origem (usados nas tabelas
-- "Por Campanha"/"Por Origem") e não mexe em vendedor algum.
create or replace function dashboard_vendas_sync()
returns table (
  atualizados_vendas int,
  atualizados_disparochat int,
  atualizados_total_produtos int,
  atualizados_leads_chatwoot int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v1 int := 0;
  v2 int := 0;
  v3 int := 0;
  v4 int := 0;
begin
  -- 1) enriquece com disparochat (sistema "vendeai" + campanha/origem)
  with match_d as (
    select distinct on (norm_cpf(d.cpf))
      norm_cpf(d.cpf) as cpf_norm, d.whatsapp, d.conversation_id, d.campanha, d.origem
    from disparochat d
    where coalesce(d.reenvio, d.realizado, d.status_atualizado) >= now() - interval '7 days'
      and d.cpf is not null
    order by norm_cpf(d.cpf), coalesce(d.reenvio, d.realizado, d.status_atualizado) desc
  )
  update vendas_gerais v
  set covnersation_id = coalesce(v.covnersation_id, m.conversation_id),
      conversa_sistema = coalesce(v.conversa_sistema, case when m.conversation_id is not null then 'vendeai' end),
      whatsapp = coalesce(v.whatsapp, m.whatsapp),
      campanha = coalesce(v.campanha, m.campanha),
      origem = coalesce(v.origem, m.origem)
  from match_d m
  where norm_cpf(v.cpf) = m.cpf_norm
    and (v.covnersation_id is null or v.whatsapp is null or v.campanha is null or v.origem is null);
  get diagnostics v1 = row_count;

  -- 1b) completa com leads_chatwoot (não tem campanha/origem, só conversa)
  with match_l as (
    select distinct on (norm_cpf(l.cpf))
      norm_cpf(l.cpf) as cpf_norm, l.whatsapp, l.conversation_id,
      case when l.conta = 'chatwoot' then 'chatwoot' else 'vendeai' end as sistema
    from leads_chatwoot l
    where coalesce(l.atualizacao, l.entrada_tabela) >= now() - interval '7 days'
      and l.cpf is not null
    order by norm_cpf(l.cpf), coalesce(l.atualizacao, l.entrada_tabela) desc
  )
  update vendas_gerais v
  set covnersation_id = coalesce(v.covnersation_id, m.conversation_id),
      conversa_sistema = coalesce(v.conversa_sistema, case when m.conversation_id is not null then m.sistema end),
      whatsapp = coalesce(v.whatsapp, m.whatsapp)
  from match_l m
  where norm_cpf(v.cpf) = m.cpf_norm
    and (v.covnersation_id is null or v.whatsapp is null);

  -- 1c) completa com total_produtos (whatsapp/conversation_id + campanha/origem)
  with match_t as (
    select distinct on (norm_cpf(t.cpf))
      norm_cpf(t.cpf) as cpf_norm, t.whatsapp, t.conversation_id, t.campanha, t.origem
    from total_produtos t
    where t.created_at >= now() - interval '7 days'
      and t.cpf is not null
    order by norm_cpf(t.cpf), t.created_at desc
  )
  update vendas_gerais v
  set covnersation_id = coalesce(v.covnersation_id, m.conversation_id),
      conversa_sistema = coalesce(v.conversa_sistema, case when m.conversation_id is not null then 'vendeai' end),
      whatsapp = coalesce(v.whatsapp, m.whatsapp),
      campanha = coalesce(v.campanha, m.campanha),
      origem = coalesce(v.origem, m.origem)
  from match_t m
  where norm_cpf(v.cpf) = m.cpf_norm
    and (v.covnersation_id is null or v.whatsapp is null or v.campanha is null or v.origem is null);

  select count(*) into v1 from vendas_gerais where covnersation_id is not null or whatsapp is not null;

  -- 2) reconcilia pagamento nas tabelas de origem (mesma regra de vendedoras)
  with vs as (
    select norm_cpf(cpf) as cpf_norm, valor
    from vendas_gerais
    where valor is not null and cpf is not null
  )
  update disparochat d
  set pagas = vs.valor
  from vs
  where norm_cpf(d.cpf) = vs.cpf_norm
    and coalesce(d.reenvio, d.realizado, d.status_atualizado) >= now() - interval '7 days'
    and d.pagas is null;
  get diagnostics v2 = row_count;

  with vs as (
    select norm_cpf(cpf) as cpf_norm, valor
    from vendas_gerais
    where valor is not null and cpf is not null
  )
  update total_produtos t
  set valor = vs.valor, pagas = 1
  from vs
  where norm_cpf(t.cpf) = vs.cpf_norm
    and t.created_at >= now() - interval '7 days'
    and (t.pagas is null or t.pagas <> 1);
  get diagnostics v3 = row_count;

  with vs as (
    select norm_cpf(cpf) as cpf_norm, valor
    from vendas_gerais
    where valor is not null and cpf is not null
  )
  update leads_chatwoot l
  set valor = vs.valor, pagas = 1
  from vs
  where norm_cpf(l.cpf) = vs.cpf_norm
    and coalesce(l.atualizacao, l.entrada_tabela) >= now() - interval '7 days'
    and (l.pagas is null or l.pagas <> 1);
  get diagnostics v4 = row_count;

  return query select v1, v2, v3, v4;
end;
$$;

grant execute on function dashboard_vendas_sync to anon;

-- Importação de vendas via CSV pra vendas_gerais. peso/ponto/produto NÃO
-- entram aqui — o gatilho calcula tudo sozinho a partir de banco/tabela/
-- parcelas/seguro, então funciona tanto se o arquivo trouxer "tabela"
-- (nome ou código) quanto se trouxer só parcelas + seguro.
create or replace function dashboard_vendas_import(p_rows jsonb)
returns table (inseridos int, ignorados int, total int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inseridos int := 0;
  v_total int := 0;
begin
  select count(*) into v_total from jsonb_array_elements(p_rows);

  with novos as (
    select
      nullif(r->>'adesao', '')::bigint as adesao,
      norm_cpf(r->>'cpf') as cpf,
      nullif(r->>'tabela', '') as tabela,
      nullif(r->>'nome', '') as nome,
      nullif(r->>'valor', '')::numeric as valor,
      nullif(r->>'data', '')::date as data,
      nullif(r->>'banco', '') as banco,
      nullif(r->>'parcelas', '')::int as parcelas,
      nullif(r->>'seguro', '') as seguro
    from jsonb_array_elements(p_rows) r
  ),
  dedup_input as (
    select distinct on (cpf, coalesce(adesao, -1)) *
    from novos
  ),
  a_inserir as (
    select n.* from dedup_input n
    where not exists (
      select 1 from vendas_gerais v
      where norm_cpf(v.cpf) = n.cpf
        and coalesce(v.adesao, -1) = coalesce(n.adesao, -1)
    )
  )
  insert into vendas_gerais (adesao, cpf, tabela, nome, valor, data, banco, parcelas, seguro)
  select adesao, cpf, tabela, nome, valor, data, banco, parcelas, seguro from a_inserir;

  get diagnostics v_inseridos = row_count;

  return query select v_inseridos, (v_total - v_inseridos), v_total;
end;
$$;

-- KPIs gerais: valor/qtd total do período + projeção do dia (valor de hoje)
-- e projeção geral (regra de três: total do mês ÷ dias úteis passados ×
-- dias úteis do mês inteiro — mesma fórmula do portal da vendedora)
create or replace function dashboard_vendas_kpis(
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  valor_total numeric,
  qtd_total bigint,
  valor_hoje numeric,
  projecao_mes numeric
)
language sql
security definer
set search_path = public
stable
as $$
  with hoje as (select (now() at time zone 'America/Sao_Paulo')::date as d),
  mes as (
    select date_trunc('month', d)::date as inicio from hoje
  ),
  periodo as (
    select coalesce(sum(valor), 0) as valor_total, count(*) as qtd_total
    from vendas_gerais
    where (p_date_from is null or data >= p_date_from)
      and (p_date_to is null or data <= p_date_to)
  ),
  hoje_valor as (
    select coalesce(sum(valor), 0) as v from vendas_gerais, hoje where data = hoje.d
  ),
  du_passados as (
    select count(*) as n
    from generate_series((select inicio from mes), (select d from hoje), interval '1 day') g(dia)
    where extract(isodow from g.dia) < 6
  ),
  du_mes as (
    select count(*) as n
    from generate_series((select inicio from mes), (date_trunc('month', (select d from hoje)) + interval '1 month - 1 day')::date, interval '1 day') g(dia)
    where extract(isodow from g.dia) < 6
  ),
  total_mes as (
    select coalesce(sum(valor), 0) as v
    from vendas_gerais, mes, hoje
    where data >= mes.inicio and data <= hoje.d
  )
  select
    (select valor_total from periodo),
    (select qtd_total from periodo),
    (select v from hoje_valor),
    case when (select n from du_passados) > 0
      then round((select v from total_mes) / (select n from du_passados) * (select n from du_mes), 2)
      else 0 end;
$$;

-- KPI por produto (dinâmico — um card por produto existente)
create or replace function dashboard_vendas_por_produto(
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  produto text,
  valor_total numeric,
  qtd_total bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    coalesce(produto, '(sem produto)'),
    coalesce(sum(valor), 0),
    count(*)
  from vendas_gerais
  where (p_date_from is null or data >= p_date_from)
    and (p_date_to is null or data <= p_date_to)
  group by produto
  order by sum(valor) desc;
$$;

-- Vendas por dia (gráfico realizado x projeção — mesmo estilo do portal da
-- vendedora, mas dia a dia e sem recorte por vendedora)
create or replace function dashboard_vendas_por_dia(
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  dia date,
  valor_dia numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select data, coalesce(sum(valor), 0)
  from vendas_gerais
  where data is not null
    and (p_date_from is null or data >= p_date_from)
    and (p_date_to is null or data <= p_date_to)
  group by data
  order by data;
$$;

-- Dias do mês corrente completo (inclusive os sem venda), pro gráfico de
-- realizado x projeção — mesmo estilo do portal da vendedora, mas diário.
create or replace function dashboard_vendas_dias_mes()
returns table (
  dia date,
  valor_dia numeric,
  passada boolean
)
language sql
security definer
set search_path = public
stable
as $$
  with hoje as (select (now() at time zone 'America/Sao_Paulo')::date as d),
  mes as (
    select
      date_trunc('month', d)::date as inicio,
      (date_trunc('month', d) + interval '1 month - 1 day')::date as fim
    from hoje
  )
  select
    g.dia::date,
    coalesce((select sum(v.valor) from vendas_gerais v where v.data = g.dia), 0),
    (g.dia <= (select d from hoje))
  from generate_series((select inicio from mes), (select fim from mes), interval '1 day') g(dia)
  order by g.dia;
$$;

-- Tabela detalhada por campanha (vem do cruzamento com disparochat/total_produtos)
create or replace function dashboard_vendas_por_campanha(
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  campanha text,
  qtd bigint,
  valor numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select
    coalesce(campanha, '(sem campanha)'),
    count(*),
    coalesce(sum(valor), 0)
  from vendas_gerais
  where (p_date_from is null or data >= p_date_from)
    and (p_date_to is null or data <= p_date_to)
  group by campanha
  order by valor desc
  limit 60;
$$;

-- Tabela detalhada por origem (vem do cruzamento com disparochat/total_produtos)
create or replace function dashboard_vendas_por_origem(
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  origem text,
  qtd bigint,
  valor numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select
    coalesce(origem, '(sem origem)'),
    count(*),
    coalesce(sum(valor), 0)
  from vendas_gerais
  where (p_date_from is null or data >= p_date_from)
    and (p_date_to is null or data <= p_date_to)
  group by origem
  order by valor desc
  limit 60;
$$;

grant execute on function dashboard_vendas_import to anon;
grant execute on function dashboard_vendas_kpis to anon;
grant execute on function dashboard_vendas_por_produto to anon;
grant execute on function dashboard_vendas_por_dia to anon;
grant execute on function dashboard_vendas_dias_mes to anon;
grant execute on function dashboard_vendas_por_campanha to anon;
grant execute on function dashboard_vendas_por_origem to anon;
