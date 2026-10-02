-- C6: algumas vendas chegam com a tabela sem o codigo ("Trabalhador ESP Seg Plan 6"
-- em vez de "800168 - Trabalhador ESP Seg Plan 6"). O peso sai igual, mas a
-- nomenclatura fica dupla nos relatorios. Completa o codigo pelo nome ja usado em
-- outra venda C6 (conferencia do relatorio C6 em 02/10: 14 vendas).
create or replace function public.trg_c6_tabela_codigo()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare v_cod text;
begin
  if normalizar_banco(new.banco) = 'C6' and coalesce(new.tabela, '') <> '' and new.tabela !~ '^\d+ - ' then
    select split_part(v.tabela, ' - ', 1) into v_cod
      from vendas_gerais v
     where normalizar_banco(v.banco) = 'C6'
       and v.tabela ~ '^\d+ - '
       and substr(v.tabela, strpos(v.tabela, ' - ') + 3) = new.tabela
     order by v.id desc limit 1;
    if v_cod is not null then new.tabela := v_cod || ' - ' || new.tabela; end if;
  end if;
  return new;
end $function$;

drop trigger if exists a0_c6_tabela_codigo on public.vendas_gerais;
create trigger a0_c6_tabela_codigo before insert or update of tabela, banco on public.vendas_gerais
  for each row execute function trg_c6_tabela_codigo();

update vendas_gerais set tabela = tabela
 where normalizar_banco(banco) = 'C6' and tabela !~ '^\d+ - ' and data >= '2026-09-01';
