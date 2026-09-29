-- 1) Sempre Facil: remove venda/analise cuja proposta a API diz cancelada (casa so pelo codigo SPF / adesao)
create or replace function public.sf_remove_canceladas(p_aplicar boolean default false)
returns table(tipo text, id bigint, code int, vendedor text, valor numeric, status text)
language plpgsql security definer set search_path = public as $function$
begin
  create temp table _sfc on commit drop as
  select 'venda'::text tipo, vg.id, s.code, vg.vendedor, vg.valor, s.status_nome status, to_jsonb(vg) linha
    from sf_propostas_api s
    join vendas_gerais vg on normalizar_banco(vg.banco) = 'SEMPRE FACIL' and (vg.proposal_id_raw = s.contract_number or vg.adesao = s.code)
   where sf_status_final(s.status_code) = 'cancelado'
  union all
  select 'analise', va.id, s.code, va.vendedor, va.valor::numeric, s.status_nome, to_jsonb(va)
    from sf_propostas_api s
    join vendedoras_analise va on upper(va.banco) = 'SEMPRE FACIL' and (va.proposal_id_raw = s.contract_number or va.adesao = s.code)
   where sf_status_final(s.status_code) = 'cancelado';

  if p_aplicar then
    insert into vendas_canceladas_removidas_log (venda_id, cpf, banco, adesao, valor, ponto, data, status_api, linha)
    select case when c.tipo = 'venda' then c.id end, c.linha->>'cpf', 'SEMPRE FACIL', c.code::text, c.valor,
           nullif(c.linha->>'ponto','')::numeric, coalesce(nullif(c.linha->>'data',''), c.linha->>'data_status')::date, c.status,
           jsonb_build_object('tipo', c.tipo, 'fonte', 'sf_api') || c.linha
      from _sfc c;
    delete from vendas_gerais v using _sfc c where c.tipo = 'venda' and v.id = c.id;
    delete from vendedoras_analise v using _sfc c where c.tipo = 'analise' and v.id = c.id;
  end if;
  return query select c.tipo, c.id, c.code, c.vendedor, c.valor, c.status from _sfc c;
end $function$;

-- 2) venda SF que entra sem tabela: completa pela proposta espelhada da API
create or replace function public.trg_sf_venda_completa() returns trigger
language plpgsql security definer set search_path = public as $function$
declare v_code int;
begin
  if normalizar_banco(new.banco) <> 'SEMPRE FACIL' or nullif(btrim(coalesce(new.tabela,'')),'') is not null then return new; end if;
  select s.code into v_code from sf_propostas_api s
   where s.status_code = 63
     and (s.contract_number = new.proposal_id_raw or s.code = new.adesao
          or (cpf_valido(new.cpf) and s.cpf = norm_cpf(new.cpf) and abs(s.valor_liquido - new.valor) < 0.02))
   limit 1;
  if v_code is not null then perform sf_aplica_venda(v_code); end if;
  return new;
exception when others then
  insert into triggers_falhas_log (gatilho, tabela, registro_id, erro, detalhe) values ('trg_sf_venda_completa', TG_TABLE_NAME, new.id, SQLERRM, SQLSTATE);
  return new;
end $function$;
drop trigger if exists zz_sf_venda_completa on public.vendas_gerais;
create trigger zz_sf_venda_completa after insert on public.vendas_gerais
for each row execute function public.trg_sf_venda_completa();

-- 3) estado da sincronizacao (para o dashboard)
create or replace function public.sf_sync_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'ultimo_ok', e.ultimo_ok, 'ultima_descoberta', e.ultima_descoberta, 'ultimo_status_http', e.ultimo_status,
    'erros_seguidos', e.erros, 'pausado_ate', e.pausa_ate,
    'propostas', (select count(*) from sf_propostas_api),
    'em_aberto', (select count(*) from sf_propostas_api where sf_status_final(status_code) is null),
    'integradas', (select count(*) from sf_propostas_api where status_code = 63),
    'canceladas', (select count(*) from sf_propostas_api where sf_status_final(status_code) = 'cancelado'),
    'atrasado', coalesce(e.ultimo_ok < now() - interval '15 minutes', true))
  from sf_sync_estado e where e.id = 1 $$;

revoke all on function public.sf_remove_canceladas(boolean) from public, anon, authenticated;
select cron.schedule('sf-remove-canceladas', '35 2 * * *', 'select * from public.sf_remove_canceladas(true)');
