-- Regra unica de "o banco pagou" (01/10). Duas vendas falsas nasceram de status
-- que nao sao pagamento:
--  * Presenca "Falha no Desembolso - Ajustar dados bancarios": casava com
--    'desembols' e a lista de exclusao nao tinha 'falha'/'ajustar'
--    (conferir_e_lancar_proposta, venda 16247);
--  * Facta "68 - AVERBADO - AGUARDA PAGAMENTO": o filtro do n8n (Varredura
--    Facta) usava /pag[oa]/, que casa com PAGAmento, e varredura_banco_periodo
--    grava tudo que vem no lote (venda 16515).
create or replace function public.status_banco_eh_pago(p text)
 returns boolean language sql immutable as $$
  select coalesce(proposta_status_nome(p), '') ~* '\mpag[oa]\M|integrad|liquidat|credited|creditad|desembols|contrato pago'
     and coalesce(proposta_status_nome(p), '') !~* 'an[aá]lise|aguard|pend|etapa|cancel|reprov|recus|negad|rejeit|falha|ajustar|estorn|n[aã]o confirmad'
$$;

-- situacao da tela Propostas: problema no pagamento e Pendente; averbacao /
-- aguardando pagamento ainda esta em processamento -- mesmo com pago marcado
create or replace function public.proposta_situacao(p_status text, p_pago boolean, p_cancelado boolean)
 returns text language sql immutable as $$
  -- o texto do banco manda antes da marca de pago: cancelado/pendente/esteira
  select case
    when proposta_status_nome(p_status) ~* 'cancel|reprov|rejected|rejeit|estorn' then 'Cancelado'
    when proposta_status_nome(p_status) ~* 'falha|ajustar|n[aã]o confirmad|pend' then 'Pendente'
    when proposta_status_nome(p_status) ~* 'averba|aguarda pagamento|aguardando pagamento|etapa' then 'Em processamento'
    when coalesce(p_pago, false) then 'Pago'
    when coalesce(p_cancelado, false) then 'Cancelado'
    when proposta_status_nome(p_status) ~* 'assinatura|formalization|form dig' then 'Aguardando assinatura'
    when proposta_status_nome(p_status) ~* 'documento|regulariza|error' then 'Pendente'
    else 'Em processamento' end
$$;

-- conferir_e_lancar_proposta e varredura_banco_periodo passam a usar a regra
-- unica. Troca de trecho com verificacao: se o trecho nao existir, falha.
do $$
declare d text; novo text;
begin
  d := pg_get_functiondef('public.conferir_e_lancar_proposta'::regproc);
  novo := replace(d,
    $a$  v_pago   := v_status ~* '\mpag[oa]\M|integrad|liquidat|credited|creditad|desembols'
              and v_status !~* 'an[aá]lise|aguard|pend|etapa|cancel|reprov|recus|negad';$a$,
    $b$  v_pago   := status_banco_eh_pago(v_status);$b$);
  if novo = d then raise exception 'trecho do v_pago nao encontrado em conferir_e_lancar_proposta'; end if;
  execute novo;

  d := pg_get_functiondef('public.varredura_banco_periodo'::regproc);
  novo := replace(d,
    $a$      elsif coalesce(v_status,'') ~* 'CANCEL|NEGAD|REPROV|REJEIT'$a$,
    $b$      elsif v_status is not null and not status_banco_eh_pago(v_status) then
        -- 01/10: o lote do n8n trazia "AGUARDA PAGAMENTO" como pago
        acao := 'ignorado'; motivo := 'status nao e pagamento: ' || v_status;
      elsif coalesce(v_status,'') ~* 'CANCEL|NEGAD|REPROV|REJEIT'$b$);
  if novo = d then raise exception 'trecho do cancelado nao encontrado em varredura_banco_periodo'; end if;
  execute novo;
end $$;
