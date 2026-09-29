-- O Sempre Facil manda o UUID da proposta nos dois lados, mas a adesao so na
-- venda (numero curto). O trigger comparava adesao com adesao e proposal com
-- proposal, mas quando a analise tinha SO o proposal_id_raw e a venda tinha
-- os dois, o casamento acontecia -- o que faltava era GRAVAR a adesao na
-- analise. Sem ela, o join dos relatorios (cpf + adesao) nao encontrava o
-- par, e a venda ficava sem vendedora: os pontos nao entravam para ninguem.
create or replace function public.trg_analise_herda_venda()
returns trigger language plpgsql as $function$
declare
  v record; v_chave text; v_qtd int := 0;
  v_id_achado bigint; v_id_valor bigint; v_venda record;
begin
  if new.cpf is null then return new; end if;
  v_chave := coalesce(new.adesao::text, new.proposal_id_raw);

  for v in
    select vg.* from vendas_gerais vg
    where norm_cpf(vg.cpf) = norm_cpf(new.cpf)
    order by vg.id desc
  loop
    v_qtd := v_qtd + 1;

    -- a) o UUID da proposta bate: e a mesma venda, sem duvida
    if v_id_achado is null and new.proposal_id_raw is not null
       and v.proposal_id_raw = new.proposal_id_raw then
      v_id_achado := v.id;
    end if;

    -- b) a chave bate em formato numerico (SPF0000002010 = 2010, 373xxx = xxx)
    if v_id_achado is null and v_chave is not null and (
         adesao_casa(v_chave, v.adesao::text)
      or adesao_casa(v_chave, v.proposal_id_raw)
    ) then
      v_id_achado := v.id;
    end if;

    -- c) reserva: banco e valor batem (uuid x numero curto que nao se casam)
    if v_id_valor is null
       and normalizar_banco(v.banco) = normalizar_banco(new.banco)
       and new.valor is not null and round(v.valor,2) = round(new.valor,2) then
      v_id_valor := v.id;
    end if;
  end loop;

  -- d) CPF com uma venda so e analise sem chave: nao ha o que confundir
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
  -- a adesao da venda e a chave dos relatorios: sem ela o par se perde
  new.adesao      := coalesce(new.adesao, v_venda.adesao);
  return new;
exception when others then
  insert into triggers_falhas_log (gatilho, tabela, registro_id, erro, detalhe)
  values ('trg_analise_herda_venda', TG_TABLE_NAME, new.id, SQLERRM, SQLSTATE);
  return new;
end $function$;
