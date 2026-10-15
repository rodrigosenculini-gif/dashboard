-- 15/10: Desenvolvimento (programa de treinamentos fora da mesa, 19/10/2026 a 22/01/2027).
-- Tela "Desenvolvimento" (só perfil geral): agenda dos 13 encontros, lançamento das notas por
-- vendedora durante o encontro, evolução por pessoa (cruzada com crm_qualidade), formatos e marcos D30/D60/D90.
-- Aplicado via MCP: dev_desenvolvimento_treinamentos. Só objetos novos (prefixo dev_); nada existente muda.
-- RLS ligado sem políticas: a API conecta direto pelo pg (dono das tabelas), então continua lendo/gravando.

-- ------------------------------------------------------------------ tabelas
create table if not exists public.dev_formatos (
  id        text primary key,
  nome      text not null,
  descricao text,
  modo      text not null default 'todos' check (modo in ('todos', 'turmas')),
  ordem     int
);

create table if not exists public.dev_encontros (
  id          bigserial primary key,
  data        date not null,
  semana      int,
  fase        text check (fase in ('destravar', 'converter', 'evoluir')),
  formato_id  text references public.dev_formatos(id),
  nivel       int,
  turma       text,
  titulo      text,
  status      text not null default 'planejado' check (status in ('planejado', 'feito', 'adiado', 'cancelado')),
  condutor    text,
  anotador    text,
  observacao  text,
  created_at  timestamptz not null default now()
);
create index if not exists dev_encontros_data_idx on public.dev_encontros (data);

create table if not exists public.dev_participacoes (
  id           bigserial primary key,
  encontro_id  bigint not null references public.dev_encontros(id) on delete cascade,
  vendedor     text not null,
  agent_id     bigint,
  presente     boolean not null default true,
  notas        jsonb not null default '{}'::jsonb,
  especificos  jsonb not null default '{}'::jsonb,
  observacao   text,
  compromisso  text,
  lancado_por  text,
  updated_at   timestamptz not null default now(),
  unique (encontro_id, vendedor)
);
create index if not exists dev_participacoes_vendedor_idx on public.dev_participacoes (vendedor);

create table if not exists public.dev_marcos (
  id          bigserial primary key,
  marco       text not null check (marco in ('D30', 'D60', 'D90')),
  data        date,
  vendedor    text,            -- null = time todo
  resumo      text,
  decisoes    text,
  created_at  timestamptz not null default now()
);

alter table public.dev_formatos      enable row level security;
alter table public.dev_encontros     enable row level security;
alter table public.dev_participacoes enable row level security;
alter table public.dev_marcos        enable row level security;

-- ------------------------------------------------------------------ seeds
insert into public.dev_formatos (id, nome, descricao, modo, ordem) values
  ('palco',     'Palco do Sim',             'Teatro de improviso: confiança, timidez e medo de errar',      'todos',  1),
  ('pele',      'Na Pele do Cliente',       'Vendedores vivem um cliente real e recebem atendimentos',      'todos',  2),
  ('passa',     'Passa ou Repassa',         'Jogo de auditório em equipes: decidir rápido e arriscar',      'todos',  3),
  ('teatro',    'Teatro do Cliente',        'Encenação com cards de cliente, devolutiva e refaz',           'turmas', 4),
  ('tribunal',  'Tribunal da Objeção',      'Debate em equipes: defesa do cliente x vendedores',            'todos',  5),
  ('jornada',   'Jornada Hotline',          'Tabuleiro gigante com as etapas da venda',                     'todos',  6),
  ('detetives', 'Detetives do Atendimento', 'Investigar uma venda perdida real',                            'todos',  7),
  ('roda',      'Roda de Experiências',     'Conversa quinzenal puxada pelos veteranos',                    'todos',  8)
on conflict (id) do nothing;

