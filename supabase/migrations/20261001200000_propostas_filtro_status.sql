-- Propostas: filtro pelo status original do banco (alem das 5 situacoes).
-- A lista do filtro vem das proprias propostas, do mais comum ao mais raro.
create or replace function public.dashboard_propostas_filtros()
 returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'bancos', (select coalesce(jsonb_agg(b order by b), '[]') from (select distinct banco b from propostas_bancos where nullif(btrim(banco), '') is not null) x),
    'produtos', (select coalesce(jsonb_agg(pr order by pr), '[]') from (select distinct lower(produto) pr from propostas_bancos where nullif(btrim(produto), '') is not null) x),
    'situacoes', '["Pago","Aguardando assinatura","Em processamento","Pendente","Cancelado"]'::jsonb,
    'status', (select coalesce(jsonb_agg(s order by n desc, s), '[]') from (
                 select proposta_status_nome(status) s, count(*) n from propostas_bancos
                  where nullif(btrim(status), '') is not null group by 1) x))
$$;

-- lista: aceita p->'status' (status original, varios)
create or replace function public.dashboard_propostas_lista(p jsonb)
 returns jsonb
 language plpgsql stable security definer
 set search_path to 'public'
as $function$
declare
  v_ini timestamptz := case when nullif(p->>'date_from', '') is not null
                            then (p->>'date_from')::date::timestamp at time zone 'America/Sao_Paulo' end;
  v_fim timestamptz := case when nullif(p->>'date_to', '') is not null
                            then ((p->>'date_to')::date + 1)::timestamp at time zone 'America/Sao_Paulo' end;
  v_hoje timestamptz := hoje_sp()::timestamp at time zone 'America/Sao_Paulo';
  v_bancos text[] := (select array_agg(normalizar_banco(x)) from jsonb_array_elements_text(coalesce(p->'bancos', '[]')) x);
  v_prod text[] := (select array_agg(lower(x)) from jsonb_array_elements_text(coalesce(p->'produtos', '[]')) x);
  v_sit text[] := (select array_agg(x) from jsonb_array_elements_text(coalesce(p->'situacoes', '[]')) x);
  v_status text[] := (select array_agg(x) from jsonb_array_elements_text(coalesce(p->'status', '[]')) x);
  v_busca text := nullif(btrim(coalesce(p->>'busca', '')), '');
  v_dig text := regexp_replace(coalesce(p->>'busca', ''), '\D', '', 'g');
  v_rapido text := nullif(p->>'rapido', '');
  v_ordem text := coalesce(nullif(p->>'ordem', ''), 'criado_em');
  v_asc boolean := p->>'dir' = 'asc';
  v_lim int := least(greatest(coalesce((p->>'limite')::int, 50), 1), 20000);
  v_off int := greatest(coalesce((p->>'offset')::int, 0), 0);
  r jsonb;
