-- "Pagas" de Disparos (disparochat) e Entradas LP (pagamentos) passam a bater
-- com vendas_gerais: uma marca por venda, na data do pagamento (BRT).
--
-- Antes:
--  * pagamentos.pago_em = data::timestamptz = 00h UTC = 21h do DIA ANTERIOR em
--    Brasilia (venda de 01/10 aparecia em 30/09);
--  * venda que entrava sem telefone nunca ganhava pagamento (o gatilho so
--    rodava de novo se mudasse data/valor);
--  * atribuicao do disparo so no INSERT (corrigir a data nao reatribuia);
--  * disparochat.pagas era escrita por n8n (Novo Saque), VendeAI e
--    dashboard_vendas_sync em TODAS as linhas do telefone/CPF, com
--    data_pagamento = now() (hora da marcacao) e sem venda confirmada.

-- 1) liga a linha da disparochat a venda que a marcou
alter table public.disparochat add column if not exists venda_id_pagamento bigint;
create index if not exists disparochat_venda_pag_idx
  on public.disparochat (venda_id_pagamento) where venda_id_pagamento is not null;

-- 2) pagas/data_pagamento so mudam pela venda (flag de sessao). Os outros
--    escritores continuam funcionando, mas essas colunas ficam como estavam.
create or replace function public.trg_disparochat_data_pagamento()
 returns trigger
 language plpgsql
as $function$
begin
  if coalesce(current_setting('hotline.marca_pago', true), '') <> '1' then
    if TG_OP = 'INSERT' then
      NEW.pagas := null; NEW.data_pagamento := null; NEW.campanha_pagamento := null;
      NEW.disparo_do_pagamento := null; NEW.venda_id_pagamento := null;
    else
      NEW.pagas := OLD.pagas; NEW.data_pagamento := OLD.data_pagamento;
      NEW.campanha_pagamento := OLD.campanha_pagamento;
      NEW.disparo_do_pagamento := OLD.disparo_do_pagamento;
      NEW.venda_id_pagamento := OLD.venda_id_pagamento;
    end if;
    return NEW;
  end if;

  if NEW.pagas is null then
    NEW.data_pagamento := null; NEW.campanha_pagamento := null;
    NEW.disparo_do_pagamento := null; NEW.venda_id_pagamento := null;
  else
    NEW.data_pagamento := coalesce(NEW.data_pagamento, now());
    NEW.campanha_pagamento := efetiva_campanha(NEW.campanha, NEW.campanha_reenvio, NEW.reenvio);
    NEW.disparo_do_pagamento := coalesce(NEW.reenvio, NEW.realizado);
  end if;
  return NEW;
end;
$function$;

-- 3) marca UM disparo por venda: o ultimo enviado ate o fim do dia da venda,
--    nos 31 dias anteriores, pelo WhatsApp ou pelo CPF. Linha ja paga por outra
--    venda nao e tomada. Venda apagada/zerada tira a marca.
create or replace function public.disparochat_marca_pago_por_venda(p_venda_id bigint)
 returns bigint
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v record; v_tel text; v_wa bigint; v_cpf text;
  v_quando timestamptz; v_fim timestamptz; v_dc bigint;
begin
  perform set_config('hotline.marca_pago', '1', true);

  select id, cpf, whatsapp, valor, data into v from vendas_gerais where id = p_venda_id;
  if v.id is null or v.data is null or coalesce(v.valor, 0) <= 0 then
    update disparochat set pagas = null where venda_id_pagamento = p_venda_id;
    perform set_config('hotline.marca_pago', '', true);
    return null;
  end if;

  v_quando := (v.data::timestamp + interval '12 hours') at time zone 'America/Sao_Paulo';
  v_fim := (v.data::timestamp + interval '1 day') at time zone 'America/Sao_Paulo';
  v_tel := telefone_do_cpf(v.cpf, v.whatsapp);
  v_wa := case when v_tel ~ '^\d{8,15}$' then v_tel::bigint end;
  v_cpf := nullif(norm_cpf(v.cpf), '');
  if v_cpf = '00000000000' then v_cpf := null; end if;

  -- duas buscas separadas pra cada uma usar seu indice
  select x.id into v_dc from (
    select d.id, coalesce(d.reenvio, d.realizado) t from disparochat d
     where v_wa is not null and d.whatsapp = v_wa
       and (d.pagas is null or d.venda_id_pagamento = v.id)
    union all
    select d.id, coalesce(d.reenvio, d.realizado) from disparochat d
     where v_cpf is not null and norm_cpf(d.cpf) = v_cpf
       and (d.pagas is null or d.venda_id_pagamento = v.id)
  ) x
  where x.t < v_fim and x.t >= v_fim - interval '31 days'
  order by x.t desc, x.id desc
  limit 1;

  update disparochat set pagas = null
   where venda_id_pagamento = v.id and id is distinct from v_dc;

  if v_dc is not null then
    update disparochat
       set pagas = v.valor, data_pagamento = v_quando, venda_id_pagamento = v.id
     where id = v_dc
       and (pagas is distinct from v.valor or data_pagamento is distinct from v_quando
            or venda_id_pagamento is distinct from v.id);
  end if;

  perform set_config('hotline.marca_pago', '', true);
  return v_dc;
exception when others then
  perform set_config('hotline.marca_pago', '', true);
  insert into triggers_falhas_log (gatilho, tabela, registro_id, erro, detalhe)
  values ('disparochat_marca_pago_por_venda', 'vendas_gerais', p_venda_id, SQLERRM, SQLSTATE);
  return null;
end;
$function$;

