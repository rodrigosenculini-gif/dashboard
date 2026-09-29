-- Quem recebe o lembrete: null = toda a equipe; lista = so essas vendedoras.
-- A gestao configura os lembretes e nao responde a eles.
alter table notificacoes_regras add column if not exists aplica_a text[];

create or replace function public.dashboard_notificacao_pendente(
  p_vendedor text, p_escopo text default 'vendedora')
returns table(id bigint, regra_id bigint, mensagem text)
language plpgsql stable security definer set search_path to 'public' as $function$
declare v_agora timestamptz := now();
        v_local timestamp := (now() at time zone 'America/Sao_Paulo');
begin
  if coalesce(p_escopo,'vendedora') = 'gestao' then return; end if;

  return query
  with candidata as (
    select r.*,
      (select nr.mostrado_em from notificacoes_respostas nr
        where nr.regra_id = r.id and nr.vendedor = p_vendedor
        order by nr.mostrado_em desc limit 1) as ultima_vez,
      (select nr.resposta from notificacoes_respostas nr
        where nr.regra_id = r.id and nr.vendedor = p_vendedor
        order by nr.mostrado_em desc limit 1) as ultima_resposta
    from notificacoes_regras r
    where r.ativo
      and r.escopo <> 'gestao'
      and (r.aplica_a is null or p_vendedor = any(r.aplica_a))
      and v_local::time between r.hora_ini and r.hora_fim
      and extract(isodow from v_local)::int = any(r.dias_semana)
  )
  select null::bigint, c.id, c.mensagem
  from candidata c
  where c.ultima_vez is null
     or v_agora >= c.ultima_vez + make_interval(mins =>
          case when c.ultima_resposta = 'nao' then c.reforco_min else c.intervalo_min end)
  order by c.ultima_vez nulls first
  limit 1;
end $function$;

create function public.dashboard_regras_listar()
returns table(id bigint, mensagem text, intervalo_min integer, reforco_min integer,
              hora_ini time, hora_fim time, escopo text, ativo boolean,
              aplica_a text[], alvo text)
language sql stable security definer set search_path to 'public' as $function$
  select r.id, r.mensagem, r.intervalo_min, r.reforco_min, r.hora_ini, r.hora_fim,
         r.escopo, r.ativo, r.aplica_a,
         case when r.aplica_a is null or cardinality(r.aplica_a) = 0 then 'toda a equipe'
              else array_to_string(r.aplica_a, ', ') end
  from notificacoes_regras r
  where r.escopo <> 'gestao'
  order by r.ativo desc, r.id;
$function$;

create or replace function public.dashboard_regra_salvar(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $function$
declare v_id bigint; v_alvo text[];
begin
  if p ? 'aplica_a' then
    select nullif(array_agg(x), '{}') into v_alvo
    from jsonb_array_elements_text(coalesce(p->'aplica_a','[]'::jsonb)) x
    where btrim(x) <> '';
  end if;

  if (p->>'id') is not null and (p->>'id') <> '' then
    update notificacoes_regras set
      mensagem      = coalesce(nullif(btrim(p->>'mensagem'),''), mensagem),
      intervalo_min = coalesce((p->>'intervalo_min')::int, intervalo_min),
      reforco_min   = coalesce((p->>'reforco_min')::int, reforco_min),
      hora_ini      = coalesce((p->>'hora_ini')::time, hora_ini),
      hora_fim      = coalesce((p->>'hora_fim')::time, hora_fim),
      ativo         = coalesce((p->>'ativo')::boolean, ativo),
      aplica_a      = case when p ? 'aplica_a' then v_alvo else aplica_a end
    where id = (p->>'id')::bigint returning id into v_id;
  else
    if coalesce(btrim(p->>'mensagem'),'') = '' then
      return jsonb_build_object('ok', false, 'erro', 'informe a mensagem');
    end if;
    insert into notificacoes_regras
      (mensagem, intervalo_min, reforco_min, hora_ini, hora_fim, escopo, aplica_a)
    values (btrim(p->>'mensagem'),
            coalesce((p->>'intervalo_min')::int, 10),
            coalesce((p->>'reforco_min')::int, 5),
            coalesce((p->>'hora_ini')::time, '08:00'),
            coalesce((p->>'hora_fim')::time, '18:00'),
            'vendedora', v_alvo)
    returning id into v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $function$;