insert into public.dev_encontros (data, semana, fase, formato_id, nivel, turma, titulo)
select v.data::date, v.semana, v.fase, v.formato_id, v.nivel, v.turma, v.titulo
from (values
  ('2026-10-21', 1,  'destravar', 'palco',     1,    null, 'Abertura + Palco do Sim'),
  ('2026-10-28', 2,  'destravar', 'pele',      1,    null, 'Na Pele do Cliente'),
  ('2026-11-04', 3,  'destravar', 'roda',      null, null, 'Roda 1'),
  ('2026-11-04', 3,  'destravar', 'palco',     2,    null, 'Palco do Sim · nível 2'),
  ('2026-11-11', 4,  'destravar', 'passa',     1,    null, 'Passa ou Repassa'),
  ('2026-11-17', 5,  'converter', 'teatro',    1,    'A',  'Teatro do Cliente · nível 1'),
  ('2026-11-18', 5,  'converter', 'teatro',    1,    'B',  'Teatro do Cliente · nível 1'),
  ('2026-11-19', 5,  'converter', 'teatro',    1,    'C',  'Teatro do Cliente · nível 1'),
  ('2026-11-25', 6,  'converter', 'roda',      null, null, 'Roda 2'),
  ('2026-11-25', 6,  'converter', 'tribunal',  1,    null, 'Tribunal da Objeção'),
  ('2026-12-02', 7,  'converter', 'jornada',   1,    null, 'Jornada Hotline'),
  ('2026-12-08', 8,  'converter', 'teatro',    2,    'A',  'Teatro do Cliente · nível 2'),
  ('2026-12-09', 8,  'converter', 'teatro',    2,    'B',  'Teatro do Cliente · nível 2'),
  ('2026-12-10', 8,  'converter', 'teatro',    2,    'C',  'Teatro do Cliente · nível 2'),
  ('2026-12-16', 9,  'converter', 'detetives', 1,    null, 'Detetives do Atendimento'),
  ('2026-12-22', 10, 'evoluir',   'roda',      null, null, 'Roda 3'),
  ('2026-12-22', 10, 'evoluir',   'palco',     3,    null, 'Palco do Sim · nível 3 (solo)'),
  ('2027-01-06', 11, 'evoluir',   'detetives', 2,    null, 'Formato escolhido no dia 60 (sugestão: Detetives nível 2)'),
  ('2027-01-13', 12, 'evoluir',   'jornada',   3,    null, 'Jornada Hotline · veteranos como mestres'),
  ('2027-01-19', 13, 'evoluir',   'teatro',    3,    'A',  'A Revanche · Teatro nível 3'),
  ('2027-01-20', 13, 'evoluir',   'teatro',    3,    'B',  'A Revanche · Teatro nível 3'),
  ('2027-01-21', 13, 'evoluir',   'teatro',    3,    'C',  'A Revanche · Teatro nível 3'),
  ('2027-01-20', 13, 'evoluir',   'roda',      null, null, 'Roda 4 · encerramento')
) as v(data, semana, fase, formato_id, nivel, turma, titulo)
where not exists (select 1 from public.dev_encontros);

-- ------------------------------------------------------------------ helpers
-- texto com vírgula decimal -> numeric (vazio/inválido = null)
create or replace function public.dev_num(x text)
returns numeric language sql immutable set search_path = public as $$
  select case when nullif(replace(trim(x), ',', '.'), '') ~ '^-?[0-9]+(\.[0-9]+)?$'
              then replace(trim(x), ',', '.')::numeric end
$$;

-- vendedoras ativas do programa (nome_dash único; Pablo tem dois agent_id, vale o ativo)
create or replace function public.dev_vendedores_ativos()
returns table (vendedor text, agent_id bigint)
language sql stable security definer set search_path = public as $$
  select distinct on (v.nome_dash) v.nome_dash, v.agent_id
  from robo_fu_vendedoras v
  where v.ativo and v.nome_dash is not null and upper(v.nome_dash) <> 'KAYANE BASQUE'
  order by v.nome_dash, v.agent_id desc
$$;