-- 4) pagamento + marca da disparochat a partir da venda (usado pelo gatilho e
--    pelo reprocessamento). pago_em = meio-dia BRT do dia da venda.
create or replace function public.venda_sincroniza_pagamento(p_venda_id bigint)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v record; v_tel text; v_lead bigint; v_quando timestamptz;
begin
  perform disparochat_marca_pago_por_venda(p_venda_id);

  select id, cpf, whatsapp, valor, data, adesao, banco into v from vendas_gerais where id = p_venda_id;
  if v.id is null or v.data is null or coalesce(v.valor, 0) = 0 then return; end if;
  v_tel := telefone_do_cpf(v.cpf, v.whatsapp);
  if v_tel is null then return; end if;
  if v_tel ~ '^\d{8,15}$' then
    select d.id into v_lead from disparochat d where d.whatsapp = v_tel::bigint order by d.id desc limit 1;
  end if;
  v_quando := (v.data::timestamp + interval '12 hours') at time zone 'America/Sao_Paulo';

  insert into pagamentos (venda_id, lead_id, telefone, pago_em, valor, valor_pago, proposta, banco)
  values (v.id, v_lead, v_tel, v_quando, v.valor, v.valor, v.adesao::text, v.banco)
  on conflict (venda_id) where venda_id is not null do update set
    pago_em = excluded.pago_em, valor = excluded.valor, valor_pago = excluded.valor_pago,
    proposta = coalesce(excluded.proposta, pagamentos.proposta),
    banco = coalesce(excluded.banco, pagamentos.banco),
    lead_id = coalesce(pagamentos.lead_id, excluded.lead_id)
  where pagamentos.pago_em is distinct from excluded.pago_em
     or pagamentos.valor is distinct from excluded.valor
     or pagamentos.banco is distinct from coalesce(excluded.banco, pagamentos.banco)
     or (pagamentos.lead_id is null and excluded.lead_id is not null);
end;
$function$;

create or replace function public.espelha_venda_pagamento()
 returns trigger
 language plpgsql
as $function$
begin
  perform venda_sincroniza_pagamento(new.id);
  return new;
exception when others then
  insert into triggers_falhas_log (gatilho, tabela, registro_id, erro, detalhe)
  values ('espelha_venda_pagamento', TG_TABLE_NAME, new.id, SQLERRM, SQLSTATE);
  return new;
end $function$;

-- roda tambem quando o CPF/WhatsApp chega depois
drop trigger if exists t_venda_pagamento on public.vendas_gerais;
create trigger t_venda_pagamento after insert or update of data, valor, cpf, whatsapp
  on public.vendas_gerais for each row execute function espelha_venda_pagamento();

-- venda apagada (cancelada) tira a marca da disparochat
-- (pagamentos ja sai pelo ON DELETE CASCADE)
create or replace function public.trg_venda_desmarca_disparochat()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  perform disparochat_marca_pago_por_venda(old.id);
  return old;
end $function$;

drop trigger if exists t_venda_desmarca_disparochat on public.vendas_gerais;
create trigger t_venda_desmarca_disparochat after delete
  on public.vendas_gerais for each row execute function trg_venda_desmarca_disparochat();

-- 5) atribuicao e toques recalculam quando o pagamento muda de data/telefone
create or replace function public.atribui_disparo()
 returns trigger
 language plpgsql
as $function$
declare v_quando timestamptz; v_dt timestamptz; v_pri record;
begin
  if TG_TABLE_NAME = 'pagamentos' then
    v_quando := new.pago_em;
    if TG_OP = 'UPDATE' then
      -- zz_toques preenche de novo (so grava onde estiver nulo)
      new.disparo_id := null; new.horas_desde_disparo := null;
      new.primeiro_disparo_id := null; new.campanha_origem := null; new.canal_origem := null;
      new.campanha_ultimo_toque := null; new.disparo_ultimo_toque_id := null;
      new.canal_ultimo_toque := null; new.tipo_ultimo_toque := null; new.horas_ultimo_toque := null;
      new.campanha_primeiro_toque := null; new.disparo_primeiro_toque_id := null;
      new.canal_primeiro_toque := null; new.toques_ate_pagar := null;
    end if;
  else
    v_quando := new.ocorrida_em;
  end if;

  -- ULTIMO toque: o disparo mais recente antes do evento
  select d.id, d.disparado_em into new.disparo_id, v_dt
  from disparos d
  where d.telefone = new.telefone and d.disparado_em <= v_quando
  order by d.disparado_em desc, d.id desc
  limit 1;

  if v_dt is not null then
    new.horas_desde_disparo := round(extract(epoch from (v_quando - v_dt))/3600.0, 2);
  end if;

  -- PRIMEIRO toque: de onde o lead veio originalmente
  select d.id, d.campanha, d.canal into v_pri
  from disparos d
  where d.telefone = new.telefone and d.disparado_em <= v_quando
  order by d.disparado_em asc, d.id asc
  limit 1;

  if v_pri.id is not null then
    new.primeiro_disparo_id := v_pri.id;
    new.campanha_origem := v_pri.campanha;
    new.canal_origem := v_pri.canal;
  end if;

  return new;
end $function$;

drop trigger if exists t_pagamentos_atrib on public.pagamentos;
create trigger t_pagamentos_atrib before insert or update of pago_em, telefone
  on public.pagamentos for each row execute function atribui_disparo();

drop trigger if exists zz_toques on public.pagamentos;
create trigger zz_toques after insert or update of pago_em, telefone
  on public.pagamentos for each row execute function trg_pagamentos_toques();
