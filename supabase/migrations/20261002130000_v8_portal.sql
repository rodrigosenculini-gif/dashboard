-- V8 pelo portal (02/10). O V8 nao tem API publica: o fluxo do n8n "V8 - portal"
-- entra com o login do portal (Auth0, mesmo caminho da tela) e le
-- /private-consignment/operation. Aqui fica o espelho das operacoes e a regra:
--  - paga: lanca a venda que falta (tabela CLT ACELERA com/sem seguro pelo
--    seguro real) ou completa a que existe; completa o valor da proposta
--    (VendeAI manda status sem valor e a venda nao entrava);
--  - paga e depois cancelada: proposta vira Estornado e a venda/analise sai
--    (o VendeAI nao avisa estorno);
--  - so mexe no mes corrente (ou no anterior ate o dia 10) e respeita
--    vendas_bloqueadas.
create table if not exists public.v8_operacoes_portal (
  contrato text primary key,
  operation_id uuid,
  cpf text,
  nome text,
  valor numeric,
  status text,
  historico text[],
  criado_portal timestamptz,
  pago_em date,
  parcelas integer,
  seguro boolean,
  status_detalhe text,
  detalhe_em timestamptz,
  atualizado_em timestamptz not null default now()
);
alter table public.v8_operacoes_portal enable row level security;

-- recebe a listagem resumida e devolve os operation_id que precisam de detalhe
create or replace function public.v8_portal_lista(p_ops jsonb)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
begin
  insert into v8_operacoes_portal as o (contrato, operation_id, cpf, nome, valor, status, historico, criado_portal, atualizado_em)
  select x->>'contractNumber', (x->>'operationId')::uuid, regexp_replace(coalesce(x->>'documentNumber',''),'\D','','g'),
         x->>'name', nullif(x->>'disbursedIssueAmount','')::numeric, x->>'status',
         array(select h->>'action' from jsonb_array_elements(coalesce(x->'history','[]'::jsonb)) h),
         nullif(x->>'createdAt','')::timestamptz, now()
    from jsonb_array_elements(coalesce(p_ops,'[]'::jsonb)) x
   where coalesce(x->>'contractNumber','') <> '' and x->>'operationId' is not null
  on conflict (contrato) do update set
    operation_id = excluded.operation_id, cpf = excluded.cpf, nome = excluded.nome, valor = excluded.valor,
    status = excluded.status, historico = excluded.historico, criado_portal = excluded.criado_portal, atualizado_em = now();

  return jsonb_build_object('ids', coalesce((
    select jsonb_agg(o.operation_id)
      from v8_operacoes_portal o
     where o.contrato in (select x->>'contractNumber' from jsonb_array_elements(coalesce(p_ops,'[]'::jsonb)) x)
       and (o.status = 'paid' or (o.status = 'canceled' and 'paid' = any(o.historico)))
       and (o.detalhe_em is null or o.status_detalhe is distinct from o.status)
  ), '[]'::jsonb));
end;
$function$;

-- aplica uma operacao ja detalhada nas propostas e nas vendas
create or replace function public.v8_aplica_operacao(p_contrato text)
 returns text language plpgsql security definer set search_path to 'public'
as $function$
declare o record; v_id bigint; v_mes date := date_trunc('month', hoje_sp())::date; v_corte date;
        v_tab text; v_origem text; v_n int;
