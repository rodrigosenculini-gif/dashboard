-- Sem coluna de atualizacao, nao havia como o cache do dashboard saber que
-- uma linha mudou: ele comparava so max(id), que muda apenas em insercao.
-- Correcoes por UPDATE ficavam invisiveis ate o cache vencer.
alter table vendas_gerais       add column if not exists atualizado_em timestamptz;
alter table vendedoras_analise  add column if not exists atualizado_em timestamptz;

create or replace function public.trg_marca_atualizacao()
returns trigger language plpgsql as $function$
begin
  new.atualizado_em := now();
  return new;
end $function$;

drop trigger if exists marca_atualizacao on vendas_gerais;
create trigger marca_atualizacao before insert or update on vendas_gerais
  for each row execute function trg_marca_atualizacao();

drop trigger if exists marca_atualizacao on vendedoras_analise;
create trigger marca_atualizacao before insert or update on vendedoras_analise
  for each row execute function trg_marca_atualizacao();

-- o carimbo passa a somar a ultima alteracao, nao so o maior id
create or replace function public.dashboard_versao()
returns jsonb language sql stable security definer set search_path to 'public' as $function$
  select jsonb_build_object(
    'disparos',   (select coalesce(max(id), 0) from disparochat),
    'vendas',     (select coalesce(max(id), 0) from vendas_gerais)::text || '-' ||
                  (select coalesce(max(extract(epoch from atualizado_em))::bigint, 0) from vendas_gerais)::text,
    'vendedoras', (select coalesce(max(id), 0) from vendedoras_analise)::text || '-' ||
                  (select coalesce(max(extract(epoch from atualizado_em))::bigint, 0) from vendedoras_analise)::text,
    'produtos',   (select coalesce(max(id), 0) from leads_chatwoot),
    'chips',      (select coalesce(max(id), 0) from chips),
    'trello',     (select coalesce(max(id), 0) from trello_cards),
    'hoje',       (now() at time zone 'America/Sao_Paulo')::date
  );
$function$;
