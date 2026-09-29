-- Presenca: a API devolve quantidadeParcelas, mas o normalizador do n8n nao copia para parcelas_banco
create or replace function public.trg_log_completa_parcelas()
returns trigger language plpgsql security definer set search_path = public as $function$
declare v_parc int;
begin
  if new.parcelas_banco is null and new.resposta_bruta is not null then
    v_parc := nullif(regexp_replace(coalesce(jsonb_desembrulha(new.resposta_bruta)->>'quantidadeParcelas',''), '\D', '', 'g'), '')::int;
    if v_parc is not null then
      new.parcelas_banco := v_parc;
    end if;
  end if;
  if new.parcelas_banco is not null and new.adesao ~ '^\d+$' then
    update vendas_gerais set parcelas = new.parcelas_banco
     where adesao = new.adesao::bigint and parcelas is null
       and normalizar_banco(banco) = normalizar_banco(new.banco);
  end if;
  return new;
exception when others then return new;
end $function$;

drop trigger if exists log_completa_parcelas on public.consultas_bancos_log;
create trigger log_completa_parcelas before insert on public.consultas_bancos_log
for each row execute function public.trg_log_completa_parcelas();
