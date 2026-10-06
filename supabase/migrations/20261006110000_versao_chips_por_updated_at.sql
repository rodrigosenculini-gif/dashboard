-- Cache da tela de chips nao via alteracao (06/10): o carimbo de versao dos
-- chips era so max(id). Recarga, desativar do alerta ou qualquer edicao de chip
-- existente nao mudava o carimbo, e o navegador seguia mostrando o resumo
-- antigo ("77 com recarga vencida") sem prazo para renovar -- a revalidacao de
-- 3 min via "mesma versao" e so renovava o relogio. Agora o carimbo inclui o
-- ultimo updated_at (gatilho chips_touch) e a ultima recarga registrada.
create or replace function public.dashboard_versao()
 returns jsonb language sql stable security definer set search_path to 'public'
as $function$
  select jsonb_build_object(
    'disparos',   (select coalesce(max(id), 0) from disparochat),
    'vendas',     (select coalesce(max(id), 0) from vendas_gerais)::text || '-' ||
                  (select coalesce(max(extract(epoch from atualizado_em))::bigint, 0) from vendas_gerais)::text,
    'vendedoras', (select coalesce(max(id), 0) from vendedoras_analise)::text || '-' ||
                  (select coalesce(max(extract(epoch from atualizado_em))::bigint, 0) from vendedoras_analise)::text,
    'produtos',   (select coalesce(max(id), 0) from leads_chatwoot),
    'chips',      (select coalesce(max(id), 0) from chips)::text || '-' ||
                  (select coalesce(max(extract(epoch from updated_at))::bigint, 0) from chips)::text || '-' ||
                  (select coalesce(max(id), 0) from chips_recargas)::text,
    'trello',     (select coalesce(max(id), 0) from trello_cards),
    'hoje',       (now() at time zone 'America/Sao_Paulo')::date
  );
$function$;
