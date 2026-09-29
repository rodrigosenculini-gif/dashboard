-- =====================================================================
-- Itens aplicados no Supabase (projeto mvzqywdmhdylsuclrqrg) que NAO
-- ficaram registrados como migration. Rodar so ao recriar o ambiente.
-- Conferencia de vendas / Sempre Facil API - 29/09/2026
-- =====================================================================

-- 1) Chave da API Sempre Facil (JoinBank, provider 321 Bank 950703)
--    NAO versionar a chave. Criar manualmente, substituindo <CHAVE>:
-- select vault.create_secret('<CHAVE>', 'sempre_facil_apikey', 'JoinBank / Sempre Facil - provider 321 Bank 950703');

-- 2) Agendamentos (pg_cron)
select cron.unschedule('sf_sync_api') where exists (select 1 from cron.job where jobname = 'sf_sync_api');
select cron.schedule('sf_sync_api', '20 seconds', 'select public.sf_sync_tick()');
-- sf-remove-canceladas (02:35) ja esta na migration sf_canceladas_enriquecimento_status
-- remove-vendas-canceladas (02:30) e anteriores ja existiam

-- 3) Estado inicial da sincronizacao Sempre Facil (modo rotina)
update public.sf_sync_estado set req_id = null, modo = 'rotina', pausa_ate = null where id = 1;

-- 4) Correcoes de DADOS feitas nesta sessao (nao repetir; ficam os backups):
--    backup_vendas_removidas_2809     -> 21 C6 lancadas em "ANALISE CREDITO"
--    backup_vendas_duplicadas_2809    -> duplicatas SF/Facta/v8/Soma removidas (com mantida_id)
--    backup_analises_removidas_2809   -> analises duplicadas/canceladas removidas
--    backup_soma_2809                 -> Soma antes da conferencia com o relatorio
--    vendas_canceladas_removidas_log  -> removidas pela rotina (inclui 16 restauradas em 29/09)
--    map_soma_sem_ident_2909, conf_soma_2809, rel_soma_2809 -> apoio da conferencia Soma
