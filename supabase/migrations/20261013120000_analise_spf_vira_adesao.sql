-- 13/10: analise do Sempre Facil cadastrada com o codigo SPF0000007928 no campo da proposta ficava sem
-- adesao e nao ligava com a venda. O codigo SPF e a propria adesao.
create or replace function public.trg_analise_spf_adesao()
 returns trigger language plpgsql
as $function$
begin
  if new.adesao is null and coalesce(new.proposal_id_raw,'') ~ '^SPF[0-9]+$' then
    new.adesao := ltrim(substr(new.proposal_id_raw, 4), '0')::bigint;
  end if;
  return new;
end $function$;
drop trigger if exists a01_analise_spf_adesao on public.vendedoras_analise;
create trigger a01_analise_spf_adesao before insert or update of proposal_id_raw, adesao on public.vendedoras_analise
  for each row execute function public.trg_analise_spf_adesao();
