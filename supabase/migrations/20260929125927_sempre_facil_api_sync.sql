create table if not exists public.sf_propostas_api (
  code int primary key,
  contract_number text unique,
  api_id uuid,
  cpf text, nome text,
  tabela text, tabela_codigo text,
  parcelas int, valor_liquido numeric, valor_emprestimo numeric,
  status_code int, status_nome text, status_data timestamp,
  data_credito text, data_desembolso text, criado_api timestamp,
  raw jsonb, sincronizado_em timestamptz default now()
);
alter table public.sf_propostas_api enable row level security;
create index if not exists sf_propostas_api_cpf_idx on public.sf_propostas_api (cpf);

create table if not exists public.sf_sync_estado (
  id int primary key default 1, modo text default 'carga', pagina int default 1, total_paginas int,
  req_id bigint, ciclo_inicio timestamptz default now(), paginas_rotina int default 10,
  ultimo_status int, ultimo_ok timestamptz, erros int default 0
);
alter table public.sf_sync_estado enable row level security;
insert into public.sf_sync_estado (id) values (1) on conflict do nothing;

create or replace function public.sf_sync_tick()
returns void language plpgsql security definer set search_path = public, net, vault as $function$
declare e record; r record; j jsonb; v_key text;
begin
  select * into e from sf_sync_estado where id = 1 for update;

  -- 1) processa a resposta pendente
  if e.req_id is not null then
    select status_code, content into r from net._http_response where id = e.req_id;
    if not found then return; end if;                 -- ainda nao chegou
    if r.status_code = 200 then
      j := r.content::jsonb;
      insert into sf_propostas_api (code, contract_number, api_id, cpf, nome, tabela, tabela_codigo, parcelas, valor_liquido, valor_emprestimo,
                                    status_code, status_nome, status_data, data_credito, data_desembolso, criado_api, raw, sincronizado_em)
      select (i->>'code')::int, i->>'contractNumber', (i->>'id')::uuid, i#>>'{borrower,identity}', i#>>'{borrower,name}',
             i#>>'{rule,name}', i#>>'{rule,code}', nullif(i->>'term','')::int, nullif(i->>'netValue','')::numeric, nullif(i->>'loanValue','')::numeric,
             nullif(i#>>'{status,code}','')::int, i#>>'{status,name}', nullif(i#>>'{status,date}','')::timestamp,
             i->>'creditDate', i->>'disbursementDate', nullif(i#>>'{log,creationDate}','')::timestamp, i, now()
        from jsonb_array_elements(j->'items') i
      on conflict (code) do update set
        contract_number = excluded.contract_number, cpf = excluded.cpf, nome = excluded.nome, tabela = excluded.tabela,
        tabela_codigo = excluded.tabela_codigo, parcelas = excluded.parcelas, valor_liquido = excluded.valor_liquido,
        valor_emprestimo = excluded.valor_emprestimo, status_code = excluded.status_code, status_nome = excluded.status_nome,
        status_data = excluded.status_data, data_credito = excluded.data_credito, data_desembolso = excluded.data_desembolso,
        raw = excluded.raw, sincronizado_em = now();
      update sf_sync_estado set total_paginas = nullif(j->>'pages','')::int, pagina = pagina + 1, req_id = null,
             ultimo_status = 200, ultimo_ok = now(), erros = 0 where id = 1;
    else
      -- 429 (limite) ou erro: repete a mesma pagina no proximo tick
      update sf_sync_estado set req_id = null, ultimo_status = r.status_code, erros = erros + 1 where id = 1;
      return;
    end if;
    select * into e from sf_sync_estado where id = 1;
  end if;

  -- 2) decide a proxima pagina
  if e.modo = 'carga' and e.total_paginas is not null and e.pagina > e.total_paginas then
    update sf_sync_estado set modo = 'rotina', pagina = 1, ciclo_inicio = now() where id = 1;
    select * into e from sf_sync_estado where id = 1;
  end if;
  if e.modo = 'rotina' and e.pagina > e.paginas_rotina then
    if now() - e.ciclo_inicio < interval '15 minutes' then return; end if;   -- espera o proximo ciclo
    update sf_sync_estado set pagina = 1, ciclo_inicio = now() where id = 1;
    select * into e from sf_sync_estado where id = 1;
  end if;

  -- 3) dispara a pagina
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'sempre_facil_apikey';
  update sf_sync_estado set req_id = net.http_get(
      url := 'https://integration.ajin.io/v3/loans?page=' || e.pagina,
      headers := jsonb_build_object('apikey', v_key),
      timeout_milliseconds := 60000)
   where id = 1;
end $function$;

revoke all on function public.sf_sync_tick() from public, anon, authenticated;
select cron.schedule('sf_sync_api', '20 seconds', 'select public.sf_sync_tick()');
