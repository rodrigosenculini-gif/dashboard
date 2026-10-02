-- Sempre Facil: varredura completa pela API oficial.
-- GET /v3/loans so devolve as 20 mais novas (offset/limit/page sao ignorados).
-- A doc (docs.ukam.io/joinbank) define consulta por POST com filtros no corpo;
-- POST /v3/loans/search com {"code":{"lt":N}} pagina por codigo (02/10).
-- A cada 30 s busca a proxima pagina abaixo do menor codigo visto, ate passar
-- de 60 dias, e recomeca do topo. Assim nenhuma proposta fica de fora (167
-- Integradas de setembro nunca entraram) e cancelamento/reembolso sao vistos.
alter table public.sf_sync_estado add column if not exists varredura_cursor integer;
alter table public.sf_sync_estado add column if not exists ultima_varredura timestamptz;
alter table public.sf_sync_estado add column if not exists varredura_ciclos integer not null default 0;

create or replace function public.sf_sync_tick()
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'net', 'vault'
as $function$
declare e record; r record; j jsonb; v_key text; v_prox record; v_min int; v_mais_antiga date;
begin
  select * into e from sf_sync_estado where id = 1 for update;

  if e.req_id is not null then
    select status_code, content into r from net._http_response where id = e.req_id;
    if not found then return; end if;
    if r.status_code = 200 then
      j := r.content::jsonb;
      if e.req_tipo in ('lista', 'varredura') then
        perform sf_upsert(i) from jsonb_array_elements(j->'items') i;
        if e.req_tipo = 'lista' then
          update sf_sync_estado set ultima_descoberta = now() where id = 1;
        else
          select min((i->>'code')::int), min(nullif(i->>'proposalDate','')::date)
            into v_min, v_mais_antiga from jsonb_array_elements(j->'items') i;
          -- fim do ciclo: pagina vazia ou ja passou de 60 dias -> volta ao topo
          if v_min is null or coalesce(v_mais_antiga, hoje_sp()) < hoje_sp() - 60 then
            update sf_sync_estado set varredura_cursor = null, ultima_varredura = now(),
                   varredura_ciclos = varredura_ciclos + 1 where id = 1;
          else
            update sf_sync_estado set varredura_cursor = v_min, ultima_varredura = now() where id = 1;
          end if;
        end if;
      else
        perform sf_upsert(j);
      end if;
      update sf_sync_estado set req_id = null, ultimo_status = 200, ultimo_ok = now(), erros = 0 where id = 1;
    else
      if e.req_tipo = 'item' and e.req_code is not null then
        update sf_propostas_api set sincronizado_em = now() where code = e.req_code;   -- nao trava a fila
      end if;
      if e.req_tipo = 'varredura' then
        update sf_sync_estado set ultima_varredura = now() where id = 1;               -- tenta de novo depois
      end if;
      update sf_sync_estado set req_id = null, ultimo_status = r.status_code, erros = erros + 1,
             pausa_ate = case when r.status_code = 429 then now() + interval '2 minutes' else pausa_ate end where id = 1;
    end if;
    return;
  end if;

  if e.pausa_ate is not null and now() < e.pausa_ate then return; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'sempre_facil_apikey';

  -- descoberta: 1a pagina (mais novas) a cada 1 min (01/10: 5 min perdia propostas no pico)
  if e.ultima_descoberta is null or now() - e.ultima_descoberta > interval '1 minute' then
    update sf_sync_estado set req_tipo = 'lista', req_code = null,
      req_id = net.http_get(url := 'https://integration.ajin.io/v3/loans', headers := jsonb_build_object('apikey', v_key), timeout_milliseconds := 30000)
     where id = 1;
    return;
  end if;

  -- varredura: proxima pagina abaixo do menor codigo visto, a cada 30 s
  if e.ultima_varredura is null or now() - e.ultima_varredura > interval '30 seconds' then
    update sf_sync_estado set req_tipo = 'varredura', req_code = e.varredura_cursor,
      req_id = net.http_post(url := 'https://integration.ajin.io/v3/loans/search',
                 body := case when e.varredura_cursor is null then '{}'::jsonb
                              else jsonb_build_object('code', jsonb_build_object('lt', e.varredura_cursor)) end,
                 headers := jsonb_build_object('apikey', v_key, 'Content-Type', 'application/json'),
                 timeout_milliseconds := 30000)
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
end;
$function$;
