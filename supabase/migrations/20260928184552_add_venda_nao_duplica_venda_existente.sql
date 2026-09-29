CREATE OR REPLACE FUNCTION public.dashboard_vendedoras_add_venda(p_vendedor text, p_adesao bigint, p_cpf text, p_nome text, p_valor numeric, p_banco text, p_tabela text DEFAULT NULL::text, p_data_pagamento date DEFAULT NULL::date, p_parcelas integer DEFAULT NULL::integer, p_seguro text DEFAULT NULL::text, p_proposal_id_raw text DEFAULT NULL::text)
 RETURNS TABLE(ok boolean, mensagem text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_cpf text;
  v_data date;
  v_adesao bigint := p_adesao;
  v_raw text := nullif(btrim(coalesce(p_proposal_id_raw,'')), '');
  v_vg_id bigint; v_vg_adesao bigint; v_vg_data date; v_vg_vend text;
begin
  -- UUID no lugar da adesao: resolve o numero pela ultima consulta feita
  if v_adesao is null and v_raw is not null then
    select nullif(jsonb_desembrulha(l.resposta_bruta)->>'proNumBancarizadora','')::bigint
      into v_adesao
    from consultas_bancos_log l
    where l.adesao = v_raw
      and jsonb_desembrulha(l.resposta_bruta)->>'proNumBancarizadora' ~ '^\d+$'
    order by l.criado_em desc limit 1;
  end if;

  if p_vendedor is null or p_cpf is null or p_nome is null
     or p_valor is null or p_banco is null
     or trim(p_cpf) = '' or trim(p_nome) = '' or trim(p_banco) = '' then
    return query select false, 'Preencha adesão, cpf, nome, valor e banco.';
    return;
  end if;
  if v_adesao is null and v_raw is null then
    return query select false, 'Informe a adesão (ou o Public ID, no Soma).';
    return;
  end if;

  v_cpf := norm_cpf(p_cpf);
  v_data := coalesce(p_data_pagamento, (now() at time zone 'America/Sao_Paulo')::date);

  -- 28/09: a venda pode ja existir com OUTRO identificador (ex.: VendeAI grava
  -- SPF.../adesao e a vendedora informa o UUID do portal). Procura por
  -- adesao, UUID ou CPF+banco+valor (+-7 dias) antes de criar outra.
  select id, adesao, data, nullif(btrim(vendedor),'')
    into v_vg_id, v_vg_adesao, v_vg_data, v_vg_vend
  from vendas_gerais
  where norm_cpf(cpf) = v_cpf
    and ( (v_adesao is not null and adesao = v_adesao)
       or (v_raw is not null and proposal_id_raw = v_raw)
       or (normalizar_banco(banco) = normalizar_banco(p_banco)
           and abs(valor - p_valor) < 0.02
           and data between v_data - 7 and v_data + 7) )
  order by (v_adesao is not null and adesao = v_adesao) desc,
           (v_raw is not null and proposal_id_raw = v_raw) desc,
           abs(data - v_data)
  limit 1;

  if v_vg_id is not null then
    -- venda existente de OUTRA vendedora: nao toma, avisa
    if v_vg_vend is not null and upper(v_vg_vend) <> upper(btrim(p_vendedor)) then
      return query select false, format('Essa venda já está no nome de %s.', v_vg_vend);
      return;
    end if;
    v_adesao := coalesce(v_adesao, v_vg_adesao);
    -- sem data informada, vale a data em que o banco pagou (a da venda)
    if p_data_pagamento is null then v_data := v_vg_data; end if;
  end if;

  if exists (
    select 1 from vendedoras_analise
    where norm_cpf(cpf) = v_cpf
      and (coalesce(adesao,-1) = coalesce(v_adesao,-2)
           or (v_raw is not null and proposal_id_raw = v_raw))
  ) then
    return query select false, 'Já existe uma venda com esse CPF e adesão.';
    return;
  end if;

  insert into vendedoras_analise (data_status, banco, adesao, cpf, nome, vendedor, valor, tabela, data_pagamento, parcelas, seguro, proposal_id_raw)
  values (v_data, p_banco, v_adesao, v_cpf, p_nome, p_vendedor, p_valor, p_tabela, v_data, p_parcelas, p_seguro, v_raw);

  if v_vg_id is null then
    insert into vendas_gerais (data, banco, adesao, cpf, nome, valor, tabela, parcelas, seguro, proposal_id_raw)
    values (v_data, p_banco, v_adesao, v_cpf, p_nome, p_valor, p_tabela, p_parcelas, p_seguro, v_raw);
  else
    update vendas_gerais
       set vendedor = coalesce(nullif(btrim(vendedor),''), p_vendedor),
           tabela   = coalesce(nullif(btrim(tabela),''), p_tabela),
           parcelas = coalesce(parcelas, p_parcelas),
           seguro   = coalesce(seguro, p_seguro)
     where id = v_vg_id;
  end if;

  return query select true,
    case when v_vg_id is not null then 'Venda vinculada à venda já confirmada pelo banco.'
         when v_adesao is not null and p_adesao is null then format('Venda adicionada (nº da proposta no banco: %s).', v_adesao)
         else 'Venda adicionada com sucesso.' end;
end;
$function$;

-- versao antiga (10 parametros) passa a usar a mesma regra
CREATE OR REPLACE FUNCTION public.dashboard_vendedoras_add_venda(p_vendedor text, p_adesao bigint, p_cpf text, p_nome text, p_valor numeric, p_banco text, p_tabela text DEFAULT NULL::text, p_data_pagamento date DEFAULT NULL::date, p_parcelas integer DEFAULT NULL::integer, p_seguro text DEFAULT NULL::text)
 RETURNS TABLE(ok boolean, mensagem text)
 LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select * from public.dashboard_vendedoras_add_venda(p_vendedor, p_adesao, p_cpf, p_nome, p_valor, p_banco, p_tabela, p_data_pagamento, p_parcelas, p_seguro, null::text);
$function$;
