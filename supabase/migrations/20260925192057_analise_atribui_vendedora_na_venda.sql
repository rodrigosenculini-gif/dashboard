-- A analise nasce herdando os dados da venda, mas a VENDA ficava sem o nome
-- de quem lancou: 42 vendas e 142 mil pontos nao entravam para ninguem,
-- embora o peso e o ponto estivessem certos. Os relatorios somam por
-- vendas_gerais.vendedor, entao a vendedora via menos do que fez.
-- Agora, ao criar ou atualizar a analise, o nome vai para a venda.
create or replace function public.trg_analise_marca_vendedora()
returns trigger language plpgsql as $function$
begin
  if new.vendedor is null or btrim(new.vendedor) = '' then return new; end if;

  update vendas_gerais vg
  set vendedor = new.vendedor
  where norm_cpf(vg.cpf) = norm_cpf(new.cpf)
    and coalesce(vg.adesao,-1) = coalesce(new.adesao,-1)
    and vg.vendedor is null;          -- nunca sobrescreve quem ja tem dono

  return new;
exception when others then
  insert into triggers_falhas_log (gatilho, tabela, registro_id, erro, detalhe)
  values ('trg_analise_marca_vendedora', TG_TABLE_NAME, new.id, SQLERRM, SQLSTATE);
  return new;
end $function$;

drop trigger if exists analise_marca_vendedora on vendedoras_analise;
create trigger analise_marca_vendedora
  after insert or update of vendedor, cpf, adesao on vendedoras_analise
  for each row execute function trg_analise_marca_vendedora();
