-- leads_chatwoot.atualiza_interacao chamava o n8n em /webhook/supa, que nao existe
-- mais (404 varias vezes por minuto). Desativado, nao removido (02/10).
alter table public.leads_chatwoot disable trigger atualiza_interacao;
