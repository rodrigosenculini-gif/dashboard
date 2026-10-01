-- dashboard_vendas_sync (botao de sincronizar da tela de Vendas) passo 1d:
-- dava a toda venda sem vendedora a ULTIMA vendedora que ja atendeu aquele CPF,
-- em qualquer epoca. Cliente que comprou com uma vendedora e depois fechou
-- outra proposta sozinho virava venda dela -- e o gatilho
-- venda_para_vendedoras_analise criava a analise sem ela ter cadastrado
-- (49 analises em set/out, ultima em 01/10). A ligacao venda->vendedora fica
-- so pelos caminhos exatos (codigo da proposta ou CPF + adesao:
-- c5_venda_herda_vendedora_analise) e pelo cadastro da propria vendedora.
do $$
declare d text; novo text;
begin
  d := pg_get_functiondef('public.dashboard_vendas_sync'::regproc);
  novo := regexp_replace(d, '-- 1d\) NOVO:.*?AND v\.vendedor IS NULL;',
    '-- 1d) removido 01/10: atribuia vendedora so pelo CPF (venda de outra epoca)', '');
  if novo = d then raise exception 'passo 1d nao encontrado em dashboard_vendas_sync'; end if;
  execute novo;
end $$;
