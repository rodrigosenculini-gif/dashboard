-- 1) data_pagamento: respeita valor informado explicitamente; now() so quando ninguem informou
create or replace function public.trg_total_produtos_data_pagamento()
returns trigger language plpgsql as $function$
begin
  if TG_OP = 'INSERT' then
    if new.pagas = 1 and new.data_pagamento is null then new.data_pagamento := now(); end if;
  elsif TG_OP = 'UPDATE' then
    if new.pagas = 1 and (new.pagas is distinct from old.pagas or new.valor is distinct from old.valor)
       and new.data_pagamento is not distinct from old.data_pagamento then
      new.data_pagamento := now();
    end if;
  end if;
  return new;
end $function$;

-- 2) indices para o casamento venda -> LP
create index if not exists total_produtos_cpf_norm_idx on public.total_produtos (norm_cpf(cpf)) where cpf is not null;
create index if not exists total_produtos_whats11_idx on public.total_produtos (right(whatsapp::text, 11)) where whatsapp is not null;

-- 3) venda paga -> marca a entrada da LP do cliente
create or replace function public.lp_marca_pago_por_venda(p_venda_id bigint)
returns bigint language plpgsql security definer set search_path = public as $function$
declare v record; v_lp bigint; v_tel text; v_quando timestamptz;
begin
  select id, norm_cpf(cpf) cpf, whatsapp, valor, data, banco into v from vendas_gerais where id = p_venda_id;
  if v.id is null or v.data is null then return null; end if;
  v_quando := (v.data::timestamp + interval '12 hours') at time zone 'America/Sao_Paulo';
  v_tel := right(regexp_replace(coalesce(v.whatsapp::text,''), '\D', '', 'g'), 11);

  -- CPF primeiro; WhatsApp so quando nao achou pelo CPF
  if nullif(v.cpf,'') is not null and v.cpf <> '00000000000' then
    select id into v_lp from total_produtos
     where norm_cpf(cpf) = v.cpf and cpf is not null
       and coalesce(pagas,0) <> 1
       and created_at::date <= v.data and created_at >= v.data - interval '45 days'
     order by created_at desc limit 1;
  end if;
  if v_lp is null and length(v_tel) >= 10 then
    select id into v_lp from total_produtos
     where right(whatsapp::text, 11) = v_tel and whatsapp is not null
       and nullif(norm_cpf(cpf),'') is null
       and coalesce(pagas,0) <> 1
       and created_at::date <= v.data and created_at >= v.data - interval '45 days'
     order by created_at desc limit 1;
  end if;
  if v_lp is null then return null; end if;

  update total_produtos
     set pagas = 1, valor = v.valor, data_pagamento = v_quando,
         horario_aprovacao = coalesce(horario_aprovacao, v_quando),
         origem_aprovacao = coalesce(origem_aprovacao, 'venda'),
         banco = coalesce(nullif(btrim(banco),''), v.banco)
   where id = v_lp;
  return v_lp;
end $function$;

create or replace function public.trg_venda_marca_lp()
returns trigger language plpgsql security definer set search_path = public as $function$
begin
  perform lp_marca_pago_por_venda(new.id);
  return new;
exception when others then
  insert into triggers_falhas_log (gatilho, tabela, registro_id, erro, detalhe)
  values ('trg_venda_marca_lp', TG_TABLE_NAME, new.id, SQLERRM, SQLSTATE);
  return new;
end $function$;

drop trigger if exists zz_venda_marca_lp on public.vendas_gerais;
create trigger zz_venda_marca_lp after insert or update of cpf, whatsapp, data on public.vendas_gerais
for each row execute function public.trg_venda_marca_lp();

revoke all on function public.lp_marca_pago_por_venda(bigint) from public, anon, authenticated;
