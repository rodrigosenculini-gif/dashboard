-- "Integrado + Reembolso Solicitado" (Sempre Facil) e "DESAVERBADO APOS PAGAMENTO"
-- (Facta) foram pagas e depois desfeitas: nao contam como pagas. 02/10: a 14065
-- (SF) e cinco Facta desaverbadas sairam das vendas por decisao do usuario.
create or replace function public.status_banco_eh_pago(p text)
 returns boolean
 language sql
 immutable
as $function$
  select coalesce(proposta_status_nome(p), '') ~* '\mpag[oa]\M|integrad|liquidat|credited|creditad|desembols|contrato pago'
     and coalesce(proposta_status_nome(p), '') !~* 'an[aá]lise|aguard|pend|etapa|cancel|reprov|recus|negad|rejeit|falha|ajustar|estorn|n[aã]o confirmad|reembols|desaverb'
$function$;
