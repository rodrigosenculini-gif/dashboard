-- Aba "Feitos" do painel de lembretes: as listas normais so trazem as tarefas
-- concluidas HOJE (dashboard_tarefas_gestao/_pendentes), entao as de ontem
-- sumiam. Esta devolve as concluidas antes de hoje, mais recentes primeiro.
-- p_vendedor nulo = todas (gestao).
create or replace function public.dashboard_tarefas_feitas(p_vendedor text default null, p_dias integer default 30)
returns table(id bigint, vendedor text, titulo text, lembrar_em timestamp with time zone,
              vencida boolean, adiado_vezes integer, feita boolean, concluido_em timestamp with time zone)
language sql stable security definer
set search_path to 'public'
as $function$
  select t.id, t.vendedor, t.titulo, t.lembrar_em, false, t.adiado_vezes, true, t.concluido_em
  from tarefas_lembrete t
  where (p_vendedor is null or t.vendedor = p_vendedor)
    and t.concluido_em is not null
    and t.concluido_em < hoje_sp()::timestamp at time zone 'America/Sao_Paulo'
    and t.concluido_em >= (hoje_sp() - greatest(coalesce(p_dias, 30), 1))::timestamp at time zone 'America/Sao_Paulo'
  order by t.concluido_em desc
  limit 300;
$function$;
