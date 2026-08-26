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

-- Nome "efetivo" da campanha: quando a linha tem reenvio E campanha_reenvio
-- preenchidos, o nome certo é o de campanha_reenvio (não o de campanha) —
-- senão a campanha mostrada fica desatualizada/errada nesses casos.
create or replace function efetiva_campanha(p_campanha text, p_campanha_reenvio text, p_reenvio timestamptz)
returns text
language sql
immutable
as $$
  select case
    when p_reenvio is not null and p_campanha_reenvio is not null then p_campanha_reenvio
    else p_campanha
  end;
$$;

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
drop function if exists dashboard_kpis(text, text, text, timestamptz, timestamptz, int, int);

drop function if exists dashboard_kpis(text, text, text, timestamptz, timestamptz, int, int, text);

create or replace function dashboard_kpis(
  p_campanha text default null,
  p_origem text default null,
  p_meta text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_hora_inicio int default null,
  p_hora_fim int default null,
  p_tipo_envio text default null,
  p_mensagem text default null
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
    where (p_campanha is null or efetiva_campanha(campanha, campanha_reenvio, reenvio) = p_campanha)
      and (p_origem is null or origem = p_origem)
      and (p_meta is null or meta = p_meta)
      and (p_tipo_envio is null or tipo_envio = p_tipo_envio)
      and (p_mensagem is null or mensagem = p_mensagem)
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
drop function if exists dashboard_envios_por_dia(text, text, text, timestamptz, timestamptz, int, int);

drop function if exists dashboard_envios_por_dia(text, text, text, timestamptz, timestamptz, int, int, text);

create or replace function dashboard_envios_por_dia(
  p_campanha text default null,
  p_origem text default null,
  p_meta text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_hora_inicio int default null,
  p_hora_fim int default null,
  p_tipo_envio text default null,
  p_mensagem text default null
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
      and (p_campanha is null or efetiva_campanha(campanha, campanha_reenvio, reenvio) = p_campanha)
      and (p_origem is null or origem = p_origem)
      and (p_meta is null or meta = p_meta)
      and (p_tipo_envio is null or tipo_envio = p_tipo_envio)
      and (p_mensagem is null or mensagem = p_mensagem)
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
      and (p_campanha is null or efetiva_campanha(campanha, campanha_reenvio, reenvio) = p_campanha)
      and (p_origem is null or origem = p_origem)
      and (p_meta is null or meta = p_meta)
      and (p_tipo_envio is null or tipo_envio = p_tipo_envio)
      and (p_mensagem is null or mensagem = p_mensagem)
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
drop function if exists dashboard_campanhas(text, text, timestamptz, timestamptz, text);

-- "Campanha — Detalhado": uma linha por campanha (já considerando o nome
-- efetivo, que vem de campanha_reenvio quando a linha for um reenvio),
-- com leads totais, envios/reenvios separados, tempo médio de resposta,
-- valor pago, quantidade de pagas e interação.
create or replace function dashboard_campanhas(
  p_origem text default null,
  p_meta text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_tipo_envio text default null,
  p_mensagem text default null
)
returns table (
  campanha text,
  leads_totais bigint,
  envios bigint,
  reenvios bigint,
  tempo_resposta_min numeric,
  valor_pago numeric,
  pagas bigint,
  interacao_qtd bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    efetiva_campanha(campanha, campanha_reenvio, reenvio) as campanha,
    count(*) as leads_totais,
    count(*) filter (where realizado is not null) as envios,
    count(*) filter (where reenvio is not null) as reenvios,
    round(avg(
      extract(epoch from (data_ultima_interacao - coalesce(reenvio, realizado))) / 60.0
    ) filter (
      where data_ultima_interacao is not null
        and coalesce(reenvio, realizado) is not null
        and data_ultima_interacao >= coalesce(reenvio, realizado)
    ), 1) as tempo_resposta_min,
    round(coalesce(sum(pagas), 0), 2) as valor_pago,
    count(*) filter (where pagas is not null) as pagas,
    count(*) filter (where interacao is not null) as interacao_qtd
  from disparochat
  where efetiva_campanha(campanha, campanha_reenvio, reenvio) is not null
    and (p_origem is null or origem = p_origem)
    and (p_meta is null or meta = p_meta)
    and (p_tipo_envio is null or tipo_envio = p_tipo_envio)
    and (p_mensagem is null or mensagem = p_mensagem)
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
  group by efetiva_campanha(campanha, campanha_reenvio, reenvio)
  order by leads_totais desc;
$$;

-- 3b) Distribuição de leads por valor de "conversa"
drop function if exists dashboard_por_conversa(text, text, text, timestamptz, timestamptz, text);

create or replace function dashboard_por_conversa(
  p_campanha text default null,
  p_origem text default null,
  p_meta text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_tipo_envio text default null,
  p_mensagem text default null
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
    and (p_campanha is null or efetiva_campanha(campanha, campanha_reenvio, reenvio) = p_campanha)
    and (p_origem is null or origem = p_origem)
    and (p_meta is null or meta = p_meta)
    and (p_tipo_envio is null or tipo_envio = p_tipo_envio)
    and (p_mensagem is null or mensagem = p_mensagem)
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
drop function if exists dashboard_por_meta(text, text, text, timestamptz, timestamptz, text);

create or replace function dashboard_por_meta(
  p_campanha text default null,
  p_origem text default null,
  p_meta text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_tipo_envio text default null,
  p_mensagem text default null
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
    and (p_campanha is null or efetiva_campanha(campanha, campanha_reenvio, reenvio) = p_campanha)
    and (p_origem is null or origem = p_origem)
    and (p_tipo_envio is null or tipo_envio = p_tipo_envio)
    and (p_mensagem is null or mensagem = p_mensagem)
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
drop function if exists dashboard_por_mensagem(text, text, text, timestamptz, timestamptz, text);

create or replace function dashboard_por_mensagem(
  p_campanha text default null,
  p_origem text default null,
  p_meta text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_tipo_envio text default null
)
returns table (
  valor text,
  leads bigint,
  interacoes bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    mensagem as valor,
    count(*) as leads,
    count(*) filter (where interacao = 1) as interacoes
  from disparochat
  where mensagem is not null
    and (p_campanha is null or efetiva_campanha(campanha, campanha_reenvio, reenvio) = p_campanha)
    and (p_origem is null or origem = p_origem)
    and (p_meta is null or meta = p_meta)
    and (p_tipo_envio is null or tipo_envio = p_tipo_envio)
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
drop function if exists dashboard_produtos_campanhas(text, text, timestamptz, timestamptz);

create or replace function dashboard_produtos_campanhas(
  p_campanha text default null,
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
  where (p_campanha is null or campanha = p_campanha)
    and (p_produto is null or produto = p_produto)
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
drop function if exists dashboard_filtros();

create or replace function dashboard_filtros()
returns table (
  campanhas text[],
  origens text[],
  metas text[],
  tipos_envio text[],
  mensagens text[]
)
language sql
security definer
set search_path = public
stable
as $$
  select
    (select array_agg(distinct x) from (select efetiva_campanha(campanha, campanha_reenvio, reenvio) as x from disparochat) s where x is not null),
    (select array_agg(distinct origem) from disparochat where origem is not null),
    (select array_agg(distinct meta) from disparochat where meta is not null),
    (select array_agg(distinct tipo_envio) from disparochat where tipo_envio is not null),
    (select array_agg(distinct mensagem) from disparochat where mensagem is not null);
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
--      - leads_chatwoot, quando conta = 'chatwoot' OU conta = '1' -> sistema "chatwoot"
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
      case when l.conta in ('chatwoot', '1') then 'chatwoot' else 'vendeai' end as sistema
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
    select conversation_id, case when conta in ('chatwoot', '1') then 'chatwoot' else 'vendeai' end as sistema
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

drop function if exists dashboard_vendedoras_kpis_geral(date, date);

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
  dia_maior_valor_total numeric,
  valor_total numeric,
  qtd_total bigint,
  pontos_total numeric,
  top_ponto_vendedor text,
  top_ponto_valor numeric,
  dia_maior_ponto date,
  dia_maior_ponto_total numeric
)
language sql
security definer
set search_path = public
stable
as $$
  with base as (
    select va.vendedor, va.banco, va.valor, va.data_status as dia,
      coalesce(vg.ponto, 0) as ponto
    from vendedoras_analise va
    left join vendas_gerais vg
      on norm_cpf(vg.cpf) = norm_cpf(va.cpf) and coalesce(vg.adesao, -1) = coalesce(va.adesao, -1)
    where (p_date_from is null or va.data_status >= p_date_from)
      and (p_date_to is null or va.data_status <= p_date_to)
  ),
  por_vendedor as (
    select vendedor, count(*) as qtd, coalesce(sum(valor), 0) as total, coalesce(sum(ponto), 0) as total_ponto
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
    select dia, coalesce(sum(valor), 0) as total, coalesce(sum(ponto), 0) as total_ponto
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
    (select total from por_dia order by total desc limit 1),
    (select coalesce(sum(valor), 0) from base),
    (select count(*) from base),
    (select coalesce(sum(ponto), 0) from base),
    (select vendedor from por_vendedor order by total_ponto desc limit 1),
    (select total_ponto from por_vendedor order by total_ponto desc limit 1),
    (select dia from por_dia order by total_ponto desc limit 1),
    (select total_ponto from por_dia order by total_ponto desc limit 1);
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
  banco_top_qtd bigint,
  pontos_total numeric,
  maior_pontuacao numeric
)
language sql
security definer
set search_path = public
stable
as $$
  with base as (
    select va.valor, va.banco, va.data_status as dia, coalesce(vg.ponto, 0) as ponto
    from vendedoras_analise va
    left join vendas_gerais vg
      on norm_cpf(vg.cpf) = norm_cpf(va.cpf) and coalesce(vg.adesao, -1) = coalesce(va.adesao, -1)
    where va.vendedor = p_vendedor
      and (p_date_from is null or va.data_status >= p_date_from)
      and (p_date_to is null or va.data_status <= p_date_to)
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
    (select qtd from por_banco order by qtd desc limit 1),
    (select coalesce(sum(ponto), 0) from base),
    (select coalesce(max(ponto), 0) from base);
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
  valor_total numeric,
  pontos_total numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select va.data_status as dia, va.vendedor, count(*) as vendas,
    coalesce(sum(va.valor), 0) as valor_total,
    coalesce(sum(vg.ponto), 0) as pontos_total
  from vendedoras_analise va
  left join vendas_gerais vg
    on norm_cpf(vg.cpf) = norm_cpf(va.cpf) and coalesce(vg.adesao, -1) = coalesce(va.adesao, -1)
  where va.data_status is not null
    and (p_vendedor is null or va.vendedor = p_vendedor)
    and (p_date_from is null or va.data_status >= p_date_from)
    and (p_date_to is null or va.data_status <= p_date_to)
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
-- Mesma conta de dias_uteis_passados/dias_uteis_mes/projecao da função
-- individual, só que somando TODAS as vendedoras — usado na visão geral
-- pra mostrar média diária/semanal e projeção diária/semanal do time.
drop function if exists dashboard_vendedoras_medias_geral();

create or replace function dashboard_vendedoras_medias_geral()
returns table (
  total_mes_atual numeric,
  dias_uteis_passados int,
  dias_uteis_mes int,
  projecao_mes numeric,
  projecao_diaria numeric,
  projecao_semanal numeric,
  pontos_mes_atual numeric,
  pontos_projecao_mes numeric,
  pontos_projecao_diaria numeric,
  pontos_projecao_semanal numeric
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
  base_mes as (
    select va.valor, coalesce(vg.ponto, 0) as ponto, va.data_status as dia
    from vendedoras_analise va
    left join vendas_gerais vg
      on norm_cpf(vg.cpf) = norm_cpf(va.cpf) and coalesce(vg.adesao, -1) = coalesce(va.adesao, -1)
    , mes, hoje
    where va.data_status >= mes.inicio and va.data_status <= hoje.d
  ),
  total_mes as (select coalesce(sum(valor), 0) as v, coalesce(sum(ponto), 0) as p from base_mes),
  agora as (
    select
      extract(hour from now() at time zone 'America/Sao_Paulo')
        + extract(minute from now() at time zone 'America/Sao_Paulo') / 60.0 as h,
      extract(isodow from now() at time zone 'America/Sao_Paulo')::int as dow
  ),
  horas_hoje as (
    select case when dow between 1 and 5 then greatest(0, least(h - 8, 10)) else 0 end as passadas
    from agora
  ),
  horas_semana as (
    select (least(greatest((select dow from agora) - 1, 0), 5) * 10) + (select passadas from horas_hoje) as passadas
  ),
  valor_hoje as (select coalesce(sum(valor), 0) as v, coalesce(sum(ponto), 0) as p from base_mes, hoje where dia = hoje.d),
  valor_semana as (
    select coalesce(sum(valor), 0) as v, coalesce(sum(ponto), 0) as p from base_mes, hoje
    where dia >= (hoje.d - (extract(isodow from hoje.d)::int - 1)) and dia <= hoje.d
  )
  select
    (select v from total_mes),
    (select n from du_passados),
    (select n from du_mes),
    case when (select n from du_passados) > 0
      then round((select v from total_mes) / (select n from du_passados) * (select n from du_mes), 2)
      else 0 end,
    case when (select passadas from horas_hoje) > 0
      then round((select v from valor_hoje) / (select passadas from horas_hoje) * 10, 2)
      else 0 end,
    case when (select passadas from horas_semana) > 0
      then round((select v from valor_semana) / (select passadas from horas_semana) * 50, 2)
      else 0 end,
    (select p from total_mes),
    case when (select n from du_passados) > 0
      then round((select p from total_mes) / (select n from du_passados) * (select n from du_mes), 2)
      else 0 end,
    case when (select passadas from horas_hoje) > 0
      then round((select p from valor_hoje) / (select passadas from horas_hoje) * 10, 2)
      else 0 end,
    case when (select passadas from horas_semana) > 0
      then round((select p from valor_semana) / (select passadas from horas_semana) * 50, 2)
      else 0 end;
$$;

drop function if exists dashboard_vendedoras_meta(text);

create or replace function dashboard_vendedoras_meta(p_vendedor text)
returns table (
  total_mes_atual numeric,
  dias_uteis_passados int,
  dias_uteis_mes int,
  projecao_mes numeric,
  semana_atual_valor numeric,
  meta_semana numeric,
  projecao_diaria numeric,
  projecao_semanal numeric,
  pontos_mes_atual numeric,
  pontos_projecao_mes numeric,
  pontos_semana_atual numeric,
  pontos_projecao_diaria numeric,
  pontos_projecao_semanal numeric
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
  base_mes as (
    select va.valor, coalesce(vg.ponto, 0) as ponto, va.data_status as dia
    from vendedoras_analise va
    left join vendas_gerais vg
      on norm_cpf(vg.cpf) = norm_cpf(va.cpf) and coalesce(vg.adesao, -1) = coalesce(va.adesao, -1)
    , mes, hoje
    where va.vendedor = p_vendedor
      and va.data_status >= mes.inicio
      and va.data_status <= hoje.d
  ),
  total_mes as (select coalesce(sum(valor), 0) as v, coalesce(sum(ponto), 0) as p from base_mes),
  semana_atual as (
    select coalesce(sum(valor), 0) as v, coalesce(sum(ponto), 0) as p from base_mes, hoje
    where dia >= (hoje.d - (extract(isodow from hoje.d)::int - 1)) and dia <= hoje.d
  ),
  -- ritmo por hora útil (dia útil = 8h às 18h, 10 horas) — pra projeção do
  -- dia/semana refletir o quanto está entrando por hora, não a média do
  -- mês inteiro (senão dá o mesmo número da média)
  agora as (
    select
      extract(hour from now() at time zone 'America/Sao_Paulo')
        + extract(minute from now() at time zone 'America/Sao_Paulo') / 60.0 as h,
      extract(isodow from now() at time zone 'America/Sao_Paulo')::int as dow
  ),
  horas_hoje as (
    select case when dow between 1 and 5 then greatest(0, least(h - 8, 10)) else 0 end as passadas
    from agora
  ),
  horas_semana as (
    select (least(greatest((select dow from agora) - 1, 0), 5) * 10) + (select passadas from horas_hoje) as passadas
  ),
  valor_hoje as (
    select coalesce(sum(valor), 0) as v, coalesce(sum(ponto), 0) as p from base_mes, hoje where dia = hoje.d
  )
  select
    (select v from total_mes),
    (select n from du_passados),
    (select n from du_mes),
    case when (select n from du_passados) > 0
      then round((select v from total_mes) / (select n from du_passados) * (select n from du_mes), 2)
      else 0 end,
    (select v from semana_atual),
    100000,
    case when (select passadas from horas_hoje) > 0
      then round((select v from valor_hoje) / (select passadas from horas_hoje) * 10, 2)
      else 0 end,
    case when (select passadas from horas_semana) > 0
      then round((select v from semana_atual) / (select passadas from horas_semana) * 50, 2)
      else 0 end,
    (select p from total_mes),
    case when (select n from du_passados) > 0
      then round((select p from total_mes) / (select n from du_passados) * (select n from du_mes), 2)
      else 0 end,
    (select p from semana_atual),
    case when (select passadas from horas_hoje) > 0
      then round((select p from valor_hoje) / (select passadas from horas_hoje) * 10, 2)
      else 0 end,
    case when (select passadas from horas_semana) > 0
      then round((select p from semana_atual) / (select passadas from horas_semana) * 50, 2)
      else 0 end;
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
  passada boolean,
  ponto_semana numeric
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
    (s.semana_fim <= (select d from hoje)),
    coalesce((
      select sum(coalesce(vg.ponto, 0)) from vendedoras_analise va
      left join vendas_gerais vg
        on norm_cpf(vg.cpf) = norm_cpf(va.cpf) and coalesce(vg.adesao, -1) = coalesce(va.adesao, -1)
      where va.vendedor = p_vendedor and va.data_status between s.semana_inicio and s.semana_fim
    ), 0)
  from semanas s
  order by s.semana;
$$;

-- Adicionar uma venda avulsa (portal da vendedora). data_status e vendedor
-- são sempre definidos automaticamente pelo servidor — nunca pelo cliente.
-- garante as colunas novas (parcelas/seguro você já criou; data_pagamento
-- fica aqui por segurança, sem custo se já existir)
alter table vendedoras_analise add column if not exists data_pagamento date;

drop function if exists dashboard_vendedoras_add_venda(text, bigint, text, text, numeric, text);

create or replace function dashboard_vendedoras_add_venda(
  p_vendedor text,
  p_adesao bigint,
  p_cpf text,
  p_nome text,
  p_valor numeric,
  p_banco text,
  p_tabela text default null,
  p_data_pagamento date default null,
  p_parcelas int default null,
  p_seguro text default null
)
returns table (ok boolean, mensagem text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cpf text;
  v_data date;
begin
  if p_vendedor is null or p_adesao is null or p_cpf is null or p_nome is null
     or p_valor is null or p_banco is null or trim(p_cpf) = '' or trim(p_nome) = '' or trim(p_banco) = '' then
    return query select false, 'Preencha adesão, cpf, nome, valor e banco.';
    return;
  end if;

  v_cpf := norm_cpf(p_cpf);
  -- se não vier preenchida, a data de pagamento é hoje
  v_data := coalesce(p_data_pagamento, (now() at time zone 'America/Sao_Paulo')::date);

  if exists (
    select 1 from vendedoras_analise
    where norm_cpf(cpf) = v_cpf and coalesce(adesao, -1) = p_adesao
  ) then
    return query select false, 'Já existe uma venda com esse CPF e adesão.';
    return;
  end if;

  insert into vendedoras_analise (data_status, banco, adesao, cpf, nome, vendedor, valor, tabela, data_pagamento, parcelas, seguro)
  values ((now() at time zone 'America/Sao_Paulo')::date, p_banco, p_adesao, v_cpf, p_nome, p_vendedor, p_valor, p_tabela, v_data, p_parcelas, p_seguro);

  -- espelha também na visão geral de Vendas (se ainda não existir lá) — já
  -- levando tabela/parcelas/seguro, pro gatilho calcular o peso certo
  if not exists (
    select 1 from vendas_gerais
    where norm_cpf(cpf) = v_cpf and coalesce(adesao, -1) = p_adesao
  ) then
    insert into vendas_gerais (data, banco, adesao, cpf, nome, valor, tabela, parcelas, seguro)
    values ((now() at time zone 'America/Sao_Paulo')::date, p_banco, p_adesao, v_cpf, p_nome, p_valor, p_tabela, p_parcelas, p_seguro);
  end if;

  return query select true, 'Venda adicionada com sucesso.';
end;
$$;

grant execute on function dashboard_vendedoras_meta to anon;
grant execute on function dashboard_vendedoras_medias_geral to anon;
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
language plpgsql
immutable
as $$
declare
  codigo text := substring(upper(coalesce(p_tabela, '')) from '[0-9]{4,6}');
begin
  -- reconhece REFIN pelo texto "REFIN" OU pelos códigos Facta que já são
  -- refin mesmo quando o campo tabela só traz o número, sem a palavra
  if upper(coalesce(p_tabela, '')) like '%REFIN%'
     or codigo in ('69272', '69264', '69256', '69280', '69299', '69302', '641130', '64181', '61433', '64785')
  then
    return 'REFIN';
  end if;

  if upper(replace(coalesce(p_banco, ''), '_', ' ')) like '%CREFAZ%' then
    return 'ENERGIA';
  end if;

  if upper(replace(coalesce(p_banco, ''), '_', ' ')) like '%NOVO SAQUE%'
     -- reforço só quando o banco vier vazio de verdade — "GOLD"/"SMART"
     -- também aparecem em nomes de tabela da Facta, então nunca pode
     -- sobrescrever um banco já identificado
     or (
       (p_banco is null or trim(p_banco) = '')
       and upper(coalesce(p_tabela, '')) ~ '(^|[^A-Z])(TABELA )?(NS|CAMPANHA|DIAMANTE|GOLD|MONEY|LIGHT|SOFT|SMART|ZERO)([^A-Z]|$)'
     )
  then
    return 'FGTS';
  end if;

  -- V8 com as tabelas "Acelera / Cometa / Grid / Turbo / Normal / Pit Stop"
  -- são produto FGTS (V8 sem essas tabelas continua CLT, mais abaixo)
  if upper(replace(coalesce(p_banco, ''), '_', ' ')) like '%V8%'
     and (
       upper(coalesce(p_tabela, '')) like '%ACELERA%'
       or upper(coalesce(p_tabela, '')) like '%COMETA%'
       or upper(coalesce(p_tabela, '')) like '%GRID%'
       or upper(coalesce(p_tabela, '')) like '%TURBO%'
       or upper(coalesce(p_tabela, '')) like '%PIT STOP%'
       or upper(coalesce(p_tabela, '')) like '%PITSTOP%'
       or upper(coalesce(p_tabela, '')) like '%NORMAL%'
     )
  then
    return 'FGTS';
  end if;

  return 'CLT';
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
  banco_norm text := upper(replace(coalesce(p_banco, ''), '_', ' '));
  tabela_norm text := upper(coalesce(p_tabela, ''));
  codigo text;
  tem_seguro boolean := upper(coalesce(p_seguro, '')) in ('SIM', 'S', 'TRUE', '1', 'COM SEGURO', 'COM');
  -- fallback: quando a coluna vem vazia, tenta extrair do texto da tabela
  -- (ex: "V8 CLT S/SEGURO 36") — exige que o número não esteja colado a uma
  -- letra, pra não confundir o "8" de "V8" com a quantidade de parcelas
  parcelas_texto int := nullif(substring(upper(coalesce(p_tabela, '')) from '[^0-9A-Za-z]([0-9]{1,2})(?:[^0-9]|$)'), '')::int;
  tem_seguro_efetivo boolean := case
    when p_seguro is not null and trim(p_seguro) <> '' then tem_seguro
    when upper(coalesce(p_tabela, '')) like '%S/SEGURO%' or upper(coalesce(p_tabela, '')) like '%SEM SEGURO%' then false
    when upper(coalesce(p_tabela, '')) like '%C/SEGURO%' or upper(coalesce(p_tabela, '')) like '%COM SEGURO%' then true
    else tem_seguro
  end;
begin
  -- extrai um código numérico de 4 a 6 dígitos do texto da tabela (se houver)
  codigo := substring(tabela_norm from '[0-9]{4,6}');

  -- FACTA
  if banco_norm like '%FACTA%' then
    -- códigos sem ambiguidade: o peso é o mesmo não importa qual parcela da
    -- lista o cliente pegou, então não exige a coluna parcelas preenchida
    if codigo = '69205' then return 1.45; end if;
    if codigo in ('69191','69183','69035','69027','69043','69051') then return 1.35; end if;
    if codigo in ('69167','69175') then return 1.25; end if;
    if codigo = '69159' then return 1.20; end if;
    if codigo in ('69140','69060') then return 1.15; end if;
    if codigo = '69132' then return 1.10; end if;
    if codigo in ('692213','69221','69230') then return 1.10; end if;
    if codigo in ('69078','69086') then return 0.90; end if;
    if codigo = '69213' then return 0.90; end if;
    if codigo = '69116' then return 0.90; end if;
    if codigo in ('69019','69094') then return 0.80; end if;
    if codigo = '69272' then return 0.90; end if;
    if codigo = '69264' then return 0.80; end if;
    if codigo = '69256' then return 0.70; end if;
    if codigo = '69280' then return 0.60; end if;
    if codigo in ('61107','61093','61085') then return 0.35; end if;
    if codigo in ('69299','69302') then return 0.35; end if;
    if codigo in ('64815','64823','64831') then return 0.00; end if;
    if codigo in ('66044','65943') then return 0.75; end if;
    if codigo in ('66060','66052','65951') then return 0.90; end if;
    if codigo = '641130' then return 0.75; end if;
    if codigo = '64181' then return 0.60; end if;
    if codigo in ('61433','64785') then return 0.30; end if;

    -- códigos ambíguos: o MESMO código vale pesos diferentes dependendo da
    -- quantidade de parcelas — aqui sim precisa saber a parcela pra decidir
    if codigo in ('66036','66028') then
      if p_parcelas = 60 then return 1.15; end if;
      if p_parcelas = 48 then return 1.00; end if;
      return null;
    end if;
    if codigo = '66010' then
      if p_parcelas = 48 then return 1.00; end if;
      if p_parcelas = 36 then return 0.90; end if;
      return null;
    end if;
    if codigo in ('66095','66087') then
      if p_parcelas in (48,60) then return 0.80; end if;
      if p_parcelas = 36 then return 0.65; end if;
      return null;
    end if;
    if codigo in ('66079','65935') then
      if p_parcelas = 36 then return 0.65; end if;
      if p_parcelas = 24 then return 0.55; end if;
      return null;
    end if;

    return null;
  end if;

  -- CREFAZ
  if banco_norm like '%CREFAZ%' then
    if p_parcelas is not null then
      if p_parcelas between 9 and 24 then return 1.65; end if;
      if p_parcelas between 1 and 8 then return 1.30; end if;
      return null;
    end if;
    -- coluna parcelas vazia: tenta reconhecer a faixa pelo texto da tabela
    -- (ex: "CRÉDITO CONTA DE LUZ 9-24")
    if tabela_norm ~ '9\s*-\s*24' or tabela_norm ~ '9\s*A\s*24' then return 1.65; end if;
    if tabela_norm ~ '1\s*-\s*8' or tabela_norm ~ '1\s*A\s*8' then return 1.30; end if;
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

  -- PRESENÇA — o número de parcelas às vezes vem só no texto da tabela
  -- (ex: "PRESENÇA 36"), não na coluna parcelas — extrai de lá nesse caso
  if banco_norm like '%PRESEN%' then
    return case coalesce(p_parcelas, nullif(substring(tabela_norm from '[0-9]{2}'), '')::int)
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

  -- NOVO SAQUE (por banco OU pelo nome da tabela quando o banco vier vazio
  -- de verdade — "GOLD"/"SMART" também existem em nomes da Facta, então
  -- esse reforço nunca pode sobrescrever um banco já identificado)
  if banco_norm like '%NOVO SAQUE%'
     or (
       trim(banco_norm) = ''
       and tabela_norm ~ '(^|[^A-Z])(TABELA )?(NS|CAMPANHA|DIAMANTE|GOLD|MONEY|LIGHT|SOFT|SMART|ZERO)([^A-Z]|$)'
     )
  then
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

  -- V8 FGTS (tabelas Acelera/Cometa/Grid/Turbo/Normal/Pit Stop, 1 a 5 parcelas)
  -- -- checado antes do V8 consignado generico, senao nunca seria alcancado
  if banco_norm like '%V8%' then
    if tabela_norm like '%ACELERA%' then return 12.00; end if;
    if tabela_norm like '%COMETA%' then return 9.00; end if;
    if tabela_norm like '%GRID%' then return 6.00; end if;
    if tabela_norm like '%TURBO%' then return 5.50; end if;
    if tabela_norm like '%PIT STOP%' or tabela_norm like '%PITSTOP%' then return 1.80; end if;
    if tabela_norm like '%NORMAL%' then return 4.50; end if;
  end if;

  -- V8 (consignado privado) -- demais tabelas V8 que nao sao FGTS
  if banco_norm like '%V8%' then
    if tem_seguro_efetivo then
      return case coalesce(p_parcelas, parcelas_texto)
        when 46 then 2.40
        when 36 then 2.20
        when 24 then 1.60
        when 18 then 1.40
        when 12 then 1.20
        when 6 then 0.60
        when 8 then 0.60
        when 10 then 0.60
        else null
      end;
    else
      return case coalesce(p_parcelas, parcelas_texto)
        when 46 then 1.40
        when 36 then 1.20
        when 24 then 1.00
        when 12 then 0.80
        when 18 then 0.80
        when 6 then 0.20
        when 8 then 0.20
        when 10 then 0.20
        else null
      end;
    end if;
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
-- Coluna nova: marca quando a venda tambem esta em vendedoras_analise
alter table vendas_gerais add column if not exists vendedor text;

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
      case when l.conta in ('chatwoot', '1') then 'chatwoot' else 'vendeai' end as sistema
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

  -- 1d) mantém a coluna "vendedor" em dia, cruzando com vendedoras_analise
  with match_v as (
    select distinct on (norm_cpf(va.cpf))
      norm_cpf(va.cpf) as cpf_norm, va.vendedor
    from vendedoras_analise va
    where va.cpf is not null and va.vendedor is not null
    order by norm_cpf(va.cpf), va.data_status desc
  )
  update vendas_gerais v
  set vendedor = m.vendedor
  from match_v m
  where norm_cpf(v.cpf) = m.cpf_norm
    and v.vendedor is null;

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
drop function if exists dashboard_vendas_import(jsonb);

create or replace function dashboard_vendas_import(p_rows jsonb)
returns table (inseridos int, atualizados int, ignorados int, total int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inseridos int := 0;
  v_atualizados int := 0;
  v_total int := 0;
begin
  select count(*) into v_total from jsonb_array_elements(p_rows);

  create temporary table tmp_vendas_import on commit drop as
  select distinct on (norm_cpf(r->>'cpf'), coalesce(nullif(r->>'adesao', '')::bigint, -1))
    nullif(r->>'adesao', '')::bigint as adesao,
    norm_cpf(r->>'cpf') as cpf,
    nullif(r->>'tabela', '') as tabela,
    nullif(r->>'nome', '') as nome,
    nullif(r->>'valor', '')::numeric as valor,
    nullif(r->>'data', '')::date as data,
    nullif(r->>'banco', '') as banco,
    nullif(r->>'parcelas', '')::int as parcelas,
    nullif(r->>'seguro', '') as seguro
  from jsonb_array_elements(p_rows) r;

  -- 1) quem já existe (mesmo cpf+adesão) mas está com peso vazio: atualiza
  -- só os campos que ainda estavam nulos (nunca sobrescreve o que já tinha
  -- valor) — isso dá ao gatilho outra chance de calcular o peso certo
  update vendas_gerais v
  set
    tabela = coalesce(v.tabela, t.tabela),
    banco = coalesce(v.banco, t.banco),
    parcelas = coalesce(v.parcelas, t.parcelas),
    seguro = coalesce(v.seguro, t.seguro),
    valor = coalesce(v.valor, t.valor),
    nome = coalesce(v.nome, t.nome),
    data = coalesce(v.data, t.data)
  from tmp_vendas_import t
  where norm_cpf(v.cpf) = t.cpf
    and coalesce(v.adesao, -1) = coalesce(t.adesao, -1)
    and v.peso is null;
  get diagnostics v_atualizados = row_count;

  -- 2) quem ainda não existe na base: insere normalmente
  insert into vendas_gerais (adesao, cpf, tabela, nome, valor, data, banco, parcelas, seguro)
  select t.adesao, t.cpf, t.tabela, t.nome, t.valor, t.data, t.banco, t.parcelas, t.seguro
  from tmp_vendas_import t
  where not exists (
    select 1 from vendas_gerais v
    where norm_cpf(v.cpf) = t.cpf
      and coalesce(v.adesao, -1) = coalesce(t.adesao, -1)
  );
  get diagnostics v_inseridos = row_count;

  return query select v_inseridos, v_atualizados, (v_total - v_inseridos - v_atualizados), v_total;
end;
$$;

-- KPIs gerais: valor/qtd total do período + projeção do mês (regra de três:
-- total do mês ÷ dias úteis passados × dias úteis do mês inteiro) + médias/
-- projeções diária e semanal + % de vendas atribuídas a vendedoras
drop function if exists dashboard_vendas_kpis(date, date);

drop function if exists dashboard_vendas_kpis(date, date, text);

create or replace function dashboard_vendas_kpis(
  p_date_from date default null,
  p_date_to date default null,
  p_produto text default null
)
returns table (
  valor_total numeric,
  qtd_total bigint,
  valor_hoje numeric,
  projecao_mes numeric,
  pontos_total numeric,
  pontos_projecao_mes numeric,
  qtd_vendedor bigint,
  valor_vendedor numeric,
  pontos_vendedor numeric,
  dias_uteis_passados int,
  dias_uteis_mes int,
  total_mes_valor numeric,
  total_mes_pontos numeric,
  projecao_diaria_valor numeric,
  projecao_diaria_pontos numeric,
  projecao_semanal_valor numeric,
  projecao_semanal_pontos numeric
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
    select
      coalesce(sum(valor), 0) as valor_total,
      count(*) as qtd_total,
      coalesce(sum(ponto), 0) as pontos_total,
      count(*) filter (where vendedor is not null) as qtd_vendedor,
      coalesce(sum(valor) filter (where vendedor is not null), 0) as valor_vendedor,
      coalesce(sum(ponto) filter (where vendedor is not null), 0) as pontos_vendedor
    from vendas_gerais
    where (p_date_from is null or data >= p_date_from)
      and (p_date_to is null or data <= p_date_to)
      and (p_produto is null or produto = p_produto)
  ),
  hoje_valor as (
    select coalesce(sum(valor), 0) as v
    from vendas_gerais, hoje
    where data = hoje.d
      and (p_produto is null or produto = p_produto)
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
    select coalesce(sum(valor), 0) as v, coalesce(sum(ponto), 0) as p
    from vendas_gerais, mes, hoje
    where data >= mes.inicio and data <= hoje.d
      and (p_produto is null or produto = p_produto)
  ),
  agora as (
    select
      extract(hour from now() at time zone 'America/Sao_Paulo')
        + extract(minute from now() at time zone 'America/Sao_Paulo') / 60.0 as h,
      extract(isodow from now() at time zone 'America/Sao_Paulo')::int as dow
  ),
  horas_hoje as (
    select case when dow between 1 and 5 then greatest(0, least(h - 8, 10)) else 0 end as passadas
    from agora
  ),
  horas_semana as (
    select (least(greatest((select dow from agora) - 1, 0), 5) * 10) + (select passadas from horas_hoje) as passadas
  ),
  valor_hoje_real as (
    select coalesce(sum(valor), 0) as v, coalesce(sum(ponto), 0) as p
    from vendas_gerais, hoje
    where data = hoje.d
      and (p_produto is null or produto = p_produto)
  ),
  valor_semana_real as (
    select coalesce(sum(valor), 0) as v, coalesce(sum(ponto), 0) as p
    from vendas_gerais, hoje
    where data >= (hoje.d - (extract(isodow from hoje.d)::int - 1))
      and data <= hoje.d
      and (p_produto is null or produto = p_produto)
  )
  select
    (select valor_total from periodo),
    (select qtd_total from periodo),
    (select v from hoje_valor),
    case when (select n from du_passados) > 0
      then round((select v from total_mes) / (select n from du_passados) * (select n from du_mes), 2)
      else 0 end,
    (select pontos_total from periodo),
    case when (select n from du_passados) > 0
      then round((select p from total_mes) / (select n from du_passados) * (select n from du_mes), 2)
      else 0 end,
    (select qtd_vendedor from periodo),
    (select valor_vendedor from periodo),
    (select pontos_vendedor from periodo),
    (select n from du_passados),
    (select n from du_mes),
    (select v from total_mes),
    (select p from total_mes),
    case when (select passadas from horas_hoje) > 0
      then round((select v from valor_hoje_real) / (select passadas from horas_hoje) * 10, 2)
      else 0 end,
    case when (select passadas from horas_hoje) > 0
      then round((select p from valor_hoje_real) / (select passadas from horas_hoje) * 10, 2)
      else 0 end,
    case when (select passadas from horas_semana) > 0
      then round((select v from valor_semana_real) / (select passadas from horas_semana) * 50, 2)
      else 0 end,
    case when (select passadas from horas_semana) > 0
      then round((select p from valor_semana_real) / (select passadas from horas_semana) * 50, 2)
      else 0 end;
$$;

grant execute on function dashboard_vendas_kpis to anon;

-- KPI por produto (dinâmico — um card por produto existente)
drop function if exists dashboard_vendas_por_produto(date, date);

drop function if exists dashboard_vendas_por_produto(date, date);

create or replace function dashboard_vendas_por_produto(
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  produto text,
  valor_total numeric,
  qtd_total bigint,
  pontos_total numeric,
  projecao_mes numeric,
  pontos_projecao_mes numeric
)
language sql
security definer
set search_path = public
stable
as $$
  with hoje as (select (now() at time zone 'America/Sao_Paulo')::date as d),
  mes as (select date_trunc('month', d)::date as inicio from hoje),
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
  agg as (
    select
      produto,
      coalesce(sum(valor), 0) as valor_total,
      count(*) as qtd_total,
      coalesce(sum(ponto), 0) as pontos_total
    from vendas_gerais
    where (p_date_from is null or data >= p_date_from)
      and (p_date_to is null or data <= p_date_to)
    group by produto
  ),
  mes_por_produto as (
    select produto, coalesce(sum(valor), 0) as v, coalesce(sum(ponto), 0) as p
    from vendas_gerais, mes, hoje
    where data >= mes.inicio and data <= hoje.d
    group by produto
  )
  select
    coalesce(a.produto, '(sem produto)'),
    a.valor_total,
    a.qtd_total,
    a.pontos_total,
    case when (select n from du_passados) > 0
      then round(coalesce(m.v, 0) / (select n from du_passados) * (select n from du_mes), 2)
      else 0 end,
    case when (select n from du_passados) > 0
      then round(coalesce(m.p, 0) / (select n from du_passados) * (select n from du_mes), 2)
      else 0 end
  from agg a
  left join mes_por_produto m on m.produto is not distinct from a.produto
  order by a.pontos_total desc;
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
drop function if exists dashboard_vendas_dias_mes();

drop function if exists dashboard_vendas_dias_mes();

create or replace function dashboard_vendas_dias_mes(p_produto text default null)
returns table (
  dia date,
  valor_dia numeric,
  ponto_dia numeric,
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
    coalesce((select sum(v.valor) from vendas_gerais v where v.data = g.dia and (p_produto is null or v.produto = p_produto)), 0),
    coalesce((select sum(v.ponto) from vendas_gerais v where v.data = g.dia and (p_produto is null or v.produto = p_produto)), 0),
    (g.dia <= (select d from hoje))
  from generate_series((select inicio from mes), (select fim from mes), interval '1 day') g(dia)
  order by g.dia;
$$;

-- Tabela detalhada por campanha (vem do cruzamento com disparochat/total_produtos)
create or replace function dashboard_vendas_por_campanha(
  p_date_from date default null,
  p_date_to date default null,
  p_produto text default null
)
returns table (
  campanha text,
  qtd bigint,
  valor numeric,
  pontos numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select
    campanha,
    count(*),
    coalesce(sum(valor), 0),
    coalesce(sum(ponto), 0)
  from vendas_gerais
  where campanha is not null
    and (p_date_from is null or data >= p_date_from)
    and (p_date_to is null or data <= p_date_to)
    and (p_produto is null or produto = p_produto)
  group by campanha
  order by coalesce(sum(ponto), 0) desc
  limit 300;
$$;

-- Tabela detalhada por origem (vem do cruzamento com disparochat/total_produtos)
create or replace function dashboard_vendas_por_origem(
  p_date_from date default null,
  p_date_to date default null,
  p_produto text default null
)
returns table (
  origem text,
  qtd bigint,
  valor numeric,
  pontos numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select
    origem,
    count(*),
    coalesce(sum(valor), 0),
    coalesce(sum(ponto), 0)
  from vendas_gerais
  where origem is not null
    and (p_date_from is null or data >= p_date_from)
    and (p_date_to is null or data <= p_date_to)
    and (p_produto is null or produto = p_produto)
  group by origem
  order by coalesce(sum(ponto), 0) desc
  limit 300;
$$;

grant execute on function dashboard_vendas_import to anon;
grant execute on function dashboard_vendas_kpis to anon;
grant execute on function dashboard_vendas_por_produto to anon;
grant execute on function dashboard_vendas_por_dia to anon;
grant execute on function dashboard_vendas_dias_mes to anon;
grant execute on function dashboard_vendas_por_campanha to anon;
grant execute on function dashboard_vendas_por_origem to anon;

-- Diagnóstico temporário: agrupa as linhas de vendas_gerais com peso nulo,
-- pra identificar padrões (banco sem regra, combinação de parcelas/seguro
-- não coberta, etc.) em vez de adivinhar caso a caso.
create or replace function dashboard_debug_peso_nulo()
returns table (
  banco text,
  tabela_amostra text,
  parcelas int,
  seguro text,
  qtd bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    banco,
    max(tabela) as tabela_amostra,
    parcelas,
    seguro,
    count(*) as qtd
  from vendas_gerais
  where peso is null
  group by banco, parcelas, seguro
  order by qtd desc;
$$;

grant execute on function dashboard_debug_peso_nulo to anon;

-- Guarda a sessão de login do Chatwoot (cookies), pro serverless (Vercel)
-- reaproveitar entre execuções, já que não tem disco persistente lá.
create table if not exists chatwoot_sessao (
  id int primary key default 1,
  dados jsonb not null,
  atualizado_em timestamptz not null default now(),
  constraint um_registro_so check (id = 1)
);

-- ============================================================
-- Trava contra dados corrompidos em vendas_gerais (CPF sem normalizar,
-- valor/ponto com resíduo de ponto flutuante, e duplicatas de
-- CPF+adesão) — normaliza tudo automaticamente em qualquer insert/update,
-- não importa de onde venha (import manual, sync, ou webhook externo).
create or replace function vendas_gerais_normalize()
returns trigger
language plpgsql
as $$
begin
  new.cpf := norm_cpf(new.cpf);
  if new.valor is not null then new.valor := round(new.valor, 2); end if;
  if new.ponto is not null then new.ponto := round(new.ponto, 2); end if;
  return new;
end;
$$;

drop trigger if exists trg_vendas_gerais_normalize on vendas_gerais;
create trigger trg_vendas_gerais_normalize
  before insert or update on vendas_gerais
  for each row execute function vendas_gerais_normalize();

create unique index if not exists vendas_gerais_cpf_adesao_uidx
  on vendas_gerais (cpf, coalesce(adesao, -1));

-- ============================================================
-- Configuracao de metas (valor e pontos, por periodo) usada na
-- view geral "Vendedoras".
-- ============================================================
CREATE TABLE IF NOT EXISTS metas_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  valor_diaria numeric DEFAULT 0,
  valor_semanal numeric DEFAULT 100000,
  valor_mensal numeric DEFAULT 0,
  ponto_diaria numeric DEFAULT 0,
  ponto_semanal numeric DEFAULT 0,
  ponto_mensal numeric DEFAULT 0,
  tipo_ativo text DEFAULT 'valor',
  periodo_ativo text DEFAULT 'semanal',
  atualizado_em timestamptz DEFAULT now()
);

INSERT INTO metas_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION dashboard_metas_progresso(p_vendedor text DEFAULT NULL)
RETURNS TABLE (
  tipo_ativo text,
  periodo_ativo text,
  valor_diaria numeric, valor_semanal numeric, valor_mensal numeric,
  ponto_diaria numeric, ponto_semanal numeric, ponto_mensal numeric,
  realizado_dia_valor numeric, realizado_semana_valor numeric, realizado_mes_valor numeric,
  realizado_dia_ponto numeric, realizado_semana_ponto numeric, realizado_mes_ponto numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  WITH hoje AS (SELECT (now() at time zone 'America/Sao_Paulo')::date AS d),
  cfg AS (SELECT * FROM metas_config WHERE id = 1),
  base AS (
    SELECT data, valor, ponto
    FROM vendas_gerais, hoje
    WHERE vendedor IS NOT NULL
      AND (p_vendedor IS NULL OR vendedor = p_vendedor)
      AND data >= date_trunc('month', hoje.d)::date
      AND data <= hoje.d
  )
  SELECT
    cfg.tipo_ativo, cfg.periodo_ativo,
    cfg.valor_diaria, cfg.valor_semanal, cfg.valor_mensal,
    cfg.ponto_diaria, cfg.ponto_semanal, cfg.ponto_mensal,
    coalesce((SELECT sum(b.valor) FROM base b, hoje WHERE b.data = hoje.d), 0),
    coalesce((SELECT sum(b.valor) FROM base b, hoje WHERE b.data >= hoje.d - (extract(isodow FROM hoje.d)::int - 1)), 0),
    coalesce((SELECT sum(b.valor) FROM base b), 0),
    coalesce((SELECT sum(b.ponto) FROM base b, hoje WHERE b.data = hoje.d), 0),
    coalesce((SELECT sum(b.ponto) FROM base b, hoje WHERE b.data >= hoje.d - (extract(isodow FROM hoje.d)::int - 1)), 0),
    coalesce((SELECT sum(b.ponto) FROM base b), 0)
  FROM cfg;
$$;

GRANT EXECUTE ON FUNCTION dashboard_metas_progresso TO anon;

CREATE OR REPLACE FUNCTION dashboard_metas_set(
  p_valor_diaria numeric DEFAULT NULL,
  p_valor_semanal numeric DEFAULT NULL,
  p_valor_mensal numeric DEFAULT NULL,
  p_ponto_diaria numeric DEFAULT NULL,
  p_ponto_semanal numeric DEFAULT NULL,
  p_ponto_mensal numeric DEFAULT NULL,
  p_tipo_ativo text DEFAULT NULL,
  p_periodo_ativo text DEFAULT NULL
)
RETURNS TABLE (ok boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE metas_config SET
    valor_diaria = coalesce(p_valor_diaria, valor_diaria),
    valor_semanal = coalesce(p_valor_semanal, valor_semanal),
    valor_mensal = coalesce(p_valor_mensal, valor_mensal),
    ponto_diaria = coalesce(p_ponto_diaria, ponto_diaria),
    ponto_semanal = coalesce(p_ponto_semanal, ponto_semanal),
    ponto_mensal = coalesce(p_ponto_mensal, ponto_mensal),
    tipo_ativo = coalesce(p_tipo_ativo, tipo_ativo),
    periodo_ativo = coalesce(p_periodo_ativo, periodo_ativo),
    atualizado_em = now()
  WHERE id = 1
  RETURNING true;
$$;

GRANT EXECUTE ON FUNCTION dashboard_metas_set TO anon;
