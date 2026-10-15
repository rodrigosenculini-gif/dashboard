-- 15/10: o cache do navegador das telas Entradas LP e Disparos so renovava quando entrava lead novo;
-- pagamento/atribuicao refeitos nao mudavam o carimbo e a tela ficava com o numero antigo ("Pagas 2").
create or replace function public.dashboard_versao()
 returns jsonb language sql stable security definer set search_path to 'public'
as $function$
  select jsonb_build_object(
    'disparos',   (select coalesce(max(id), 0) from disparochat)::text || '-' ||
                  (select coalesce(max(id), 0) from pagamentos)::text || '-' ||
                  (select coalesce(max(extract(epoch from pago_em))::bigint, 0) from pagamentos)::text,
    'vendas',     (select coalesce(max(id), 0) from vendas_gerais)::text || '-' ||
                  (select coalesce(max(extract(epoch from atualizado_em))::bigint, 0) from vendas_gerais)::text,
    'vendedoras', (select coalesce(max(id), 0) from vendedoras_analise)::text || '-' ||
                  (select coalesce(max(extract(epoch from atualizado_em))::bigint, 0) from vendedoras_analise)::text,
    'produtos',   (select coalesce(max(id), 0) from leads_chatwoot)::text || '-' ||
                  (select coalesce(max(id), 0) from total_produtos)::text || '-' ||
                  (select coalesce(max(id), 0) from pagamentos)::text || '-' ||
                  (select count(*) from pagamentos where pago_em >= date_trunc('month', now()))::text,
    'chips',      (select coalesce(max(id), 0) from chips)::text || '-' ||
                  (select coalesce(max(extract(epoch from updated_at))::bigint, 0) from chips)::text || '-' ||
                  (select coalesce(max(id), 0) from chips_recargas)::text,
    'trello',     (select coalesce(max(id), 0) from trello_cards),
    'hoje',       (now() at time zone 'America/Sao_Paulo')::date
  );
$function$;
