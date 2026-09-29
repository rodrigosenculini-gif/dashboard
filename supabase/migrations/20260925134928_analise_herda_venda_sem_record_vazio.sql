-- Em PL/pgSQL, testar IS NULL num record que nunca recebeu valor lanca
-- "record is not assigned yet". O exception engolia e a heranca nao
-- acontecia -- em silencio, porque o log da falha sumia junto no rollback
-- dos testes. Agora o controle e por id (bigint), que aceita null.
create or replace function public.trg_analise_herda_venda()
returns trigger language plpgsql as $function$
declare
  v record;
  v_chave text;
  v_qtd int := 0;
  v_id_achado bigint;        -- casou pela chave
  v_id_valor  bigint;        -- candidato por banco + valor
  v_venda record;
begin
  if new.cpf is null then return new; end if;
  v_chave := coalesce(new.adesao::text, new.proposal_id_raw);

  for v in
    select vg.* from vendas_gerais vg
    where norm_cpf(vg.cpf) = norm_cpf(new.cpf)
    order by vg.id desc
  loop
    v_qtd := v_qtd + 1;

    -- a) chave bate em formato numerico (SPF0000002010 = 2010, 373xxx = xxx)
    if v_id_achado is null and v_chave is not null and (
         adesao_casa(v_chave, v.adesao::text)
      or adesao_casa(v_chave, v.proposal_id_raw)
      or (new.proposal_id_raw is not null and v.proposal_id_raw = new.proposal_id_raw)
    ) then
      v_id_achado := v.id;
    end if;

    -- b) reserva: banco e valor batem. Serve quando a analise guarda o uuid
    --    do VendeAI e a venda o numero curto -- formatos que nao se casam.
    if v_id_valor is null
       and normalizar_banco(v.banco) = normalizar_banco(new.banco)
       and new.valor is not null and round(v.valor,2) = round(new.valor,2) then
      v_id_valor := v.id;
    end if;
  end loop;

  -- c) CPF com uma venda so e analise sem chave: nao ha o que confundir
  if v_id_achado is null and v_id_valor is null and v_chave is null and v_qtd = 1 then
    select vg.id into v_id_achado from vendas_gerais vg
    where norm_cpf(vg.cpf) = norm_cpf(new.cpf) limit 1;
  end if;

  if v_id_achado is null then v_id_achado := v_id_valor; end if;
  if v_id_achado is null then return new; end if;

  select * into v_venda from vendas_gerais where id = v_id_achado;

  new.valor       := coalesce(v_venda.valor, new.valor);
  new.data_status := coalesce(v_venda.data, new.data_status);
  new.parcelas    := coalesce(v_venda.parcelas, new.parcelas);
  new.tabela      := coalesce(nullif(btrim(v_venda.tabela),''), new.tabela);
  new.banco       := coalesce(nullif(btrim(v_venda.banco),''), new.banco);
  new.seguro      := coalesce(nullif(btrim(v_venda.seguro),''), new.seguro);
  new.adesao      := coalesce(v_venda.adesao, new.adesao);
  return new;
exception when others then
  insert into triggers_falhas_log (gatilho, tabela, registro_id, erro, detalhe)
  values ('trg_analise_herda_venda', TG_TABLE_NAME, new.id, SQLERRM, SQLSTATE);
  return new;
end $function$;
