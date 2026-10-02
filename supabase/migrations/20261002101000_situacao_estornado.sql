-- Propostas: situacao "Estornado" para o que foi pago e depois desfeito
-- (desaverbado apos pagamento, reembolso, estorno, pago e cancelado). Antes caia
-- em Cancelado, e a Facta desaverbada aparecia como Pago (o registro da proposta
-- ficou com o status antigo).
create or replace function public.proposta_situacao(p_status text, p_pago boolean, p_cancelado boolean)
 returns text
 language sql
 immutable
as $function$
  select case
    when proposta_status_nome(p_status) ~* 'desaverb|reembols|estorn' then 'Estornado'
    when proposta_status_nome(p_status) ~* 'cancel|reprov|rejected|rejeit' then 'Cancelado'
    when proposta_status_nome(p_status) ~* 'falha|ajustar|n[aã]o confirmad|pend' then 'Pendente'
    when proposta_status_nome(p_status) ~* 'averba|aguarda pagamento|aguardando pagamento|etapa' then 'Em processamento'
    when coalesce(p_pago, false) then 'Pago'
    when coalesce(p_cancelado, false) then 'Cancelado'
    when proposta_status_nome(p_status) ~* 'assinatura|formalization|form dig' then 'Aguardando assinatura'
    when proposta_status_nome(p_status) ~* 'documento|regulariza|error' then 'Pendente'
    else 'Em processamento' end
$function$;
