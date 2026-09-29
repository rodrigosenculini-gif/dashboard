-- 1) mesma proposta (codigo) no mesmo banco nao entra duas vezes: completa a existente
create or replace function public.trg_venda_nao_duplica_codigo()
returns trigger language plpgsql as $function$
declare v_id bigint;
begin
  if new.proposal_id_raw is null or length(btrim(new.proposal_id_raw)) < 6 then return new; end if;
  select id into v_id from vendas_gerais
   where proposal_id_raw = new.proposal_id_raw
     and normalizar_banco(banco) = normalizar_banco(new.banco)
   limit 1;
  if v_id is null then return new; end if;
  update vendas_gerais set
    adesao   = coalesce(adesao, new.adesao),
    vendedor = coalesce(nullif(btrim(vendedor),''), new.vendedor),
    tabela   = coalesce(nullif(btrim(tabela),''), new.tabela),
    parcelas = coalesce(parcelas, new.parcelas),
    nome     = coalesce(nullif(btrim(nome),''), new.nome),
    whatsapp = coalesce(whatsapp, new.whatsapp),
    origem   = coalesce(origem, new.origem)
   where id = v_id;
  return null;   -- nao insere a copia
end $function$;
drop trigger if exists a1_venda_nao_duplica_codigo on public.vendas_gerais;
create trigger a1_venda_nao_duplica_codigo before insert on public.vendas_gerais
for each row execute function public.trg_venda_nao_duplica_codigo();

-- 2) canceladas SF: adesao so vale quando e coerente com o codigo SPF da venda
create or replace function public.sf_remove_canceladas(p_aplicar boolean default false)
returns table(tipo text, id bigint, code int, vendedor text, valor numeric, status text)
language plpgsql security definer set search_path = public as $function$
begin
  create temp table _sfc on commit drop as
  select 'venda'::text tipo, vg.id, s.code, vg.vendedor, vg.valor, s.status_nome status, to_jsonb(vg) linha
    from sf_propostas_api s
    join vendas_gerais vg on normalizar_banco(vg.banco) = 'SEMPRE FACIL'
     and ( vg.proposal_id_raw = s.contract_number
        or (vg.adesao = s.code and (vg.proposal_id_raw is null or vg.proposal_id_raw !~ '^SPF')) )
   where sf_status_final(s.status_code) = 'cancelado'
  union all
  select 'analise', va.id, s.code, va.vendedor, va.valor::numeric, s.status_nome, to_jsonb(va)
    from sf_propostas_api s
    join vendedoras_analise va on upper(va.banco) = 'SEMPRE FACIL'
     and ( va.proposal_id_raw = s.contract_number
        or (va.adesao = s.code and (va.proposal_id_raw is null or va.proposal_id_raw !~ '^SPF')) )
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
