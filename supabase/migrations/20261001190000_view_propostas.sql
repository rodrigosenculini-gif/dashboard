-- View "Propostas" do dashboard (01/10): todas as propostas de propostas_bancos
-- com filtros, indicadores e detalhe (proposta + simulacao do VendeAI + consultas
-- no banco + venda + lead).

-- status vem em varios formatos: codigo do VendeAI, texto do banco e ate JSON
-- ({"name":"Paga","id":8}). Devolve so o nome legivel.
create or replace function public.proposta_status_nome(p text)
 returns text language plpgsql immutable as $$
begin
  if p ~ '^\s*\{' then return coalesce((p::jsonb)->>'name', p); end if;
  return p;
exception when others then return p;
end $$;

-- agrupa os status em 5 situacoes (filtro, cor e indicadores)
create or replace function public.proposta_situacao(p_status text, p_pago boolean, p_cancelado boolean)
 returns text language sql immutable as $$
  select case
    when coalesce(p_pago, false) then 'Pago'
    when coalesce(p_cancelado, false) or proposta_status_nome(p_status) ~* 'cancel|reprov|rejected|estorn' then 'Cancelado'
    when proposta_status_nome(p_status) ~* 'assinatura|formalization|form dig' then 'Aguardando assinatura'
    when proposta_status_nome(p_status) ~* 'pend|ajustar|documento|n[aã]o confirmado|regulariza|error' then 'Pendente'
    else 'Em processamento' end
$$;

-- melhor simulacao do VendeAI para a proposta: mesmo CPF (indice), preferindo a
-- mesma tabela, a mesma conversa e o valor mais proximo
create or replace function public.proposta_simulacao(p_cpf text, p_tabela_id text, p_chat_id text, p_valor numeric, p_banco text)
 returns simulacoes_vendeai language sql stable as $$
  select s.* from simulacoes_vendeai s
   where p_cpf is not null and s.cpf = p_cpf
     and (p_banco is null or s.banco_normalizado is null or s.banco_normalizado = normalizar_banco(p_banco))
   order by (s.tabela_id = p_tabela_id) desc nulls last,
            (s.chat_id = p_chat_id) desc nulls last,
            abs(coalesce(s.valor, 0) - coalesce(p_valor, 0)),
            s.criado_em desc
   limit 1
$$;

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
  filt as (select * from base where v_sit is null or situacao = any(v_sit)),
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

create or replace function public.dashboard_propostas_filtros()
 returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'bancos', (select coalesce(jsonb_agg(b order by b), '[]') from (select distinct banco b from propostas_bancos where nullif(btrim(banco), '') is not null) x),
    'produtos', (select coalesce(jsonb_agg(pr order by pr), '[]') from (select distinct lower(produto) pr from propostas_bancos where nullif(btrim(produto), '') is not null) x),
    'situacoes', '["Pago","Aguardando assinatura","Em processamento","Pendente","Cancelado"]'::jsonb)
$$;

-- detalhe: proposta + simulacao + consultas no banco + venda/analise + lead
-- (disparos, LP, pagamento) + eventos recentes do VendeAI. Varios blocos podem
-- vir vazios: proposta antiga, sem CPF/telefone ou feita fora da IA.
create or replace function public.dashboard_proposta_detalhe(p_id bigint)
 returns jsonb
 language plpgsql stable security definer
 set search_path to 'public'
as $function$
declare
  pb propostas_bancos; sim simulacoes_vendeai; v_tel bigint; v_ades bigint; r jsonb;
begin
  select * into pb from propostas_bancos where id = p_id;
  if pb.id is null then return null; end if;
  sim := proposta_simulacao(pb.cpf, pb.tabela_id, pb.chat_id, pb.valor, pb.banco);
  v_tel := case when regexp_replace(coalesce(pb.telefone, ''), '\D', '', 'g') ~ '^\d{10,15}$'
                then (case when length(regexp_replace(pb.telefone, '\D', '', 'g')) <= 11 then '55' else '' end
                      || regexp_replace(pb.telefone, '\D', '', 'g'))::bigint end;
  v_ades := case when pb.proposal_number ~ '^\d{1,18}$' then pb.proposal_number::bigint end;

  select jsonb_build_object(
    'proposta', to_jsonb(pb) - 'resposta_bruta'
                || jsonb_build_object('status_nome', proposta_status_nome(pb.status),
                                      'situacao', proposta_situacao(pb.status, pb.pago, pb.cancelado)),
    'resposta_banco', jsonb_desembrulha(pb.resposta_bruta),
    'simulacao', case when sim.id is null then null else
        jsonb_build_object('criado_em', sim.criado_em, 'tabela', sim.tabela_nome, 'valor', sim.valor,
          'valor_face', sim.valor_bruto, 'valor_parcela', sim.valor_parcela, 'parcelas', sim.parcelas,
          'seguro', sim.seguro, 'campanha', sim.campanha, 'stage', sim.stage, 'inbox', sim.inbox,
          'detalhes', sim.payload #> '{simulation,table_details}',
          'contato', sim.payload #> '{chat_summary,details,contact}') end,
    'consultas', (select coalesce(jsonb_agg(c order by c.criado_em desc), '[]') from (
        select l.criado_em, l.origem, l.status_banco, l.valor_banco, l.parcelas_banco
          from consultas_bancos_log l
         where l.adesao in (pb.proposal_number, pb.proposal_id)
         order by l.criado_em desc limit 30) c),
    'venda', (select to_jsonb(v) from (
        select id, data, valor, peso, ponto, tabela, parcelas, vendedor, origem, campanha
          from vendas_gerais
         where (pb.proposal_id is not null and proposal_id_raw = pb.proposal_id)
            or (v_ades is not null and adesao = v_ades)
         limit 1) v),
    'analise', (select coalesce(jsonb_agg(a), '[]') from (
        select id, vendedor, data_status, valor, tabela, parcelas
          from vendedoras_analise
         where (pb.proposal_id is not null and proposal_id_raw = pb.proposal_id)
            or (v_ades is not null and adesao = v_ades)) a),
    'disparos', (select coalesce(jsonb_agg(d order by coalesce(d.reenvio, d.realizado) desc nulls last), '[]') from (
        select id, campanha, origem, meta, tipo_envio, realizado, reenvio, interacao, data_ultima_interacao,
               status, pagas, data_pagamento, conversation_id
          from disparochat
         where v_tel is not null and whatsapp = v_tel
         order by coalesce(reenvio, realizado) desc nulls last limit 10) d),
    'lp', (select coalesce(jsonb_agg(t order by t.created_at desc), '[]') from (
        select id, created_at, produto, campanha, origem, interacao, aprovadas, pagas, valor
          from total_produtos
         where (pb.cpf is not null and cpf = pb.cpf) or (v_tel is not null and whatsapp = v_tel)
         order by created_at desc limit 10) t),
    'eventos', (select coalesce(jsonb_agg(e order by e.recebido_em), '[]') from (
        select evento, recebido_em, payload->>'proposal_status' status, payload->>'previous_proposal_status' anterior
          from vendeai_eventos_log
         where pb.proposal_id is not null and proposal_id = pb.proposal_id
         order by recebido_em limit 50) e)
  ) into r;
  return r;
end;
$function$;
