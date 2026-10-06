-- Chips: recarga padrao passa de 30 para 60 dias (06/10). Vale para chip novo
-- (default da coluna), para o salvar sem intervalo e para "marcar como
-- recarregado" em chip sem intervalo.
-- Dados do dia (sem migracao): 18 numeros da lista do usuario com recarga hoje
-- e 60 dias; os demais que estavam em "recarregar" foram desativados do alerta.
alter table public.chips alter column intervalo_dias set default 60;
do $$
declare d text; novo text;
begin
  d := pg_get_functiondef('public.dashboard_chips_salvar(jsonb)'::regprocedure);
  novo := replace(d, $a$coalesce(nullif(p->>'intervalo_dias','')::int, 30)$a$, $a$coalesce(nullif(p->>'intervalo_dias','')::int, 60)$a$);
  if novo = d then raise exception 'padrao 30 nao encontrado em dashboard_chips_salvar'; end if;
  execute novo;
  d := pg_get_functiondef('public.dashboard_chips_recarregar(bigint[],date,numeric,text)'::regprocedure);
  novo := replace(d, $a$coalesce(c.intervalo_dias, 30)$a$, $a$coalesce(c.intervalo_dias, 60)$a$);
  if novo = d then raise exception 'padrao 30 nao encontrado em dashboard_chips_recarregar'; end if;
  execute novo;
end $$;