begin
  with base as (
    select pb.*, proposta_status_nome(pb.status) status_nome,
           proposta_situacao(pb.status, pb.pago, pb.cancelado) situacao
      from propostas_bancos pb
     where (v_ini is null or pb.criado_em >= v_ini)
       and (v_fim is null or pb.criado_em < v_fim)
       and (v_bancos is null or normalizar_banco(pb.banco) = any(v_bancos))
       and (v_prod is null or lower(coalesce(pb.produto, '')) = any(v_prod))
       and (v_rapido is distinct from 'digitadas_hoje' or pb.criado_em >= v_hoje)
       and (v_rapido is distinct from 'atualizadas_hoje' or pb.atualizado_em >= v_hoje)
       and (v_busca is null
            or pb.nome ilike '%' || v_busca || '%'
            or pb.proposal_number ilike '%' || v_busca || '%'
            or pb.proposal_id ilike '%' || v_busca || '%'
            or (length(v_dig) >= 5 and (pb.cpf like '%' || v_dig || '%' or pb.telefone like '%' || v_dig || '%')))
  ),
  filt as (select * from base
            where (v_sit is null or situacao = any(v_sit))
              and (v_status is null or status_nome = any(v_status))),
  pagina as (
    select * from filt
     order by
       case when v_asc and v_ordem in ('valor', 'parcelas') then case v_ordem when 'valor' then valor else parcelas end end asc nulls last,
       case when not v_asc and v_ordem in ('valor', 'parcelas') then case v_ordem when 'valor' then valor else parcelas end end desc nulls last,
       case when v_asc and v_ordem in ('criado_em', 'atualizado_em') then case v_ordem when 'criado_em' then criado_em else atualizado_em end end asc nulls last,
       case when not v_asc and v_ordem in ('criado_em', 'atualizado_em') then case v_ordem when 'criado_em' then criado_em else atualizado_em end end desc nulls last,
       case when v_asc then case v_ordem when 'codigo' then coalesce(proposal_number, proposal_id) when 'cliente' then nome
            when 'banco' then banco when 'situacao' then status_nome when 'produto' then produto when 'tabela' then tabela_nome
            when 'cpf' then cpf end end asc nulls last,
       case when not v_asc then case v_ordem when 'codigo' then coalesce(proposal_number, proposal_id) when 'cliente' then nome
            when 'banco' then banco when 'situacao' then status_nome when 'produto' then produto when 'tabela' then tabela_nome
            when 'cpf' then cpf end end desc nulls last,
       criado_em desc, id desc
     limit v_lim offset v_off
  ),
  linhas as (
    select g.id, g.banco, g.produto, g.nome, g.cpf, g.telefone, g.valor, g.parcelas, g.tabela_nome, g.tabela_id,
           g.status_nome, g.status_anterior, g.situacao, g.proposal_id, g.proposal_number, g.campanha, g.origem,
           g.chat_id, g.conversation_id, g.criado_em, g.atualizado_em, g.data_pagamento, g.lancado_em_vendas,
           coalesce(nullif(g.vendedor, ''), vd.vendedor) vendedor,
           sim.valor_parcela, sim.valor_bruto valor_face,
           coalesce((sim.payload #>> '{simulation,table_details,monthly_interest_rate}')::numeric,
                    (sim.payload #>> '{simulation,monthly_fee}')::numeric) taxa_mensal,
           (sim.payload #>> '{simulation,table_details,monthly_cet}')::numeric cet_mensal,
           sim.payload #>> '{simulation,table_details,first_payment_date}' primeiro_vencimento,
           sim.payload #>> '{chat_summary,details,contact,email}' email,
           coalesce(rb->>'proMotivoCancelamento', rb->>'motivo', rb->>'status_description', rb->>'mensagem') motivo
      from pagina g
      left join lateral (select jsonb_desembrulha(g.resposta_bruta) rb) b on true
      left join lateral proposta_simulacao(g.cpf, g.tabela_id, g.chat_id, g.valor, g.banco) sim on true
      left join lateral (
        select v.vendedor from vendas_gerais v
         where (g.proposal_id is not null and v.proposal_id_raw = g.proposal_id)
            or (g.proposal_number ~ '^\d{1,18}$' and v.adesao = g.proposal_number::bigint)
         order by (v.vendedor is not null) desc limit 1) vd on true
  )
  select jsonb_build_object(
    'total', (select count(*) from filt),
    'kpis', (select jsonb_build_object(
        'total', count(*),
        'valor_total', coalesce(sum(valor), 0),
        'pendente_qtd', count(*) filter (where situacao = 'Pendente'),
        'pendente_valor', coalesce(sum(valor) filter (where situacao = 'Pendente'), 0),
        'pago_qtd', count(*) filter (where situacao = 'Pago'),
        'pago_valor', coalesce(sum(valor) filter (where situacao = 'Pago'), 0),
        'por_situacao', (select coalesce(jsonb_object_agg(situacao, n), '{}') from
                          (select situacao, count(*) n from base group by 1) s))
      from base),
    'linhas', coalesce((select jsonb_agg(to_jsonb(l)) from linhas l), '[]')
  ) into r;
  return r;
end;
$function$;
