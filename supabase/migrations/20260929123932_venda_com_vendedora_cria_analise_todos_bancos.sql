CREATE OR REPLACE FUNCTION public.trg_c6_venda_para_vendedoras_analise()
 RETURNS trigger LANGUAGE plpgsql AS $function$
declare v_banco text;
begin
  -- 29/09: vale para todos os bancos (antes so C6). Venda com vendedora sem analise
  -- nao aparecia na tela da vendedora.
  if nullif(btrim(coalesce(new.vendedor,'')),'') is null or not cpf_valido(new.cpf)
     or (new.adesao is null and new.proposal_id_raw is null) then
    return new;
  end if;
  if exists (select 1 from vendedoras_analise v
              where (new.proposal_id_raw is not null and v.proposal_id_raw = new.proposal_id_raw)
                 or (norm_cpf(v.cpf) = norm_cpf(new.cpf) and v.adesao = new.adesao)) then
    return new;
  end if;
  v_banco := case normalizar_banco(new.banco) when 'PRESENCA' then 'PRESENÇA' else normalizar_banco(new.banco) end;
  insert into vendedoras_analise (data_status, banco, vendedor, cpf, nome, valor, tabela, adesao, parcelas, data_pagamento, proposal_id_raw)
  values (coalesce(new.data, hoje_sp()), v_banco, new.vendedor, norm_cpf(new.cpf), new.nome, new.valor, new.tabela, new.adesao, new.parcelas, new.data, new.proposal_id_raw);
  return new;
exception when others then
  insert into triggers_falhas_log (gatilho, tabela, registro_id, erro, detalhe)
  values ('trg_c6_venda_para_vendedoras_analise', TG_TABLE_NAME, new.id, SQLERRM, SQLSTATE);
  return new;
end $function$;

drop trigger if exists c6_venda_para_vendedoras_analise on public.vendas_gerais;
create trigger venda_para_vendedoras_analise after insert or update of vendedor on public.vendas_gerais
for each row execute function public.trg_c6_venda_para_vendedoras_analise();
