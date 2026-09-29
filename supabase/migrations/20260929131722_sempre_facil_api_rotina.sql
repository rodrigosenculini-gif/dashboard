alter table public.sf_sync_estado add column if not exists ultima_descoberta timestamptz, add column if not exists pausa_ate timestamptz, add column if not exists req_tipo text, add column if not exists req_code int;

-- status finais (docs JoinBank 7.1): 63 pago; cancelados/reprovados
create or replace function public.sf_status_final(p int) returns text language sql immutable as $$
  select case when p = 63 then 'pago'
              when p in (46,70,72,73,74,104,106,111,113,117,137,141,145,149,152,194,198,205,207,212,217,219,221,229,231,235,238,239,241) then 'cancelado'
              else null end $$;

create or replace function public.sf_upsert(i jsonb) returns void language sql security definer set search_path = public as $$
  insert into sf_propostas_api (code, contract_number, api_id, cpf, nome, tabela, tabela_codigo, parcelas, valor_liquido, valor_emprestimo,
                                status_code, status_nome, status_data, data_credito, data_desembolso, criado_api, raw, sincronizado_em)
  values ((i->>'code')::int, i->>'contractNumber', (i->>'id')::uuid, i#>>'{borrower,identity}', i#>>'{borrower,name}',
          i#>>'{rule,name}', i#>>'{rule,code}', nullif(i->>'term','')::int, nullif(i->>'netValue','')::numeric, nullif(i->>'loanValue','')::numeric,
          nullif(i#>>'{status,code}','')::int, i#>>'{status,name}', nullif(i#>>'{status,date}','')::timestamp,
          i->>'creditDate', i->>'disbursementDate', nullif(i#>>'{log,creationDate}','')::timestamp, i, now())
  on conflict (code) do update set
    contract_number = excluded.contract_number, cpf = excluded.cpf, nome = excluded.nome, tabela = excluded.tabela,
    tabela_codigo = excluded.tabela_codigo, parcelas = excluded.parcelas, valor_liquido = excluded.valor_liquido,
    valor_emprestimo = excluded.valor_emprestimo, status_code = excluded.status_code, status_nome = excluded.status_nome,
    status_data = excluded.status_data, data_credito = excluded.data_credito, data_desembolso = excluded.data_desembolso,
    raw = excluded.raw, sincronizado_em = now();
$$;

create or replace function public.sf_sync_tick()
returns void language plpgsql security definer set search_path = public, net, vault as $function$
declare e record; r record; j jsonb; v_key text; v_prox record;
begin
  select * into e from sf_sync_estado where id = 1 for update;

  if e.req_id is not null then
    select status_code, content into r from net._http_response where id = e.req_id;
    if not found then return; end if;
    if r.status_code = 200 then
      j := r.content::jsonb;
      if e.req_tipo = 'lista' then
        perform sf_upsert(i) from jsonb_array_elements(j->'items') i;
        update sf_sync_estado set ultima_descoberta = now() where id = 1;
      else
        perform sf_upsert(j);
      end if;
      update sf_sync_estado set req_id = null, ultimo_status = 200, ultimo_ok = now(), erros = 0 where id = 1;
    else
      if e.req_tipo = 'item' and e.req_code is not null then
        update sf_propostas_api set sincronizado_em = now() where code = e.req_code;   -- nao trava a fila
      end if;
      update sf_sync_estado set req_id = null, ultimo_status = r.status_code, erros = erros + 1,
             pausa_ate = case when r.status_code = 429 then now() + interval '2 minutes' else pausa_ate end where id = 1;
    end if;
    return;
  end if;

  if e.pausa_ate is not null and now() < e.pausa_ate then return; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'sempre_facil_apikey';

  -- descoberta: 1a pagina (mais novas) a cada 5 min
  if e.ultima_descoberta is null or now() - e.ultima_descoberta > interval '5 minutes' then
    update sf_sync_estado set req_tipo = 'lista', req_code = null,
      req_id = net.http_get(url := 'https://integration.ajin.io/v3/loans', headers := jsonb_build_object('apikey', v_key), timeout_milliseconds := 30000)
     where id = 1;
    return;
  end if;

  -- acompanhamento: 1 proposta em aberto por vez, a mais desatualizada (>15 min)
  select code, api_id into v_prox from sf_propostas_api
   where sf_status_final(status_code) is null and api_id is not null
     and coalesce(criado_api, sincronizado_em) > now() - interval '30 days'
     and sincronizado_em < now() - interval '15 minutes'
   order by sincronizado_em limit 1;
  if v_prox.code is null then return; end if;

  update sf_sync_estado set req_tipo = 'item', req_code = v_prox.code,
    req_id = net.http_get(url := 'https://integration.ajin.io/v3/loans/' || v_prox.api_id, headers := jsonb_build_object('apikey', v_key), timeout_milliseconds := 30000)
   where id = 1;
end $function$;

-- proposta paga na API -> completa/lanca a venda
create or replace function public.sf_aplica_venda(p_code int) returns bigint
language plpgsql security definer set search_path = public as $function$
declare s record; v_id bigint; v_data date; v_mes date := date_trunc('month', hoje_sp())::date; v_cpf text;
begin
  select * into s from sf_propostas_api where code = p_code;
  if s.code is null or s.status_code <> 63 then return null; end if;
  v_data := coalesce(s.status_data::date, hoje_sp());
  v_cpf := case when cpf_valido(s.cpf) then norm_cpf(s.cpf) end;

  select id into v_id from vendas_gerais
   where normalizar_banco(banco) = 'SEMPRE FACIL'
     and (proposal_id_raw = s.contract_number or adesao = s.code
          or (v_cpf is not null and norm_cpf(cpf) = v_cpf and abs(valor - s.valor_liquido) < 0.02))
   order by (proposal_id_raw = s.contract_number) desc nulls last, (adesao = s.code) desc nulls last limit 1;

  if v_id is null then
    insert into vendas_gerais (banco, adesao, proposal_id_raw, cpf, nome, valor, parcelas, tabela, data, origem)
    values ('SEMPRE FACIL', s.code, s.contract_number, v_cpf, s.nome, s.valor_liquido, s.parcelas, s.tabela, v_data, 'sf_api')
    returning id into v_id;
  else
    update vendas_gerais set
      tabela = coalesce(s.tabela, tabela),
      parcelas = coalesce(s.parcelas, parcelas),
      adesao = coalesce(adesao, s.code),
      proposal_id_raw = case when proposal_id_raw is null or proposal_id_raw !~ '^SPF' then s.contract_number else proposal_id_raw end,
      cpf = case when not cpf_valido(cpf) then coalesce(v_cpf, cpf) else cpf end,
      nome = coalesce(nullif(btrim(nome),''), s.nome),
      -- data do banco, sem mexer em mes fechado
      data = case when data >= v_mes and v_data >= v_mes then v_data else data end
    where id = v_id;
  end if;
  return v_id;
end $function$;

create or replace function public.trg_sf_proposta_paga() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status_code = 63 then perform sf_aplica_venda(new.code); end if;
  return new;
exception when others then
  insert into triggers_falhas_log (gatilho, tabela, registro_id, erro, detalhe) values ('trg_sf_proposta_paga', TG_TABLE_NAME, new.code, SQLERRM, SQLSTATE);
  return new;
end $$;
drop trigger if exists sf_proposta_paga on public.sf_propostas_api;
create trigger sf_proposta_paga after insert or update of status_code, tabela, parcelas, valor_liquido on public.sf_propostas_api
for each row execute function public.trg_sf_proposta_paga();

revoke all on function public.sf_sync_tick(), public.sf_aplica_venda(int), public.sf_upsert(jsonb) from public, anon, authenticated;
update sf_sync_estado set req_id = null, modo = 'rotina', pausa_ate = null where id = 1;
