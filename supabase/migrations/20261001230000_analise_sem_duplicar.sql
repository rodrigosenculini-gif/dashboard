-- Analise duplicada (Sempre Facil, 30/09): a vendedora digitou um numero que nao
-- e a adesao do banco (2997412 em vez de 4384). dashboard_vendedoras_add_venda
-- achou a venda pelo CPF+banco+valor, mas gravou a analise com o numero digitado;
-- depois marcou a vendedora na venda e o gatilho venda_para_vendedoras_analise,
-- sem reconhecer a analise (adesao diferente, sem codigo), criou outra.
do $$
declare d text; novo text;
begin
  -- 1) achou a venda: a chave do banco manda (adesao e codigo da venda)
  d := pg_get_functiondef('public.dashboard_vendedoras_add_venda(text,bigint,text,text,numeric,text,text,date,integer,text,text)'::regprocedure);
  novo := replace(d,
    $a$    v_adesao := coalesce(v_adesao, v_vg_adesao);$a$,
    $b$    -- 01/10: numero digitado diferente da adesao do banco duplicava a analise
    v_adesao := coalesce(v_vg_adesao, v_adesao);
    v_raw := coalesce(v_raw, (select proposal_id_raw from vendas_gerais where id = v_vg_id));$b$);
  if novo = d then raise exception 'trecho da adesao nao encontrado em dashboard_vendedoras_add_venda'; end if;
  execute novo;

  -- 2) o gatilho da venda reconhece analise da mesma vendedora pelo CPF+banco+valor
  d := pg_get_functiondef('public.trg_c6_venda_para_vendedoras_analise'::regproc);
  novo := replace(d,
    $a$                 or (norm_cpf(v.cpf) = norm_cpf(new.cpf) and v.adesao = new.adesao)) then$a$,
    $b$                 or (norm_cpf(v.cpf) = norm_cpf(new.cpf) and v.adesao = new.adesao)
                 or (v.cpf = norm_cpf(new.cpf) and v.vendedor = new.vendedor
                     and normalizar_banco(v.banco) = normalizar_banco(new.banco)
                     and round(v.valor, 2) = round(new.valor, 2))) then$b$);
  if novo = d then raise exception 'trecho do exists nao encontrado em trg_c6_venda_para_vendedoras_analise'; end if;
  execute novo;
end $$;
