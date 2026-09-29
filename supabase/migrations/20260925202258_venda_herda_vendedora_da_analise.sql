create index if not exists vendedoras_analise_proposal_id_raw_idx on public.vendedoras_analise (proposal_id_raw) where proposal_id_raw is not null;

create or replace function public.trg_venda_herda_vendedora_analise()
returns trigger language plpgsql as $function$
declare v_vend text; v_qtd int := 0;
begin
  -- nunca sobrescreve quem ja tem dono
  if nullif(btrim(new.vendedor), '') is not null then return new; end if;

  -- 1) UUID da proposta (identificacao exata)
  if new.proposal_id_raw is not null then
    select min(va.vendedor), count(distinct va.vendedor) into v_vend, v_qtd
      from vendedoras_analise va
     where va.proposal_id_raw = new.proposal_id_raw
       and nullif(btrim(va.vendedor), '') is not null;
  end if;

  -- 2) CPF + adesao (consulta separada para usar o indice unico)
  if v_qtd = 0 and new.cpf is not null and new.adesao is not null then
    select min(va.vendedor), count(distinct va.vendedor) into v_vend, v_qtd
      from vendedoras_analise va
     where va.cpf = norm_cpf(new.cpf)
       and va.adesao = new.adesao
       and nullif(btrim(va.vendedor), '') is not null;
  end if;

  -- so atribui quando ha uma vendedora so; ambiguidade fica para decisao manual
  if v_qtd = 1 then new.vendedor := v_vend; end if;
  return new;
exception when others then
  insert into triggers_falhas_log (gatilho, tabela, registro_id, erro, detalhe)
  values ('trg_venda_herda_vendedora_analise', TG_TABLE_NAME, new.id, SQLERRM, SQLSTATE);
  return new;
end $function$;

-- nome "c5_" para rodar antes do c6_venda_herda_vendedora (ordem alfabetica)
drop trigger if exists c5_venda_herda_vendedora_analise on public.vendas_gerais;
create trigger c5_venda_herda_vendedora_analise
before insert or update of cpf, adesao, proposal_id_raw on public.vendas_gerais
for each row execute function public.trg_venda_herda_vendedora_analise();
