-- Conferencia 07/10: 48 analises tinham sido criadas pelo sistema (lote de 29 e 30/09),
-- sem a vendedora cadastrar: a venda recebeu vendedora pela regra antiga do sync (removida
-- em 01/10) e o gatilho venda_para_vendedoras_analise gerou a analise. Removidas com backup
-- (backup_va_lote_0710 / backup_vg_lote_0710) e log em vendas_canceladas_removidas_log.
--  1) vendedoras_analise.origem: quem criou a linha ("vendedora" = Adicionar venda;
--     "gatilho venda" = veio de venda com vendedora; "sistema" = outra funcao). Daqui em
--     diante essa pergunta se responde com uma consulta.
--  2) o gatilho que cria analise a partir de venda com vendedora fica desligado: hoje a unica
--     fonte legitima de vendedora e o cadastro da propria vendedora.
alter table public.vendedoras_analise add column if not exists origem text;
comment on column public.vendedoras_analise.origem is 'quem criou a linha: vendedora (Adicionar venda), gatilho venda, sistema (outra funcao). Nulo = anterior a 07/10/2026';

create or replace function public.trg_analise_origem()
 returns trigger language plpgsql
as $function$
begin
  if new.origem is null then
    new.origem := case when pg_trigger_depth() > 1 then 'gatilho venda' else 'sistema' end;
  end if;
  return new;
end $function$;
drop trigger if exists a00_analise_origem on public.vendedoras_analise;
create trigger a00_analise_origem before insert on public.vendedoras_analise
  for each row execute function public.trg_analise_origem();

do $$
declare d text; novo text;
begin
  d := pg_get_functiondef('public.dashboard_vendedoras_add_venda(text,bigint,text,text,numeric,text,text,date,integer,text,text)'::regprocedure);
  novo := replace(d,
    $a$insert into vendedoras_analise (data_status, banco, adesao, cpf, nome, vendedor, valor, tabela, data_pagamento, parcelas, seguro, proposal_id_raw)
  values (v_data, p_banco, v_adesao, v_cpf, p_nome, p_vendedor, p_valor, p_tabela, v_data, p_parcelas, p_seguro, v_raw);$a$,
    $a$insert into vendedoras_analise (data_status, banco, adesao, cpf, nome, vendedor, valor, tabela, data_pagamento, parcelas, seguro, proposal_id_raw, origem)
  values (v_data, p_banco, v_adesao, v_cpf, p_nome, p_vendedor, p_valor, p_tabela, v_data, p_parcelas, p_seguro, v_raw, 'vendedora');$a$);
  if novo = d then raise exception 'insert nao encontrado em dashboard_vendedoras_add_venda'; end if;
  execute novo;
end $$;

alter table public.vendas_gerais disable trigger venda_para_vendedoras_analise;
