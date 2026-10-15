-- 15/10: tel_por_cpf era uma foto antiga (1,1 mi de CPFs) sem nada que a alimentasse. Venda de lead novo
-- (LP ou disparo) sem whatsapp na propria venda nao achava telefone -> nao entrava em pagamentos -> o dash
-- Entradas LP mostrava 2 pagas em outubro quando 21 vendas vieram de entradas da LP.
-- 1) telefone_do_cpf olha tambem disparochat, total_produtos e leads_chatwoot;
-- 2) tel_por_cpf passa a ser alimentada por gatilho (total_produtos e disparochat) e e completada agora.
create or replace function public.telefone_do_cpf(p_cpf text, p_whatsapp bigint default null)
 returns text language sql stable
as $function$
  select coalesce(
    nullif(regexp_replace(coalesce(p_whatsapp::text,''),'\D','','g'),''),
    (select t.telefone from tel_por_cpf t where t.cpf_norm = norm_cpf(p_cpf)),
    (select nullif(regexp_replace(d.whatsapp::text,'\D','','g'),'') from disparochat d
      where d.cpf is not null and norm_cpf(d.cpf::text) = norm_cpf(p_cpf) and d.whatsapp is not null order by d.id desc limit 1),
    (select nullif(regexp_replace(x.whatsapp::text,'\D','','g'),'') from total_produtos x
      where x.cpf is not null and norm_cpf(x.cpf) = norm_cpf(p_cpf) and x.whatsapp is not null order by x.created_at desc limit 1),
    (select nullif(regexp_replace(l.whatsapp::text,'\D','','g'),'') from leads_chatwoot l
      where l.cpf is not null and norm_cpf(l.cpf::text) = norm_cpf(p_cpf) and l.whatsapp is not null order by l.id desc limit 1)
  );
$function$;

create or replace function public.trg_tel_por_cpf_alimenta()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_cpf text; v_tel text;
begin
  v_cpf := norm_cpf(new.cpf::text);
  v_tel := nullif(regexp_replace(coalesce(new.whatsapp::text,''),'\D','','g'),'');
  if v_cpf is null or v_tel is null or not cpf_valido(v_cpf) then return new; end if;
  insert into tel_por_cpf (cpf_norm, telefone, atualizado_em) values (v_cpf, v_tel, now())
  on conflict (cpf_norm) do update set telefone = excluded.telefone, atualizado_em = now()
  where tel_por_cpf.telefone is distinct from excluded.telefone;
  return new;
exception when others then
  return new;
end $function$;
drop trigger if exists zz_tel_por_cpf on public.total_produtos;
create trigger zz_tel_por_cpf after insert or update of cpf, whatsapp on public.total_produtos
  for each row execute function public.trg_tel_por_cpf_alimenta();
drop trigger if exists zz_tel_por_cpf on public.disparochat;
create trigger zz_tel_por_cpf after insert or update of cpf, whatsapp on public.disparochat
  for each row execute function public.trg_tel_por_cpf_alimenta();

-- completa o que faltava a partir das entradas da LP
insert into tel_por_cpf (cpf_norm, telefone, atualizado_em)
select distinct on (norm_cpf(t.cpf)) norm_cpf(t.cpf), regexp_replace(t.whatsapp::text,'\D','','g'), now()
  from total_produtos t
 where t.cpf is not null and t.whatsapp is not null and cpf_valido(norm_cpf(t.cpf))
 order by norm_cpf(t.cpf), t.created_at desc
on conflict (cpf_norm) do nothing;
