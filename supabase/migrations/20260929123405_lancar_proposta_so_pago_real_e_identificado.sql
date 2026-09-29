CREATE OR REPLACE FUNCTION public.conferir_e_lancar_proposta(p_banco text, p_proposal_id text, p_norm jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_enc boolean := coalesce((p_norm->>'encontrado')::boolean, false);
  v_status text := coalesce(p_norm->>'status_banco','');
  v_pago boolean; v_cancel boolean;
  v_cpf text; v_nome text; v_valor numeric; v_parc int; v_tab_api text; v_tab text; v_vend text;
  v_adesao bigint; v_raw text; v_venda_id bigint; v_ja boolean; v_tab_prop text; v_data_banco date;
  v_num_prop text; v_cpf_prop text;
begin
  if banco_bloqueado(p_banco) then
    return jsonb_build_object('ok', false, 'motivo', 'banco bloqueado');
  end if;

  update propostas_bancos set ultima_consulta_em = now(), resposta_bruta = p_norm
   where banco = p_banco and proposal_id = p_proposal_id
   returning tabela_nome, data_pagamento, proposal_number, cpf
        into v_tab_prop, v_data_banco, v_num_prop, v_cpf_prop;

  if not v_enc then
    return jsonb_build_object('ok',true,'acao','nao encontrado na API','banco',p_banco,'proposal_id',p_proposal_id);
  end if;

  -- 29/09: so e pago o que o banco ja pagou. "Etapa de Pagamento", "Pendencia Pagamento"
  -- (Soma) e "68 - AVERBADO - AGUARDA PAGAMENTO" (Facta) ainda estao na esteira.
  v_pago   := v_status ~* '\mpag[oa]\M|integrad|liquidat|credited|creditad|desembols'
              and v_status !~* 'an[aá]lise|aguard|pend|etapa|cancel|reprov|recus|negad';
  v_cancel := v_status ~* 'cancel|reprov|recus|negad|rejeit';

  v_cpf    := pan_norm_cpf(coalesce(p_norm->>'cpf_banco', ''));
  if v_cpf is null or v_cpf = '00000000000' then
    v_cpf := nullif(pan_norm_cpf(coalesce(v_cpf_prop,'')), '00000000000');   -- Soma: API nao devolve CPF
  end if;
  v_nome   := p_norm->>'nome_banco';
  v_valor  := nullif(p_norm->>'valor_banco','')::numeric;
  v_parc   := nullif(p_norm->>'parcelas_banco','')::int;
  v_tab_api:= nullif(p_norm->>'tabela_banco','');
  if p_proposal_id ~ '^\d+$' then
    v_adesao := p_proposal_id::bigint;
  else
    v_raw    := p_proposal_id;                                                -- UUID (Soma, v8, Novo Saque)
    v_adesao := nullif(regexp_replace(coalesce(v_num_prop, p_norm->>'proNumBancarizadora', ''), '\D', '', 'g'), '')::bigint;
  end if;

  v_tab := case when v_tab_api is null or v_tab_api ~* '^esteira' then v_tab_prop else v_tab_api end;

  update propostas_bancos
     set status_anterior = case when status is distinct from v_status then status else status_anterior end,
         status = v_status,
         cpf = coalesce(v_cpf, cpf), nome = coalesce(v_nome, nome),
         valor = coalesce(v_valor, valor), parcelas = coalesce(v_parc, parcelas),
         tabela_nome = coalesce(v_tab, tabela_nome),
         pago = v_pago, cancelado = v_cancel,
         data_pagamento = case when v_pago then coalesce(data_pagamento, hoje_sp()) else data_pagamento end,
         atualizado_em = now()
   where banco = p_banco and proposal_id = p_proposal_id
   returning lancado_em_vendas, vendedor, data_pagamento into v_ja, v_vend, v_data_banco;

  if not v_pago then
    return jsonb_build_object('ok',true,'acao',case when v_cancel then 'cancelado' else 'pendente' end,'status',v_status);
  end if;
  if coalesce(v_ja,false) then
    return jsonb_build_object('ok',true,'acao','pago (ja lancado)','status',v_status);
  end if;
  if v_valor is null then
    return jsonb_build_object('ok',false,'acao','pago sem valor - nao lancado','status',v_status);
  end if;

  select id into v_venda_id from vendas_gerais
   where (v_adesao is not null and adesao = v_adesao and normalizar_banco(banco) = normalizar_banco(p_banco))
      or (v_raw is not null and proposal_id_raw = v_raw)
      or (v_cpf is not null and pan_norm_cpf(cpf) = v_cpf
          and normalizar_banco(banco) = normalizar_banco(p_banco)
          and round(coalesce(valor,0),2) = round(v_valor,2))
   order by created_at desc limit 1;

  if v_venda_id is null then
    insert into vendas_gerais (adesao, proposal_id_raw, cpf, nome, banco, tabela, parcelas, valor, data, vendedor)
    values (v_adesao, v_raw, v_cpf, v_nome, p_banco, v_tab, v_parc, v_valor, coalesce(v_data_banco, hoje_sp()), v_vend)
    returning id into v_venda_id;
  else
    update vendas_gerais set
      valor = v_valor, parcelas = coalesce(v_parc, parcelas),
      tabela = case when v_tab is not null and (tabela is null or tabela ~* '^esteira' or tabela ~* '^[0-9a-f]{8}-') then v_tab else tabela end,
      adesao = coalesce(adesao, v_adesao), proposal_id_raw = coalesce(proposal_id_raw, v_raw),
      cpf = case when coalesce(pan_norm_cpf(cpf),'00000000000') = '00000000000' then coalesce(v_cpf, cpf) else cpf end,
      nome = coalesce(nome, v_nome), vendedor = coalesce(vendedor, v_vend)
    where id = v_venda_id;
  end if;

  update propostas_bancos set lancado_em_vendas = true, lancado_em = now()
   where banco = p_banco and proposal_id = p_proposal_id;

  return jsonb_build_object('ok',true,'acao','pago e lancado','venda_id',v_venda_id,'valor',v_valor,'parcelas',v_parc,'tabela',v_tab);
end $function$;
