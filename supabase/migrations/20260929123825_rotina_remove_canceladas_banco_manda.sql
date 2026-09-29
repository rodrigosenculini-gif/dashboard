CREATE OR REPLACE FUNCTION public.rotina_remove_canceladas(p_desde date DEFAULT ((now() - '60 days'::interval))::date, p_aplicar boolean DEFAULT false)
 RETURNS TABLE(venda_id bigint, cpf text, banco text, adesao text, valor numeric, ponto numeric, status_api text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  create temp table _canc on commit drop as
  select v.*, coalesce(nullif(a.s1,''), b.s2) as st_api
    from vendas_gerais v
    cross join lateral (select case when v.adesao is not null then coalesce(venda_status_banco(v.banco, v.adesao::text),'') else '' end s1) a
    left join lateral (
      select p.status s2, p.pago, p.proposal_id pid from propostas_bancos p
       where normalizar_banco(p.banco) = normalizar_banco(v.banco)
         and (p.proposal_id = v.proposal_id_raw or p.proposal_id = v.adesao::text or p.proposal_number = v.adesao::text)
       order by (p.proposal_id = v.proposal_id_raw) desc nulls last, p.atualizado_em desc nulls last limit 1) b on true
   where v.data >= p_desde
     and (v.adesao is not null or v.proposal_id_raw is not null)
     and (
       -- 1) o proprio banco diz cancelado, depois de qualquer pagamento
       ( a.s1 ~* 'CANCEL|NEGAD|REPROV|REJEIT'
         and coalesce((select max(l.criado_em) from consultas_bancos_log l where normalizar_banco(l.banco)=normalizar_banco(v.banco) and regexp_replace(coalesce(l.adesao,''),'\D','','g') = v.adesao::text and l.status_banco ~* 'CANCEL|NEGAD|REPROV|REJEIT'), 'epoch'::timestamptz)
           > coalesce((select max(l.criado_em) from consultas_bancos_log l where normalizar_banco(l.banco)=normalizar_banco(v.banco) and regexp_replace(coalesce(l.adesao,''),'\D','','g') = v.adesao::text and l.status_banco ~* '\mPAG[OA]\M|LIQUID|INTEGRAD'), 'epoch'::timestamptz) )
       -- 2) status da proposta (VendeAI/fila) SO quando o banco nao tem consulta propria dessa venda
       or ( a.s1 = ''
            and b.s2 ~* 'CANCEL|NEGAD|REPROV|REJEIT' and not coalesce(b.pago, false)
            and (v.proposal_id_raw is null or b.pid = v.proposal_id_raw or v.proposal_id_raw !~ '[A-Za-z]') )
     );

  create temp table _canc_an on commit drop as
  select va.*, b.status st_api
    from vendedoras_analise va
    join lateral (
      select p.status, p.pago from propostas_bancos p
       where normalizar_banco(p.banco) = normalizar_banco(va.banco)
         and (p.proposal_id = va.proposal_id_raw or p.proposal_id = va.adesao::text or p.proposal_number = va.adesao::text)
       order by p.atualizado_em desc nulls last limit 1) b on true
   where va.data_status >= p_desde
     and b.status ~* 'CANCEL|NEGAD|REPROV|REJEIT' and not coalesce(b.pago, false)
     and not exists (select 1 from vendas_gerais vg where (va.proposal_id_raw is not null and vg.proposal_id_raw = va.proposal_id_raw) or (va.cpf = norm_cpf(vg.cpf) and va.adesao = vg.adesao));

  if p_aplicar then
    insert into vendas_canceladas_removidas_log (venda_id, cpf, banco, adesao, valor, ponto, data, status_api, linha)
    select c.id, c.cpf, c.banco, coalesce(c.adesao::text, c.proposal_id_raw), c.valor, c.ponto, c.data, c.st_api, to_jsonb(c) from _canc c;
    delete from vendas_gerais v using _canc c where v.id = c.id;
    insert into vendas_canceladas_removidas_log (venda_id, cpf, banco, adesao, valor, ponto, data, status_api, linha)
    select null, c.cpf, c.banco, coalesce(c.adesao::text, c.proposal_id_raw), c.valor::numeric, null, c.data_status, c.st_api,
           jsonb_build_object('tipo','analise') || to_jsonb(c) from _canc_an c;
    delete from vendedoras_analise va using _canc_an c where va.id = c.id;
  end if;

  return query
    select c.id, c.cpf, c.banco, coalesce(c.adesao::text, c.proposal_id_raw), c.valor, c.ponto, c.st_api from _canc c
    union all
    select null::bigint, c.cpf, c.banco, coalesce(c.adesao::text, c.proposal_id_raw)||' (analise '||c.id||')', c.valor::numeric, null::numeric, c.st_api from _canc_an c;
end $function$;
