-- Varredura por periodo passa a registrar em consultas_bancos_log o status que a
-- listagem do banco devolve. A rotina_remove_canceladas decide pelo ULTIMO status
-- do log: 7 Facta pagas em 16/09 tinham um "28 - CANCELADO" consultado em 15/09
-- e nunca reconsultado — a varredura relancava e a rotina removia toda noite
-- (14 dias); depois do ajuste de 30/09 a varredura passou a ignora-las e elas
-- ficaram fora das vendas (achado na conferencia de 01/10).
do $$
declare d text; novo text;
begin
  d := pg_get_functiondef('public.varredura_banco_periodo(text,jsonb,boolean)'::regprocedure);
  novo := replace(d,
    $a$    if acao is null then
      select g.id into v_venda from vendas_gerais g$a$,
    $b$    -- status atual vindo da listagem do banco: registra quando difere do ultimo
    -- consultado, para a rotina de canceladas nao decidir por consulta velha
    if acao is null and v_status is not null and p_aplicar
       and v_status is distinct from venda_status_banco(v_banco, v_id) then
      insert into consultas_bancos_log (banco, adesao, cpf, origem, sucesso, encontrado,
                                        valor_banco, tabela_banco, parcelas_banco, status_banco)
      values (v_banco, v_id, v_cpf, 'varredura', true, true, v_valor, v_tab, v_parc, v_status);
    end if;

    if acao is null then
      select g.id into v_venda from vendas_gerais g$b$);
  if novo = d then raise exception 'trecho nao encontrado em varredura_banco_periodo'; end if;
  execute novo;
end $$;
