-- O trigger levava 2,2s por insercao: adesao_casa() no WHERE vira filtro
-- linha a linha e o planner nao consegue reaproveitar plano dentro do
-- plpgsql. Cadastrar uma adesao pela tela dava timeout.
-- Agora: busca as vendas do CPF pelo indice (poucas linhas) e faz o
-- casamento em memoria, no laco.
create or replace function public.trg_analise_herda_venda()
returns trigger language plpgsql as $function$
declare v record; v_chave text; v_qtd int := 0; v_achou record;
begin
  if new.cpf is null then return new; end if;
  v_chave := coalesce(new.adesao::text, new.proposal_id_raw);

  -- as vendas desse CPF: usa vg_cpf_norm_idx, quase sempre 1 a 3 linhas
  for v in
    select vg.* from vendas_gerais vg
    where norm_cpf(vg.cpf) = norm_cpf(new.cpf)
    order by vg.id desc
  loop
    v_qtd := v_qtd + 1;

    -- a) chave bate em qualquer formato (SPF..., prefixo de bancarizadora)
    if v_chave is not null and (
         adesao_casa(v_chave, v.adesao::text)
      or adesao_casa(v_chave, v.proposal_id_raw)
      or (new.proposal_id_raw is not null and v.proposal_id_raw = new.proposal_id_raw)
    ) then
      v_achou := v; exit;                       -- achou pela chave: para aqui
    end if;

    -- c) sem chave, mas banco e valor batem
    if v_chave is null and v_achou is null
       and normalizar_banco(v.banco) = normalizar_banco(new.banco)
       and round(v.valor,2) = round(new.valor,2) then
      v_achou := v;
    end if;
  end loop;

  -- b) o CPF so tem uma venda e a analise veio sem chave: nao ha o que confundir
  if v_achou is null and v_chave is null and v_qtd = 1 then
    select vg.* into v_achou from vendas_gerais vg
    where norm_cpf(vg.cpf) = norm_cpf(new.cpf) limit 1;
  end if;

  if v_achou is null then return new; end if;

  new.valor       := coalesce(v_achou.valor, new.valor);
  new.data_status := coalesce(v_achou.data, new.data_status);
  new.parcelas    := coalesce(v_achou.parcelas, new.parcelas);
  new.tabela      := coalesce(nullif(btrim(v_achou.tabela),''), new.tabela);
  new.banco       := coalesce(nullif(btrim(v_achou.banco),''), new.banco);
  new.seguro      := coalesce(nullif(btrim(v_achou.seguro),''), new.seguro);
  new.adesao      := coalesce(v_achou.adesao, new.adesao);
  return new;
exception when others then
  insert into triggers_falhas_log (gatilho, tabela, registro_id, erro, detalhe)
  values ('trg_analise_herda_venda', TG_TABLE_NAME, new.id, SQLERRM, SQLSTATE);
  return new;
end $function$;
