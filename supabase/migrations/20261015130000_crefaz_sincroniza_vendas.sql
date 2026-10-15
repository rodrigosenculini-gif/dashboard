-- 15/10: vendas de energia do Crefaz fechadas pela IA (sessao IA Chatwoot expoe public.crefaz_vendas_pagas()).
-- Espelho a cada 10 min (cron crefaz-sincroniza-vendas) em propostas_bancos e vendas_gerais com as mesmas regras
-- dos outros bancos: so paga; cancelada depois de paga sai (log + vendas_bloqueadas); mes corrente (ou anterior
-- ate o dia 10); sem vendedora. Peso Crefaz 9-24 parcelas (1,65) cadastrado em tabela_pontos (1-8 = 1,30 ja existia).
insert into tabela_pontos (banco, produto, nome_tabela, regras_especificas, prazos, pontos, vigencia_inicio, ativo)
select 'CREFAZ','ENERGIA','EMPRÉSTIMO NA CONTA DE LUZ','9 a 24 parcelas (antes so no calculo legado).','9 a 24 parcelas',1.65,'2026-09-01',true
where not exists (select 1 from tabela_pontos where normalizar_banco(banco)='CREFAZ' and prazos ~ '9');

create or replace function public.crefaz_sincroniza_vendas()
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare c record; v_id bigint; v_data date; v_mes date := date_trunc('month', hoje_sp())::date; v_corte date;
        v_ins int := 0; v_rem int := 0; v_ok int := 0; v_tab text := 'EMPRÉSTIMO NA CONTA DE LUZ';
begin
  v_corte := case when extract(day from hoje_sp()) > 10 then v_mes else (v_mes - interval '1 month')::date end;
  for c in select * from public.crefaz_vendas_pagas(current_date - 90) loop
    v_data := (c.data_pagamento at time zone 'America/Sao_Paulo')::date;

    -- proposta: cria ou atualiza
    if exists (select 1 from propostas_bancos p where normalizar_banco(p.banco)='CREFAZ' and p.proposal_id = c.proposta_id) then
      update propostas_bancos set proposal_number = c.proposta_id, cpf = coalesce(cpf, c.cpf), nome = coalesce(nome, c.nome),
             valor = coalesce(c.valor_liberado, valor), parcelas = coalesce(c.parcelas, parcelas), tabela_nome = coalesce(tabela_nome, v_tab),
             status = coalesce(c.situacao_crefaz, status), pago = not c.cancelada, cancelado = c.cancelada,
             data_pagamento = coalesce(data_pagamento, v_data), atualizado_em = now()
       where normalizar_banco(banco)='CREFAZ' and proposal_id = c.proposta_id;
    else
      insert into propostas_bancos (banco, proposal_id, proposal_number, cpf, nome, valor, parcelas, tabela_nome, status, pago, cancelado, data_pagamento, origem, produto, campanha, criado_em)
      values ('CREFAZ', c.proposta_id, c.proposta_id, c.cpf, c.nome, c.valor_liberado, c.parcelas, v_tab, c.situacao_crefaz, not c.cancelada, c.cancelada, v_data, 'ia_crefaz', 'ENERGIA', c.campanha, now());
    end if;

    select v.id into v_id from vendas_gerais v
     where normalizar_banco(v.banco)='CREFAZ' and (v.adesao::text = c.proposta_id or v.proposal_id_raw = c.proposta_id
            or (norm_cpf(v.cpf) = c.cpf and abs(v.valor - c.valor_liberado) < 1 and v.data >= v_data - 7))
     order by (v.adesao::text = c.proposta_id) desc, v.id limit 1;

    if c.cancelada then
      if v_id is not null then
        insert into vendas_canceladas_removidas_log (venda_id, cpf, banco, adesao, valor, ponto, data, status_api, linha)
        select v.id, v.cpf, v.banco, v.adesao::text, v.valor, v.ponto, v.data, 'CREFAZ ' || coalesce(c.situacao_crefaz,'cancelada') || ' depois de paga', to_jsonb(v) from vendas_gerais v where v.id = v_id;
        insert into vendas_canceladas_removidas_log (venda_id, cpf, banco, adesao, valor, ponto, data, status_api, linha)
        select null, va.cpf, va.banco, va.adesao::text, va.valor::numeric, null, va.data_status, 'CREFAZ ' || coalesce(c.situacao_crefaz,'cancelada') || ' depois de paga', jsonb_build_object('tipo','analise') || to_jsonb(va)
          from vendedoras_analise va where upper(va.banco)='CREFAZ' and va.adesao::text = c.proposta_id;
        delete from vendedoras_analise va where upper(va.banco)='CREFAZ' and va.adesao::text = c.proposta_id;
        delete from vendas_gerais where id = v_id;
        insert into vendas_bloqueadas (banco, chave, motivo) values ('CREFAZ', c.proposta_id, 'cancelada no Crefaz depois de paga (' || coalesce(c.situacao_crefaz,'') || ')') on conflict do nothing;
        v_rem := v_rem + 1;
      end if;
      continue;
    end if;

    if v_id is null then
      if venda_bloqueada('CREFAZ', c.proposta_id) or v_data < v_corte then continue; end if;
      insert into vendas_gerais (data, banco, adesao, proposal_id_raw, cpf, nome, valor, tabela, parcelas, origem, campanha)
      values (v_data, 'CREFAZ', c.proposta_id::bigint, c.proposta_id, c.cpf, c.nome, c.valor_liberado, v_tab, c.parcelas, c.origem, c.campanha)
      returning id into v_id;
      v_ins := v_ins + 1;
    else
      update vendas_gerais set adesao = coalesce(adesao, c.proposta_id::bigint), proposal_id_raw = coalesce(proposal_id_raw, c.proposta_id),
             tabela = coalesce(nullif(btrim(tabela),''), v_tab), parcelas = coalesce(parcelas, c.parcelas), nome = coalesce(nome, c.nome),
             origem = coalesce(origem, c.origem), campanha = coalesce(campanha, c.campanha)
       where id = v_id and (adesao is null or proposal_id_raw is null or nullif(btrim(tabela),'') is null or parcelas is null or nome is null or origem is null);
      v_ok := v_ok + 1;
    end if;
    update propostas_bancos set lancado_em_vendas = true, lancado_em = coalesce(lancado_em, now())
     where normalizar_banco(banco)='CREFAZ' and proposal_id = c.proposta_id and not coalesce(lancado_em_vendas, false);
  end loop;
  return jsonb_build_object('lancadas', v_ins, 'ja_existiam', v_ok, 'removidas', v_rem);
end $function$;
revoke all on function public.crefaz_sincroniza_vendas() from public, anon, authenticated;

select cron.schedule('crefaz-sincroniza-vendas', '*/10 * * * *', $$select public.crefaz_sincroniza_vendas()$$);