-- médias das 6 competências (só presentes) de um conjunto de participações
create or replace function public.dev_medias(p_ids bigint[])
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'confianca',    round(avg(dev_num(notas->>'confianca'))    filter (where presente), 2),
    'calma_foco',   round(avg(dev_num(notas->>'calma_foco'))   filter (where presente), 2),
    'escuta',       round(avg(dev_num(notas->>'escuta'))       filter (where presente), 2),
    'clareza',      round(avg(dev_num(notas->>'clareza'))      filter (where presente), 2),
    'criatividade', round(avg(dev_num(notas->>'criatividade')) filter (where presente), 2),
    'iniciativa',   round(avg(dev_num(notas->>'iniciativa'))   filter (where presente), 2))
  from dev_participacoes where id = any(p_ids)
$$;

-- delta médio do Teatro (refaz - ida) nos 5 critérios de uma participação
create or replace function public.dev_delta_teatro(e jsonb)
returns numeric language sql immutable set search_path = public as $$
  select round(avg(dev_num(e->'refaz'->>k) - dev_num(e->'ida'->>k)), 2)
  from unnest(array['escutou','objecao_real','solucao','proximo_passo','postura']) k
  where dev_num(e->'refaz'->>k) is not null and dev_num(e->'ida'->>k) is not null
$$;

-- ------------------------------------------------------------------ leitura
create or replace function public.dashboard_dev_resumo()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  select jsonb_build_object(
    'formatos', coalesce((select jsonb_agg(to_jsonb(f) order by f.ordem) from dev_formatos f), '[]'::jsonb),
    'encontros', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'data', e.data, 'semana', e.semana, 'fase', e.fase, 'formato_id', e.formato_id,
        'formato_nome', f.nome, 'modo', f.modo, 'nivel', e.nivel, 'turma', e.turma, 'titulo', e.titulo,
        'status', e.status, 'condutor', e.condutor, 'anotador', e.anotador, 'observacao', e.observacao,
        'lancados', (select count(*) from dev_participacoes p where p.encontro_id = e.id),
        'presentes', (select count(*) from dev_participacoes p where p.encontro_id = e.id and p.presente),
        'medias', dev_medias(array(select p.id from dev_participacoes p where p.encontro_id = e.id))
      ) order by e.data, e.semana, e.turma nulls first, e.id)
      from dev_encontros e left join dev_formatos f on f.id = e.formato_id), '[]'::jsonb),
    'vendedores', coalesce((select jsonb_agg(jsonb_build_object('nome_dash', a.vendedor, 'agent_id', a.agent_id) order by a.vendedor)
                            from dev_vendedores_ativos() a), '[]'::jsonb),
    'marcos', coalesce((select jsonb_agg(to_jsonb(m) order by m.marco, m.vendedor nulls first, m.created_at desc) from dev_marcos m), '[]'::jsonb),
    'time', jsonb_build_object(
      'encontros_total', (select count(*) from dev_encontros where status <> 'cancelado'),
      'encontros_feitos', (select count(*) from dev_encontros where status = 'feito'),
      'presenca_pct', (select round(avg(case when p.presente then 1 else 0 end)::numeric, 4)
                         from dev_participacoes p join dev_encontros e on e.id = p.encontro_id
                        where e.status = 'feito'),
      'medias', dev_medias(array(select id from dev_participacoes)))
  ) into r;
  return r;
end $$;

