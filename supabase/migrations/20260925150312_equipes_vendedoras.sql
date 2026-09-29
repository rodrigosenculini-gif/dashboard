-- Equipes nomeadas: em vez de marcar uma a uma toda vez, a gestao monta o
-- grupo ("Manha", "CLT", "Novatas") e aponta o lembrete pra ele. A selecao
-- individual continua existindo, como complemento.
create table if not exists equipes (
  id bigserial primary key,
  nome text not null unique,
  membros text[] not null default '{}',
  criado_em timestamptz default now()
);

-- a regra pode apontar para equipes, para vendedoras, ou para nada (= todas)
alter table notificacoes_regras add column if not exists equipes bigint[];

create or replace function public.dashboard_equipes_listar()
returns table(id bigint, nome text, membros text[], qtd integer)
language sql stable security definer set search_path to 'public' as $function$
  select e.id, e.nome, e.membros, coalesce(cardinality(e.membros),0)
  from equipes e order by e.nome;
$function$;

create or replace function public.dashboard_equipe_salvar(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $function$
declare v_id bigint; v_membros text[];
begin
  if coalesce(btrim(p->>'nome'),'') = '' then
    return jsonb_build_object('ok', false, 'erro', 'informe o nome da equipe');
  end if;
  select coalesce(array_agg(x), '{}') into v_membros
  from jsonb_array_elements_text(coalesce(p->'membros','[]'::jsonb)) x where btrim(x) <> '';

  if (p->>'id') is not null and (p->>'id') <> '' then
    update equipes set nome = btrim(p->>'nome'), membros = v_membros
    where id = (p->>'id')::bigint returning id into v_id;
  else
    insert into equipes (nome, membros) values (btrim(p->>'nome'), v_membros)
    on conflict (nome) do update set membros = excluded.membros
    returning id into v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $function$;

create or replace function public.dashboard_equipe_excluir(p_id bigint)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $function$
begin
  -- tira a equipe das regras que apontavam pra ela
  update notificacoes_regras set equipes = array_remove(equipes, p_id)
  where equipes @> array[p_id];
  delete from equipes where id = p_id;
  return jsonb_build_object('ok', found);
end $function$;

-- quem recebe: uniao dos membros das equipes + as vendedoras avulsas
create or replace function public.regra_alcanca(p_regra notificacoes_regras, p_vendedor text)
returns boolean language sql stable as $function$
  select case
    -- sem equipe e sem lista: toda a equipe de vendas
    when (p_regra.equipes is null or cardinality(p_regra.equipes) = 0)
     and (p_regra.aplica_a is null or cardinality(p_regra.aplica_a) = 0) then true
    -- na lista individual
    when p_regra.aplica_a is not null and p_vendedor = any(p_regra.aplica_a) then true
    -- em alguma das equipes
    when p_regra.equipes is not null and exists (
      select 1 from equipes e
      where e.id = any(p_regra.equipes) and p_vendedor = any(e.membros)
    ) then true
    else false end;
$function$;
