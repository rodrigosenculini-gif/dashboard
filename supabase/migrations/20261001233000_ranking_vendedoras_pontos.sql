-- Ranking de Vendedoras: passa a trazer os pontos (o overlay abre em pontos).
-- Pontos pela mesma ligacao analise -> venda da Meta por Vendedora
-- (CPF + adesao), para os numeros das duas abas baterem.
drop function if exists public.dashboard_vendedoras_ranking(date, date);
create function public.dashboard_vendedoras_ranking(p_date_from date default null, p_date_to date default null)
 returns table(vendedor text, valor_total numeric, qtd_total bigint, banco_top text, pontos_total numeric)
 language sql stable security definer
 set search_path to 'public'
as $function$
  with base as (
    select va.vendedor, va.banco, va.valor, va.cpf, va.adesao
      from vendedoras_analise va
     where va.vendedor is not null
       and (p_date_from is null or va.data_status >= p_date_from)
       and (p_date_to is null or va.data_status <= p_date_to)
  ),
  -- pontos somados por analise (subconsulta): um join direto multiplicaria a
  -- quantidade e o valor quando a analise casa com mais de uma venda
  agg as (
    select b.vendedor, coalesce(sum(b.valor), 0) as valor_total, count(*) as qtd_total,
           coalesce(sum((select sum(vg.ponto) from vendas_gerais vg
                           where norm_cpf(vg.cpf) = norm_cpf(b.cpf)
                             and coalesce(vg.adesao, -1) = coalesce(b.adesao, -1))), 0) as pontos_total
      from base b
     group by b.vendedor
  ),
  banco_rank as (
    select vendedor, banco, count(*) as qtd,
           row_number() over (partition by vendedor order by count(*) desc) as rn
      from base
     where banco is not null
     group by vendedor, banco
  )
  select a.vendedor, a.valor_total, a.qtd_total, br.banco, round(a.pontos_total, 2)
    from agg a
    left join banco_rank br on br.vendedor = a.vendedor and br.rn = 1
   order by a.pontos_total desc;
$function$;
grant execute on function public.dashboard_vendedoras_ranking(date, date) to anon;
