-- Soma: venda entrava sem ADE (29 em outubro).
-- A "Conferencia APIs bancos (10 min)" lanca a venda por conferir_e_lancar_proposta,
-- que lia p_norm->>'proNumBancarizadora'; o normalizador da consulta devolve o
-- numero como "numero_bancarizadora". Quando a conferencia via o pagamento antes
-- do "Soma - enriquece propostas (2h)", a venda nascia sem adesao e ninguem
-- completava depois (o enriquecimento pula proposta ja lancada).
--  1) le os dois nomes e grava o numero na proposta;
--  2) gatilho: quando a proposta ganha numero, completa venda e analise sem ADE
--     ligadas pelo codigo da proposta (vale para qualquer caminho/banco);
--  3) completa as que ja estao assim.
do $$
declare d text; novo text;
begin
  d := pg_get_functiondef('public.conferir_e_lancar_proposta(text,text,jsonb)'::regprocedure);
  novo := replace(d, $a$coalesce(v_num_prop, p_norm->>'proNumBancarizadora', '')$a$,
                     $a$coalesce(v_num_prop, p_norm->>'numero_bancarizadora', p_norm->>'proNumBancarizadora', '')$a$);
  novo := replace(novo, $a$tabela_nome = coalesce(v_tab, tabela_nome),$a$,
                        $a$tabela_nome = coalesce(v_tab, tabela_nome),
         proposal_number = coalesce(proposal_number, nullif(p_norm->>'numero_bancarizadora',''), nullif(p_norm->>'proNumBancarizadora','')),$a$);
  if novo = d or position('numero_bancarizadora' in novo) = 0 then
    raise exception 'trecho nao encontrado em conferir_e_lancar_proposta';
  end if;
  execute novo;
end $$;

create or replace function public.trg_proposta_numero_completa_venda()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_num bigint;
begin
  if new.proposal_id is null then return new; end if;
  v_num := case when regexp_replace(coalesce(new.proposal_number,''),'\D','','g') ~ '^\d{1,18}$'
                then regexp_replace(new.proposal_number,'\D','','g')::bigint end;
  if v_num is null then return new; end if;

  update vendas_gerais v set adesao = v_num
   where v.adesao is null and v.proposal_id_raw = new.proposal_id
     and normalizar_banco(v.banco) = normalizar_banco(new.banco)
     and not exists (select 1 from vendas_gerais x where x.adesao = v_num
                      and normalizar_banco(x.banco) = normalizar_banco(new.banco) and x.id <> v.id);
  update vendedoras_analise va set adesao = v_num
   where va.adesao is null and va.proposal_id_raw = new.proposal_id
     and normalizar_banco(va.banco) = normalizar_banco(new.banco);
  return new;
exception when others then
  insert into triggers_falhas_log (gatilho, tabela, registro_id, erro, detalhe)
  values ('trg_proposta_numero_completa_venda', TG_TABLE_NAME, new.id, SQLERRM, SQLSTATE);
  return new;
end $function$;

drop trigger if exists proposta_numero_completa_venda on public.propostas_bancos;
create trigger proposta_numero_completa_venda
  after insert or update of proposal_number on public.propostas_bancos
  for each row when (new.proposal_number is not null)
  execute function public.trg_proposta_numero_completa_venda();

-- as que ja estao sem ADE
update vendas_gerais v set adesao = regexp_replace(p.proposal_number,'\D','','g')::bigint
  from propostas_bancos p
 where v.adesao is null and p.proposal_id = v.proposal_id_raw
   and normalizar_banco(p.banco) = normalizar_banco(v.banco)
   and regexp_replace(coalesce(p.proposal_number,''),'\D','','g') ~ '^\d{1,18}$'
   and not exists (select 1 from vendas_gerais x where x.adesao = regexp_replace(p.proposal_number,'\D','','g')::bigint
                    and normalizar_banco(x.banco) = normalizar_banco(v.banco));