create or replace function public.dashboard_dev_encontro(p_id bigint)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not exists (select 1 from dev_encontros where id = p_id) then
    return jsonb_build_object('ok', false, 'erro', 'encontro não encontrado');
  end if;
  select jsonb_build_object(
    'ok', true,
    'encontro', (select to_jsonb(e) || jsonb_build_object('formato_nome', f.nome, 'modo', f.modo, 'formato_descricao', f.descricao)
                   from dev_encontros e left join dev_formatos f on f.id = e.formato_id where e.id = p_id),
    'participacoes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'encontro_id', p_id, 'vendedor', v.vendedor, 'agent_id', coalesce(p.agent_id, v.agent_id),
        'presente', coalesce(p.presente, true), 'notas', coalesce(p.notas, '{}'::jsonb),
        'especificos', coalesce(p.especificos, '{}'::jsonb), 'observacao', p.observacao,
        'compromisso', p.compromisso, 'lancado_por', p.lancado_por, 'updated_at', p.updated_at,
        'salvo', p.id is not null
      ) order by v.vendedor)
      from (select a.vendedor, a.agent_id from dev_vendedores_ativos() a
            union
            select x.vendedor, x.agent_id from dev_participacoes x
             where x.encontro_id = p_id and x.vendedor not in (select vendedor from dev_vendedores_ativos())) v
      left join dev_participacoes p on p.encontro_id = p_id and p.vendedor = v.vendedor), '[]'::jsonb)
  ) into r;
  return r;
end $$;

create or replace function public.dashboard_dev_pessoa(p_vendedor text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  ids bigint[];
  r jsonb;
begin
  select array_agg(distinct agent_id) into ids from robo_fu_vendedoras where nome_dash = p_vendedor;
  select jsonb_build_object(
    'vendedor', p_vendedor,
    'agent_ids', coalesce(to_jsonb(ids), '[]'::jsonb),
    'serie', coalesce((
      select jsonb_agg(jsonb_build_object(
        'encontro_id', e.id, 'data', e.data, 'titulo', e.titulo, 'formato_id', e.formato_id, 'formato_nome', f.nome,
        'nivel', e.nivel, 'turma', e.turma, 'fase', e.fase, 'presente', p.presente, 'notas', p.notas,
        'especificos', p.especificos, 'delta_teatro', case when e.formato_id = 'teatro' then dev_delta_teatro(p.especificos) end
      ) order by e.data, e.id)
      from dev_participacoes p join dev_encontros e on e.id = p.encontro_id left join dev_formatos f on f.id = e.formato_id
      where p.vendedor = p_vendedor), '[]'::jsonb),
    'compromissos', coalesce((
      select jsonb_agg(jsonb_build_object('data', e.data, 'formato', f.nome, 'titulo', e.titulo, 'compromisso', p.compromisso)
                       order by e.data desc, e.id desc)
      from dev_participacoes p join dev_encontros e on e.id = p.encontro_id left join dev_formatos f on f.id = e.formato_id
      where p.vendedor = p_vendedor and nullif(trim(p.compromisso), '') is not null), '[]'::jsonb),
    'atendimento_semanal', coalesce((
      select jsonb_agg(to_jsonb(w) order by w.semana)
      from (
        select date_trunc('week', q.dia)::date as semana,
               count(*) as n,
               round(avg(q.pontuacao), 2) as nota_media,
               round(avg(case when dev_num(q.metricas->>'min_ate_primeira_resposta') <= 2 then 1.0 else 0.0 end)
                       filter (where dev_num(q.metricas->>'min_ate_primeira_resposta') is not null), 4) as pct_primeira_resposta_ate_2min,
               round((percentile_cont(0.5) within group (order by dev_num(q.metricas->>'tempo_medio_resposta_min')))::numeric, 1) as mediana_tempo_resposta,
               round(avg(dev_num(q.resultado->>'nota_cross_sell') / 1.5), 4) as pct_cross_sell,
               round(avg(dev_num(q.resultado->>'nota_agradecimento') / 1.0), 4) as pct_agradecimento,
               round(avg(dev_num(q.resultado->>'nota_informacoes') / 1.0), 4) as pct_informacoes
        from crm_qualidade q
        where q.avaliado = 'vendedora' and q.status = 'ok' and q.avaliado_id = any(ids) and q.dia >= date '2026-10-01'
        group by 1) w), '[]'::jsonb)
  ) into r;
  return r;
end $$;

create or replace function public.dashboard_dev_formatos()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', f.id, 'nome', f.nome, 'descricao', f.descricao, 'modo', f.modo,
    'encontros_total', (select count(*) from dev_encontros e where e.formato_id = f.id and e.status <> 'cancelado'),
    'encontros_feitos', (select count(*) from dev_encontros e where e.formato_id = f.id and e.status = 'feito'),
    'participacoes', (select count(*) from dev_participacoes p join dev_encontros e on e.id = p.encontro_id
                       where e.formato_id = f.id and p.presente),
    'medias', dev_medias(array(select p.id from dev_participacoes p join dev_encontros e on e.id = p.encontro_id where e.formato_id = f.id)),
    'delta_teatro', case when f.id = 'teatro' then (
        select round(avg(dev_delta_teatro(p.especificos)), 2)
        from dev_participacoes p join dev_encontros e on e.id = p.encontro_id
        where e.formato_id = 'teatro' and p.presente) end
  ) order by f.ordem), '[]'::jsonb)
  from dev_formatos f
