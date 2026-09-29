-- v8: vendedora digita a ADE com o prefixo 373 da bancarizadora (37311148933);
-- VendeAI e relatorio trazem so o nucleo (11148933). Grava sempre o nucleo.
create or replace function public.trg_v8_adesao_nucleo()
returns trigger language plpgsql as $function$
begin
  if normalizar_banco(new.banco) = 'V8' and new.adesao is not null and new.adesao::text ~ '^373\d{8}$' then
    new.adesao := substr(new.adesao::text, 4)::bigint;
  end if;
  return new;
end $function$;

drop trigger if exists a0_v8_adesao_nucleo on public.vendas_gerais;
create trigger a0_v8_adesao_nucleo before insert or update of adesao, banco on public.vendas_gerais
for each row execute function public.trg_v8_adesao_nucleo();

drop trigger if exists a0_v8_adesao_nucleo on public.vendedoras_analise;
create trigger a0_v8_adesao_nucleo before insert or update of adesao, banco on public.vendedoras_analise
for each row execute function public.trg_v8_adesao_nucleo();
