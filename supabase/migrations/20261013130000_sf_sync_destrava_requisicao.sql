-- 13/10: a sincronizacao do Sempre Facil ficou parada 24h: a requisicao 12247606 ficou pendente
-- e a resposta nunca apareceu em net._http_response (pg_net descarta respostas antigas), e o tick
-- esperava para sempre. Agora cada requisicao guarda a hora (req_em) e, sem resposta em 2 min,
-- e descartada e o ciclo segue. (Funcao completa aplicada no banco em 13/10 via apply_migration
-- sf_sync_destrava_requisicao; a diferenca para 20261002120000_sf_varredura_por_codigo.sql e so o
-- bloco "if not found" e o req_em = now() nas tres requisicoes.)
alter table public.sf_sync_estado add column if not exists req_em timestamptz;