$$;

-- ------------------------------------------------------------------ gravação
create or replace function public.dev_salvar_participacao(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_enc bigint := nullif(p->>'encontro_id', '')::bigint;
  v_vend text := nullif(trim(p->>'vendedor'), '');
  v_notas jsonb;
  v_row dev_participacoes;
begin
  if v_enc is null or v_vend is null then
    return jsonb_build_object('ok', false, 'erro', 'informe encontro_id e vendedor');
  end if;
  if not exists (select 1 from dev_encontros where id = v_enc) then
    return jsonb_build_object('ok', false, 'erro', 'encontro não encontrado');
  end if;
  -- notas: só as 6 competências, inteiros de 1 a 5
  if p ? 'notas' then
    select coalesce(jsonb_object_agg(k, (val)::int), '{}'::jsonb) into v_notas
    from (select key k, dev_num(value #>> '{}') val from jsonb_each(coalesce(p->'notas', '{}'::jsonb))) x
    where k in ('confianca','calma_foco','escuta','clareza','criatividade','iniciativa') and val between 1 and 5;
  end if;

  insert into dev_participacoes as t (encontro_id, vendedor, agent_id, presente, notas, especificos, observacao, compromisso, lancado_por, updated_at)
  values (v_enc, v_vend,
          coalesce(nullif(p->>'agent_id', '')::bigint, (select agent_id from dev_vendedores_ativos() where vendedor = v_vend)),
          coalesce((p->>'presente')::boolean, true),
          coalesce(v_notas, '{}'::jsonb),
          coalesce(case when jsonb_typeof(p->'especificos') = 'object' then p->'especificos' end, '{}'::jsonb),
          nullif(p->>'observacao', ''), nullif(p->>'compromisso', ''), nullif(p->>'lancado_por', ''), now())
  on conflict (encontro_id, vendedor) do update set
    agent_id    = coalesce(excluded.agent_id, t.agent_id),
    presente    = case when p ? 'presente' then excluded.presente else t.presente end,
    notas       = case when p ? 'notas' then excluded.notas else t.notas end,
    especificos = case when p ? 'especificos' then excluded.especificos else t.especificos end,
    observacao  = case when p ? 'observacao' then excluded.observacao else t.observacao end,
    compromisso = case when p ? 'compromisso' then excluded.compromisso else t.compromisso end,
    lancado_por = coalesce(excluded.lancado_por, t.lancado_por),
    updated_at  = now()
  returning * into v_row;
  return jsonb_build_object('ok', true, 'participacao', to_jsonb(v_row));
end $$;

create or replace function public.dev_salvar_encontro(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_id bigint := nullif(p->>'id', '')::bigint;
  v_row dev_encontros;
begin
  if v_id is not null then
    update dev_encontros e set
      status     = case when p ? 'status' then coalesce(nullif(p->>'status', ''), e.status) else e.status end,
      condutor   = case when p ? 'condutor' then nullif(p->>'condutor', '') else e.condutor end,
      anotador   = case when p ? 'anotador' then nullif(p->>'anotador', '') else e.anotador end,
      observacao = case when p ? 'observacao' then nullif(p->>'observacao', '') else e.observacao end,
      data       = case when p ? 'data' and nullif(p->>'data', '') is not null then (p->>'data')::date else e.data end,
      titulo     = case when p ? 'titulo' and nullif(p->>'titulo', '') is not null then p->>'titulo' else e.titulo end
    where e.id = v_id
    returning * into v_row;
    if v_row.id is null then
      return jsonb_build_object('ok', false, 'erro', 'encontro não encontrado');
    end if;
  else
    if nullif(p->>'data', '') is null then
      return jsonb_build_object('ok', false, 'erro', 'informe a data');
    end if;
    insert into dev_encontros (data, semana, fase, formato_id, nivel, turma, titulo, status, condutor, anotador, observacao)
    values ((p->>'data')::date, nullif(p->>'semana', '')::int, nullif(p->>'fase', ''), nullif(p->>'formato_id', ''),
            nullif(p->>'nivel', '')::int, nullif(p->>'turma', ''), nullif(p->>'titulo', ''),
            coalesce(nullif(p->>'status', ''), 'planejado'), nullif(p->>'condutor', ''), nullif(p->>'anotador', ''),
            nullif(p->>'observacao', ''))
    returning * into v_row;
  end if;
  return jsonb_build_object('ok', true, 'encontro', to_jsonb(v_row));
end $$;

create or replace function public.dev_salvar_marco(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_id bigint := nullif(p->>'id', '')::bigint;
  v_marco text := upper(nullif(p->>'marco', ''));
  v_row dev_marcos;
begin
  if v_id is not null then
    update dev_marcos m set
      resumo   = case when p ? 'resumo' then nullif(p->>'resumo', '') else m.resumo end,
      decisoes = case when p ? 'decisoes' then nullif(p->>'decisoes', '') else m.decisoes end,
      vendedor = case when p ? 'vendedor' then nullif(p->>'vendedor', '') else m.vendedor end,
      data     = case when p ? 'data' and nullif(p->>'data', '') is not null then (p->>'data')::date else m.data end
    where m.id = v_id
    returning * into v_row;
    if v_row.id is null then
      return jsonb_build_object('ok', false, 'erro', 'marco não encontrado');
    end if;
  else
    if v_marco is null or v_marco not in ('D30', 'D60', 'D90') then
      return jsonb_build_object('ok', false, 'erro', 'marco deve ser D30, D60 ou D90');
    end if;
    insert into dev_marcos (marco, data, vendedor, resumo, decisoes)
    values (v_marco,
            coalesce(nullif(p->>'data', '')::date,
                     case v_marco when 'D30' then date '2026-11-18' when 'D60' then date '2026-12-18' else date '2027-01-22' end),
            nullif(p->>'vendedor', ''), nullif(p->>'resumo', ''), nullif(p->>'decisoes', ''))
    returning * into v_row;
  end if;
  return jsonb_build_object('ok', true, 'marco', to_jsonb(v_row));
end $$;

-- só a API (conexão direta pelo pg) chama; nada exposto ao PostgREST anônimo
revoke all on function public.dev_vendedores_ativos() from public, anon, authenticated;
revoke all on function public.dev_medias(bigint[]) from public, anon, authenticated;
revoke all on function public.dashboard_dev_resumo() from public, anon, authenticated;
revoke all on function public.dashboard_dev_encontro(bigint) from public, anon, authenticated;
revoke all on function public.dashboard_dev_pessoa(text) from public, anon, authenticated;
revoke all on function public.dashboard_dev_formatos() from public, anon, authenticated;
revoke all on function public.dev_salvar_participacao(jsonb) from public, anon, authenticated;
revoke all on function public.dev_salvar_encontro(jsonb) from public, anon, authenticated;
revoke all on function public.dev_salvar_marco(jsonb) from public, anon, authenticated;