begin
  select * into o from v8_operacoes_portal where contrato = p_contrato;
  if o.contrato is null or o.detalhe_em is null then return 'sem detalhe'; end if;
  v_corte := case when extract(day from hoje_sp()) > 10 then v_mes else (v_mes - interval '1 month')::date end;
  v_tab := case when o.seguro then 'CLT ACELERA - COM SEGURO' else 'CLT ACELERA - SEM SEGURO' end;

  if o.status = 'paid' then
    update propostas_bancos set
      valor = coalesce(valor, o.valor), parcelas = coalesce(parcelas, o.parcelas),
      status_anterior = case when status is distinct from 'LIQUIDATED_TO_CUSTOMER' then status else status_anterior end,
      status = 'LIQUIDATED_TO_CUSTOMER', pago = true, cancelado = false,
      data_pagamento = coalesce(data_pagamento, o.pago_em), atualizado_em = now()
     where normalizar_banco(banco) = 'V8' and proposal_number = o.contrato;

    select id into v_id from vendas_gerais
     where normalizar_banco(banco) = 'V8'
       and (adesao::text = o.contrato
            or (o.cpf <> '' and norm_cpf(cpf) = o.cpf and abs(valor - o.valor) < 1 and data >= v_corte))
     order by (adesao::text = o.contrato and norm_cpf(cpf) = o.cpf) desc nulls last, (adesao::text = o.contrato) desc nulls last, id limit 1;

    if v_id is null then
      if venda_bloqueada('V8', o.contrato) then return 'bloqueada'; end if;
      if coalesce(o.pago_em, hoje_sp()) < v_corte then return 'fora do periodo'; end if;
      select case when p.id is not null then 'vendeai' end into v_origem
        from propostas_bancos p where normalizar_banco(p.banco) = 'V8' and p.proposal_number = o.contrato limit 1;
      if v_origem is null then
        select nullif(btrim(d.origem),'') into v_origem from disparochat d
         where d.cpf is not null and norm_cpf(d.cpf::text) = o.cpf order by d.id desc limit 1;
      end if;
      insert into vendas_gerais (data, banco, adesao, cpf, nome, valor, tabela, parcelas, seguro, proposal_id_raw, origem)
      values (coalesce(o.pago_em, hoje_sp()), 'V8', (case when o.contrato ~ '^[0-9]+$' then o.contrato::bigint end), o.cpf, o.nome, o.valor, v_tab, o.parcelas,
              case when o.seguro then 'sim' else 'nao' end, o.contrato, v_origem)
      returning id into v_id;
      update propostas_bancos set lancado_em_vendas = true, lancado_em = now()
       where normalizar_banco(banco) = 'V8' and proposal_number = o.contrato;
      return 'lancada ' || v_id;
    end if;

    -- venda existe: completa tabela/seguro/prazo pelo portal e acerta o dia
    update vendas_gerais set
      tabela = case when coalesce(tabela,'') = '' or tabela ~* '^CLT ACELERA' then v_tab else tabela end,
      seguro = case when o.seguro then 'sim' else 'nao' end,
      parcelas = coalesce(o.parcelas, parcelas),
      adesao = coalesce(adesao, (case when o.contrato ~ '^[0-9]+$' then o.contrato::bigint end)),
      data = case when data >= v_mes and coalesce(o.pago_em, data) >= v_mes then coalesce(o.pago_em, data) else data end
     where id = v_id
       and (coalesce(tabela,'') = '' or tabela ~* '^CLT ACELERA' or parcelas is null or adesao is null);
    update propostas_bancos set lancado_em_vendas = true
     where normalizar_banco(banco) = 'V8' and proposal_number = o.contrato and not lancado_em_vendas;
    return 'ok ' || v_id;
  end if;

  if o.status = 'canceled' and 'paid' = any(o.historico) then
    update propostas_bancos set
      status_anterior = case when status is distinct from 'ESTORNADO - PAGO E CANCELADO' then status else status_anterior end,
      status = 'ESTORNADO - PAGO E CANCELADO', pago = false, cancelado = true, atualizado_em = now()
     where normalizar_banco(banco) = 'V8' and proposal_number = o.contrato;

    insert into vendas_canceladas_removidas_log (venda_id, cpf, banco, adesao, valor, ponto, data, status_api, linha)
    select v.id, v.cpf, v.banco, v.adesao::text, v.valor, v.ponto, v.data, 'ESTORNADO - PAGO E CANCELADO (portal V8)', to_jsonb(v)
      from vendas_gerais v
     where normalizar_banco(v.banco) = 'V8' and v.adesao::text = o.contrato and v.data >= v_corte;
    insert into vendas_canceladas_removidas_log (venda_id, cpf, banco, adesao, valor, ponto, data, status_api, linha)
    select null, va.cpf, va.banco, va.adesao::text, va.valor::numeric, null, va.data_status,
           'ESTORNADO - PAGO E CANCELADO (portal V8)', jsonb_build_object('tipo','analise') || to_jsonb(va)
      from vendedoras_analise va
     where upper(va.banco) = 'V8' and va.adesao::text = o.contrato and va.data_status >= v_corte;
    delete from vendedoras_analise va where upper(va.banco) = 'V8' and va.adesao::text = o.contrato and va.data_status >= v_corte;
    delete from vendas_gerais v where normalizar_banco(v.banco) = 'V8' and v.adesao::text = o.contrato and v.data >= v_corte;
    get diagnostics v_n = row_count;
    return 'estornada (' || v_n || ' venda removida)';
  end if;
  return 'nada';
end;
$function$;

-- recebe os detalhes, grava e aplica; devolve um resumo
create or replace function public.v8_portal_detalhe(p_dets jsonb)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare d jsonb; v_res text; v_out jsonb := '{}'::jsonb; v_pago timestamptz;
begin
  for d in select * from jsonb_array_elements(coalesce(p_dets,'[]'::jsonb)) loop
    select max((h->>'created_at')::timestamptz) into v_pago
      from jsonb_array_elements(coalesce(d->'operation_history','[]'::jsonb)) h where h->>'action' = 'paid';
    update v8_operacoes_portal set
      status = coalesce(d->>'status', status),
      valor = coalesce(nullif(d->>'disbursed_issue_amount','')::numeric, valor),
      parcelas = nullif(d#>>'{operation_data,number_of_installments}','')::int,
      seguro = coalesce((d#>>'{operation_data,is_insured}')::boolean, false),
      pago_em = (v_pago at time zone 'America/Sao_Paulo')::date,
      status_detalhe = coalesce(d->>'status', status), detalhe_em = now(), atualizado_em = now()
     where contrato = d->>'contract_number' or operation_id::text = d->>'id';
    select v8_aplica_operacao(contrato) into v_res from v8_operacoes_portal
     where contrato = d->>'contract_number' or operation_id::text = d->>'id' limit 1;
    v_out := v_out || jsonb_build_object(coalesce(d->>'contract_number', d->>'id'), v_res);
  end loop;
  return v_out;
end;
$function$;

revoke all on function public.v8_portal_lista(jsonb), public.v8_aplica_operacao(text), public.v8_portal_detalhe(jsonb) from public, anon, authenticated;
