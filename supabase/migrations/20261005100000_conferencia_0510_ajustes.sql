-- Conferencia geral 05/10 (ja aplicado no banco; registrado aqui):
--  - v8_aplica_operacao: o casamento por CPF+valor so vale para venda sem adesao
--    (casou um 2o emprestimo do mesmo CPF e a venda 11467354 nao entrava);
--  - sf_aplica_venda: tolerancia de valor 0,02 -> 1 (centavos de diferenca
--    entre analise e API geravam venda duplicada);
--  - rotina_lanca_pagas_staging: usa o ultimo status da adesao (nao o flag
--    "pago" de qualquer retrato) e respeita vendas_bloqueadas -- relancava
--    as desaverbadas da Facta toda noite;
--  - varredura_banco_periodo: venda bloqueada vira "ignorado";
--  - Sempre Facil passa a conferir pela API.
update public.bancos_catalogo set confere_por_api = true where normalizar_banco(banco) = 'SEMPRE FACIL';

CREATE OR REPLACE FUNCTION public.rotina_lanca_pagas_staging(p_banco text DEFAULT 'FACTA'::text, p_dias integer DEFAULT 45, p_aplicar boolean DEFAULT false)
 RETURNS TABLE(acao text, qtd bigint, valor numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_payload jsonb;
begin
  -- ultimo retrato de cada adesao no periodo (pago ou nao: o ultimo manda)
  with ultimo as (
    select distinct on (s.adesao)
      s.adesao, s.cpf, s.valor_banco, s.tabela_banco, s.parcelas_banco, s.status_banco,
      txt_para_data(coalesce(s.resposta_bruta->>'data_pgto_cliente',
                             s.resposta_bruta->>'data_movimento')) as d,
      s.resposta_bruta->>'nome_cliente' as nome
    from conferencia_bancos_staging s
    where normalizar_banco(s.banco) = normalizar_banco(p_banco)
      and s.criado_em >= now() - make_interval(days => p_dias)
      and s.adesao is not null
      and coalesce(s.valor_banco,0) > 0
    order by s.adesao, s.criado_em desc
  )
  select jsonb_agg(jsonb_build_object(
           'proposal_id', u.adesao::text, 'cpf', u.cpf, 'valor', u.valor_banco::text,
           'parcelas', u.parcelas_banco::text, 'tabela', u.tabela_banco,
           'nome', u.nome, 'data', u.d::text, 'status', u.status_banco))
    into v_payload
  from ultimo u
  where u.d is not null and status_banco_eh_pago(u.status_banco) and not venda_bloqueada(p_banco, u.adesao::text)
    -- so o que ainda nao existe; a propria varredura revalida, isto e so
    -- para nao mandar milhares de linhas a toa
    and not exists (select 1 from vendas_gerais vg where vg.adesao = u.adesao);

  if v_payload is null then
    return query select 'nada a fazer'::text, 0::bigint, 0::numeric;
    return;
  end if;

  return query
  select r.acao, count(*)::bigint, coalesce(sum(r.valor),0)::numeric
  from varredura_banco_periodo(p_banco, v_payload, p_aplicar) r
  group by r.acao;
end $function$;

CREATE OR REPLACE FUNCTION public.sf_aplica_venda(p_code integer)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s record; v_id bigint; v_data date; v_mes date := date_trunc('month', hoje_sp())::date; v_cpf text;
        v_raw_ant text; v_ades_ant bigint; v_cpf_ant text; v_corte date;
begin
  select * into s from sf_propostas_api where code = p_code;
  if s.code is null or s.status_code <> 63 then return null; end if;
  v_data := coalesce(nullif(s.data_desembolso,'')::date, nullif(s.data_credito,'')::date, s.status_data::date, hoje_sp());
  v_cpf := case when cpf_valido(s.cpf) then norm_cpf(s.cpf) end;
  select id, proposal_id_raw, adesao, norm_cpf(cpf) into v_id, v_raw_ant, v_ades_ant, v_cpf_ant from vendas_gerais
   where normalizar_banco(banco) = 'SEMPRE FACIL'
     and (proposal_id_raw = s.contract_number or adesao = s.code
          or (v_cpf is not null and norm_cpf(cpf) = v_cpf and abs(valor - s.valor_liquido) < 1))
   order by (proposal_id_raw = s.contract_number) desc nulls last, (adesao = s.code) desc nulls last limit 1;
  if v_id is null then
    if venda_bloqueada('SEMPRE FACIL', s.code::text) then return null; end if;
    v_corte := case when extract(day from hoje_sp()) > 10 then v_mes else (v_mes - interval '1 month')::date end;
    if v_data < v_corte then return null; end if;
    insert into vendas_gerais (banco, adesao, proposal_id_raw, cpf, nome, valor, parcelas, tabela, data, origem)
    values ('SEMPRE FACIL', s.code, s.contract_number, v_cpf, s.nome, s.valor_liquido, s.parcelas, s.tabela, v_data, 'sf_api')
    returning id into v_id;
    return v_id;
  end if;
  update vendedoras_analise va
     set adesao = coalesce(va.adesao, s.code),
         proposal_id_raw = case when va.proposal_id_raw is null or va.proposal_id_raw !~ '^SPF' then s.contract_number else va.proposal_id_raw end
   where upper(va.banco) = 'SEMPRE FACIL'
     and ( (v_raw_ant is not null and va.proposal_id_raw = v_raw_ant)
        or (v_ades_ant is not null and va.adesao = v_ades_ant and va.cpf = v_cpf_ant)
        or (v_cpf is not null and va.cpf = v_cpf and abs(va.valor::numeric - s.valor_liquido) < 1) );
  update vendas_gerais set
    tabela = coalesce(s.tabela, tabela), parcelas = coalesce(s.parcelas, parcelas), adesao = coalesce(adesao, s.code),
    proposal_id_raw = case when proposal_id_raw is null or proposal_id_raw !~ '^SPF' then s.contract_number else proposal_id_raw end,
    cpf = case when not cpf_valido(cpf) then coalesce(v_cpf, cpf) else cpf end,
    nome = coalesce(nullif(btrim(nome),''), s.nome),
    data = case when data >= v_mes and v_data >= v_mes then v_data else data end
  where id = v_id;
  return v_id;
end;
$function$;

-- v8_aplica_operacao: igual a 20261002130000_v8_portal.sql, so muda o casamento
CREATE OR REPLACE FUNCTION public.v8_aplica_operacao(p_contrato text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o record; v_id bigint; v_mes date := date_trunc('month', hoje_sp())::date; v_corte date;
        v_tab text; v_origem text; v_n int;
begin
  select * into o from v8_operacoes_portal where contrato = p_contrato;
  if o.contrato is null or o.detalhe_em is null then return 'sem detalhe'; end if;
  v_corte := case when extract(day from hoje_sp()) > 10 then v_mes else (v_mes - interval '1 month')::date end;
  v_tab := case when o.seguro then 'CLT ACELERA - COM SEGURO' else 'CLT ACELERA - SEM SEGURO' end;
  if o.status = 'paid' then
    update propostas_bancos set
      valor = coalesce(valor, o.valor), parcelas = coalesce(parcelas, o.parcelas),
      status_anterior = case when status is distinct from 'LIQUIDATED_TO_CUSTOMER' then status else status_anterior end,
      status = 'LIQUIDATED_TO_CUSTOMER', pago = true, cancelado = false,
      data_pagamento = coalesce(data_pagamento, o.pago_em), atualizado_em = now()
     where normalizar_banco(banco) = 'V8' and proposal_number = o.contrato;
    select id into v_id from vendas_gerais
     where normalizar_banco(banco) = 'V8'
       and (adesao::text = o.contrato
            or (adesao is null and o.cpf <> '' and norm_cpf(cpf) = o.cpf and abs(valor - o.valor) < 1 and data >= v_corte))
     order by (adesao::text = o.contrato and norm_cpf(cpf) = o.cpf) desc nulls last, (adesao::text = o.contrato) desc nulls last, id limit 1;
    if v_id is null then
      if venda_bloqueada('V8', o.contrato) then return 'bloqueada'; end if;
      if coalesce(o.pago_em, hoje_sp()) < v_corte then return 'fora do periodo'; end if;
      select case when p.id is not null then 'vendeai' end into v_origem
        from propostas_bancos p where normalizar_banco(p.banco) = 'V8' and p.proposal_number = o.contrato limit 1;
      if v_origem is null then
        select nullif(btrim(d.origem),'') into v_origem from disparochat d
         where d.cpf is not null and norm_cpf(d.cpf::text) = o.cpf order by d.id desc limit 1;
      end if;
      insert into vendas_gerais (data, banco, adesao, cpf, nome, valor, tabela, parcelas, seguro, proposal_id_raw, origem)
      values (coalesce(o.pago_em, hoje_sp()), 'V8', (case when o.contrato ~ '^[0-9]+$' then o.contrato::bigint end), o.cpf, o.nome, o.valor, v_tab, o.parcelas,
              case when o.seguro then 'sim' else 'nao' end, o.contrato, v_origem)
      returning id into v_id;
      update propostas_bancos set lancado_em_vendas = true, lancado_em = now()
       where normalizar_banco(banco) = 'V8' and proposal_number = o.contrato;
      return 'lancada ' || v_id;
    end if;
    update vendas_gerais set
      tabela = case when coalesce(tabela,'') = '' or tabela ~* '^CLT ACELERA' then v_tab else tabela end,
      seguro = case when o.seguro then 'sim' else 'nao' end,
      parcelas = coalesce(o.parcelas, parcelas),
      adesao = coalesce(adesao, (case when o.contrato ~ '^[0-9]+$' then o.contrato::bigint end)),
      data = case when data >= v_mes and coalesce(o.pago_em, data) >= v_mes then coalesce(o.pago_em, data) else data end
     where id = v_id
       and (coalesce(tabela,'') = '' or tabela ~* '^CLT ACELERA' or parcelas is null or adesao is null);
    update propostas_bancos set lancado_em_vendas = true
     where normalizar_banco(banco) = 'V8' and proposal_number = o.contrato and not lancado_em_vendas;
    return 'ok ' || v_id;
  end if;
  if o.status = 'canceled' and 'paid' = any(o.historico) then
    update propostas_bancos set
      status_anterior = case when status is distinct from 'ESTORNADO - PAGO E CANCELADO' then status else status_anterior end,
      status = 'ESTORNADO - PAGO E CANCELADO', pago = false, cancelado = true, atualizado_em = now()
     where normalizar_banco(banco) = 'V8' and proposal_number = o.contrato;
    insert into vendas_canceladas_removidas_log (venda_id, cpf, banco, adesao, valor, ponto, data, status_api, linha)
    select v.id, v.cpf, v.banco, v.adesao::text, v.valor, v.ponto, v.data, 'ESTORNADO - PAGO E CANCELADO (portal V8)', to_jsonb(v)
      from vendas_gerais v where normalizar_banco(v.banco) = 'V8' and v.adesao::text = o.contrato and v.data >= v_corte;
    insert into vendas_canceladas_removidas_log (venda_id, cpf, banco, adesao, valor, ponto, data, status_api, linha)
    select null, va.cpf, va.banco, va.adesao::text, va.valor::numeric, null, va.data_status,
           'ESTORNADO - PAGO E CANCELADO (portal V8)', jsonb_build_object('tipo','analise') || to_jsonb(va)
      from vendedoras_analise va where upper(va.banco) = 'V8' and va.adesao::text = o.contrato and va.data_status >= v_corte;
    delete from vendedoras_analise va where upper(va.banco) = 'V8' and va.adesao::text = o.contrato and va.data_status >= v_corte;
    delete from vendas_gerais v where normalizar_banco(v.banco) = 'V8' and v.adesao::text = o.contrato and v.data >= v_corte;
    get diagnostics v_n = row_count;
    return 'estornada (' || v_n || ' venda removida)';
  end if;
  return 'nada';
end;
$function$;

CREATE OR REPLACE FUNCTION public.varredura_banco_periodo(p_banco text, p_contratos jsonb, p_aplicar boolean DEFAULT false)
 RETURNS TABLE(proposal_id text, cpf text, valor numeric, parcelas integer, tabela text, acao text, motivo text, peso_previsto numeric, venda_id bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r jsonb; v_banco text := normalizar_banco(p_banco);
  v_id text; v_cpf text; v_valor numeric; v_parc int; v_tab text; v_nome text; v_data date; v_status text;
  v_venda bigint; v_prop bigint; v_peso numeric; v_adesao bigint;
begin
  if banco_bloqueado(p_banco) then return; end if;

  for r in select * from jsonb_array_elements(coalesce(p_contratos,'[]'::jsonb)) loop
    v_id   := nullif(btrim(coalesce(r->>'proposal_id', r->>'contrato', r->>'adesao','')),'');
    v_cpf  := nullif(lpad(regexp_replace(coalesce(r->>'cpf',''),'\D','','g'),11,'0'),'00000000000');
    v_valor:= nullif(regexp_replace(coalesce(r->>'valor',''),'[^0-9.\-]','','g'),'')::numeric;
    v_parc := nullif(regexp_replace(coalesce(r->>'parcelas',''),'\D','','g'),'')::int;
    v_tab  := nullif(btrim(coalesce(r->>'tabela','')),'');
    v_nome := nullif(btrim(coalesce(r->>'nome','')),'');
    v_status := nullif(btrim(coalesce(r->>'status','')),'');
    v_adesao := case when v_id ~ '^\d{1,18}$' then v_id::bigint else null end;
    begin v_data := coalesce(nullif(r->>'data','')::date, hoje_sp());
    exception when others then v_data := hoje_sp(); end;

    proposal_id := v_id; cpf := v_cpf; valor := v_valor; parcelas := v_parc; tabela := v_tab;
    acao := null; motivo := null; peso_previsto := null; venda_id := null;

    if v_id is null then acao := 'rejeitado'; motivo := 'sem identificador';
    elsif v_cpf is null then acao := 'rejeitado'; motivo := 'CPF invalido';
    elsif v_valor is null or not (v_valor > 0) then acao := 'rejeitado'; motivo := 'valor invalido';
    end if;

    -- status atual vindo da listagem do banco: registra quando difere do ultimo
    -- consultado, para a rotina de canceladas nao decidir por consulta velha
    if acao is null and v_status is not null and p_aplicar
       and v_status is distinct from venda_status_banco(v_banco, v_id) then
      insert into consultas_bancos_log (banco, adesao, cpf, origem, sucesso, encontrado,
                                        valor_banco, tabela_banco, parcelas_banco, status_banco)
      values (v_banco, v_id, v_cpf, 'varredura', true, true, v_valor, v_tab, v_parc, v_status);
    end if;

    if acao is null then
      select g.id into v_venda from vendas_gerais g
       where g.proposal_id_raw = v_id
          or (v_adesao is not null and g.adesao = v_adesao and g.cpf = v_cpf)
          or (lpad(regexp_replace(coalesce(g.cpf,''),'\D','','g'),11,'0') = v_cpf
              and round(coalesce(g.valor,0),2) = round(v_valor,2))
       limit 1;
      select p.id into v_prop from propostas_bancos p
       where normalizar_banco(p.banco) = v_banco and p.proposal_id = v_id limit 1;

      v_peso := calc_peso_vendas(v_banco, v_tab, v_parc, null, v_data);
      peso_previsto := v_peso;

      if v_venda is not null then
        acao := 'ja_existe'; motivo := 'venda ja lancada'; venda_id := v_venda;
      elsif venda_bloqueada(v_banco, v_id) then
        acao := 'ignorado'; motivo := 'venda bloqueada (removida por decisao do usuario)';
      elsif v_status is not null and not status_banco_eh_pago(v_status) then
        -- 01/10: o lote do n8n trazia "AGUARDA PAGAMENTO" como pago
        acao := 'ignorado'; motivo := 'status nao e pagamento: ' || v_status;
      elsif coalesce(v_status,'') ~* 'CANCEL|NEGAD|REPROV|REJEIT'
         or coalesce(venda_status_banco(v_banco, v_id),'') ~* 'CANCEL|NEGAD|REPROV|REJEIT' then
        -- 30/09: pago e depois cancelado (desembolso nao concretizado). Antes a venda
        -- era reinserida toda varredura e removida toda noite (ciclo de 14 dias).
        acao := 'ignorado'; motivo := 'cancelado no banco depois do pagamento';
        if p_aplicar then
          update propostas_bancos set pago = false, cancelado = true, atualizado_em = now()
           where normalizar_banco(banco) = v_banco and propostas_bancos.proposal_id = v_id;
        end if;
      else
        acao := case when v_prop is null then 'inserir (sem proposta)' else 'inserir (proposta existia)' end;
        motivo := 'pago no banco e ausente em vendas_gerais';
        if p_aplicar then
          if v_prop is null then
            begin
              insert into propostas_bancos (banco, proposal_id, cpf, nome, valor, parcelas, tabela_nome,
                     status, pago, origem, criado_em)
              values (v_banco, v_id, v_cpf, v_nome, v_valor, v_parc, v_tab,
                     coalesce(v_status,'PAGO'), true, 'varredura', now());
            exception when others then null; end;
          else
            update propostas_bancos set pago = true, lancado_em_vendas = true, atualizado_em = now() where id = v_prop;
          end if;
          begin
            insert into vendas_gerais (data, banco, cpf, nome, valor, tabela, parcelas, proposal_id_raw, adesao, origem)
            values (v_data, v_banco, v_cpf, v_nome, v_valor, v_tab, v_parc, v_id, v_adesao, 'varredura')
            returning id into venda_id;
            update propostas_bancos set lancado_em_vendas = true, lancado_em = now()
             where normalizar_banco(banco) = v_banco and propostas_bancos.proposal_id = v_id;
          exception when others then
            acao := 'erro'; motivo := left(SQLERRM,200);
          end;
        end if;
      end if;
    end if;
    return next;
  end loop;
end $function$;
