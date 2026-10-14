-- 14/10: venda CLT do Novo Saque cadastrada com nome de tabela do FGTS (TABELA NS, SMART...) pegava o peso do
-- FGTS (12,0 em vez de 0,7: venda 19379 valia 16.111 pontos). CLT no Novo Saque tem prazo > 5 parcelas; o nome
-- vira "Novo Saque" e o peso sai certo.
create or replace function public.trg_ns_clt_tabela()
 returns trigger language plpgsql
as $function$
begin
  if normalizar_banco(new.banco) = 'NOVO SAQUE' and coalesce(new.parcelas, 0) > 5
     and upper(coalesce(new.tabela,'')) ~ '(^|[^A-Z])(TABELA )?(NS|CAMPANHA|DIAMANTE|GOLD|MONEY|LIGHT|SOFT|SMART|ZERO)([^A-Z]|$)' then
    new.tabela := 'Novo Saque';
  end if;
  return new;
end $function$;
drop trigger if exists a0_ns_clt_tabela on public.vendas_gerais;
create trigger a0_ns_clt_tabela before insert or update of tabela, parcelas on public.vendas_gerais
  for each row execute function public.trg_ns_clt_tabela();
