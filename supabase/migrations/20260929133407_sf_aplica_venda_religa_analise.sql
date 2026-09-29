create or replace function public.sf_aplica_venda(p_code int) returns bigint
language plpgsql security definer set search_path = public as $function$
declare s record; v_id bigint; v_data date; v_mes date := date_trunc('month', hoje_sp())::date; v_cpf text;
        v_raw_ant text; v_ades_ant bigint; v_cpf_ant text;
begin
  select * into s from sf_propostas_api where code = p_code;
  if s.code is null or s.status_code <> 63 then return null; end if;
  v_data := coalesce(nullif(s.data_desembolso,'')::date, nullif(s.data_credito,'')::date, s.status_data::date, hoje_sp());
  v_cpf := case when cpf_valido(s.cpf) then norm_cpf(s.cpf) end;

  -- 1) codigo SPF / adesao; 2) CPF + valor (vendas cadastradas com o UUID do portal)
  select id, proposal_id_raw, adesao, norm_cpf(cpf) into v_id, v_raw_ant, v_ades_ant, v_cpf_ant from vendas_gerais
   where normalizar_banco(banco) = 'SEMPRE FACIL'
     and (proposal_id_raw = s.contract_number or adesao = s.code
          or (v_cpf is not null and norm_cpf(cpf) = v_cpf and abs(valor - s.valor_liquido) < 0.02))
   order by (proposal_id_raw = s.contract_number) desc nulls last, (adesao = s.code) desc nulls last limit 1;

  if v_id is null then
    insert into vendas_gerais (banco, adesao, proposal_id_raw, cpf, nome, valor, parcelas, tabela, data, origem)
    values ('SEMPRE FACIL', s.code, s.contract_number, v_cpf, s.nome, s.valor_liquido, s.parcelas, s.tabela, v_data, 'sf_api')
    returning id into v_id;
    return v_id;
  end if;

  -- a analise da vendedora acompanha a venda (senao fica presa ao UUID antigo)
  update vendedoras_analise va
     set adesao = coalesce(va.adesao, s.code),
         proposal_id_raw = case when va.proposal_id_raw is null or va.proposal_id_raw !~ '^SPF' then s.contract_number else va.proposal_id_raw end
   where upper(va.banco) = 'SEMPRE FACIL'
     and ( (v_raw_ant is not null and va.proposal_id_raw = v_raw_ant)
        or (v_ades_ant is not null and va.adesao = v_ades_ant and va.cpf = v_cpf_ant)
        or (v_cpf is not null and va.cpf = v_cpf and abs(va.valor::numeric - s.valor_liquido) < 0.02) );

  update vendas_gerais set
    tabela = coalesce(s.tabela, tabela),
    parcelas = coalesce(s.parcelas, parcelas),
    adesao = coalesce(adesao, s.code),
    proposal_id_raw = case when proposal_id_raw is null or proposal_id_raw !~ '^SPF' then s.contract_number else proposal_id_raw end,
    cpf = case when not cpf_valido(cpf) then coalesce(v_cpf, cpf) else cpf end,
    nome = coalesce(nullif(btrim(nome),''), s.nome),
    data = case when data >= v_mes and v_data >= v_mes then v_data else data end
  where id = v_id;
  return v_id;
end $function$;
