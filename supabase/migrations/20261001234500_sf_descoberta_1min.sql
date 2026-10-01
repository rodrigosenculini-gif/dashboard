-- Sempre Facil: descoberta de propostas a cada 1 min (era 5). A API so lista as
-- 20 mais novas; em pico entram mais de 20 em 5 min e as que ficam de fora nunca
-- sao acompanhadas -- 167 propostas Integradas (R$ 379 mil) nao viraram venda
-- em set/26 e foram lancadas a partir do portal em 01/10.
do $$
declare d text; novo text;
begin
  d := pg_get_functiondef('public.sf_sync_tick'::regproc);
  novo := replace(d,
    $a$  -- descoberta: 1a pagina (mais novas) a cada 5 min
  if e.ultima_descoberta is null or now() - e.ultima_descoberta > interval '5 minutes' then$a$,
    $b$  -- descoberta: 1a pagina (mais novas) a cada 1 min (01/10: 5 min perdia propostas no pico)
  if e.ultima_descoberta is null or now() - e.ultima_descoberta > interval '1 minute' then$b$);
  if novo = d then raise exception 'trecho da descoberta nao encontrado em sf_sync_tick'; end if;
  execute novo;
end $$;
