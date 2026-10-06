-- Chips inativos ficam num filtro da tela (06/10). "Remover" ja so marcava
-- ativo=false, mas o chip sumia sem volta pela tela; agora o filtro "Inativos"
-- lista esses numeros e cada um tem "Reativar". O resumo ganha a contagem.
drop function if exists public.dashboard_chips_listar(text, text, text, boolean);
create or replace function public.dashboard_chips_listar(p_busca text default null, p_status text default null, p_plataforma text default null, p_so_recarga boolean default false, p_inativos boolean default false)
 returns jsonb language sql stable security definer set search_path to 'public'
as $function$
  with hoje as (select (now() at time zone 'America/Sao_Paulo')::date as d),
  f as (
    select c.*,
      (c.proxima_recarga - (select d from hoje)) as dias_para_recarga
    from chips c
    where c.ativo = not p_inativos
      and (p_busca is null or p_busca = ''
           or c.telefone ilike '%'||p_busca||'%'
           or coalesce(c.responsavel,'') ilike '%'||p_busca||'%'
           or coalesce(c.instancia,'')   ilike '%'||p_busca||'%'
           or coalesce(c.observacao,'')  ilike '%'||p_busca||'%')
      and (p_status is null or p_status = '' or c.status = any(string_to_array(p_status, ',')))
      and (p_plataforma is null or p_plataforma = '' or c.plataforma = any(string_to_array(p_plataforma, ',')))
      and (not p_so_recarga or (c.recarregar and c.proxima_recarga is not null
           and c.proxima_recarga <= (select d from hoje) + 7))
  )
  select jsonb_build_object(
    'hoje', (select d from hoje),
    'inativos_filtro', p_inativos,
    'resumo', (
      select jsonb_build_object(
        'total',        count(*) filter (where ativo),
        'inativos',     count(*) filter (where not ativo),
        'conectados',   count(*) filter (where ativo and status = 'CONECTADO'),
        'desconectados',count(*) filter (where ativo and status = 'DESCONECTADO'),
        'banidos',      count(*) filter (where ativo and status = 'BANIDO'),
        'vencidos',     count(*) filter (where ativo and recarregar and proxima_recarga is not null and proxima_recarga < (select d from hoje)),
        'vence_7d',     count(*) filter (where ativo and recarregar and proxima_recarga is not null
                                          and proxima_recarga between (select d from hoje) and (select d from hoje) + 7)
      ) from chips
    ),
    'por_instancia', coalesce((
      select jsonb_agg(x order by x.qtd desc) from (
        select coalesce(nullif(instancia,''),'— sem instância —') as instancia,
               count(*) as qtd,
               count(*) filter (where status = 'CONECTADO') as conectados
        from chips where ativo group by 1
      ) x
    ), '[]'::jsonb),
    'por_plataforma', coalesce((
      select jsonb_agg(x order by x.qtd desc) from (
        select coalesce(nullif(plataforma,''),'— sem plataforma —') as plataforma, count(*) as qtd
        from chips where ativo group by 1
      ) x
    ), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(f) order by
               (f.recarregar and f.proxima_recarga is not null and f.proxima_recarga < (select d from hoje)) desc,
               f.proxima_recarga asc nulls last, f.telefone)
      from f
    ), '[]'::jsonb)
  );
$function$;

create or replace function public.dashboard_chips_reativar(p_id bigint)
 returns jsonb language sql security definer set search_path to 'public'
as $function$
  with u as (update chips set ativo = true where id = p_id returning 1)
  select jsonb_build_object('ok', (select count(*) from u) > 0);
$function$;
revoke all on function public.dashboard_chips_reativar(bigint) from public, anon;
