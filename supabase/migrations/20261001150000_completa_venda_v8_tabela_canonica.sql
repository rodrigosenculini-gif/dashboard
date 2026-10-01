-- completa_venda_pela_proposta roda DEPOIS de a0_v8_tabela_canonica (gatilhos
-- BEFORE vao em ordem alfabetica: 'a0_' < 'a_'). Quando ela preenchia a tabela
-- vazia com o tabela_nome da fila (VendeAI grava "CLT Acelera - Seguro"), o
-- padronizador ja tinha passado e o nome cru ficava na venda -- duas grafias da
-- mesma tabela nos relatorios (ex.: venda 16271 em 01/10). Agora o V8 sai
-- padronizado aqui mesmo. Peso nao mudava: calc_peso_vendas ja normaliza o V8.
CREATE OR REPLACE FUNCTION public.completa_venda_pela_proposta()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_ades text := nullif(regexp_replace(coalesce(NEW.adesao::text,''), '\D', '', 'g'), '');
  v_banco_norm text := normalizar_banco(NEW.banco);
  v_cpf text := nullif(regexp_replace(coalesce(NEW.cpf,''), '\D', '', 'g'), '');
  v_cpf_ok boolean;
  v_tabela_lixo boolean;
  v_nova_adesao bigint;
  p RECORD;
BEGIN
  -- CPF utilizavel como chave: 11 digitos e nao repetido (00000000000, 11111111111, ...)
  v_cpf_ok := v_cpf IS NOT NULL AND length(v_cpf) = 11 AND v_cpf !~ '^(\d)\1{10}$';

  v_tabela_lixo := (NEW.tabela IS NOT NULL) AND (
       NEW.tabela ~ '^[0-9a-f]{8}-[0-9a-f]{4}-'
    OR (v_banco_norm = 'SOMA' AND NEW.tabela !~ '^[0-9]')
  );

  IF NEW.banco IS NOT NULL AND NOT v_tabela_lixo AND NEW.adesao IS NOT NULL
     AND NEW.parcelas IS NOT NULL AND NEW.tabela IS NOT NULL AND NEW.seguro IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- 1) pela adesao (usa indice de expressao)
  IF v_ades IS NOT NULL THEN
    SELECT pb.banco, pb.parcelas, pb.tabela_nome, pb.tabela_id, pb.valor, pb.proposal_number
      INTO p
    FROM propostas_bancos pb
    WHERE regexp_replace(coalesce(pb.proposal_number,''), '\D', '', 'g') = v_ades
    ORDER BY pb.atualizado_em DESC NULLS LAST LIMIT 1;

    IF NOT FOUND THEN
      SELECT pb.banco, pb.parcelas, pb.tabela_nome, pb.tabela_id, pb.valor, pb.proposal_number
        INTO p
      FROM propostas_bancos pb
      WHERE regexp_replace(coalesce(pb.proposal_id,''), '\D', '', 'g') = v_ades
      ORDER BY pb.atualizado_em DESC NULLS LAST LIMIT 1;
    END IF;
  END IF;

  -- 2) pelo CPF (usa pb_cpf_banco_idx)
  IF NOT FOUND AND v_cpf_ok THEN
    SELECT pb.banco, pb.parcelas, pb.tabela_nome, pb.tabela_id, pb.valor, pb.proposal_number
      INTO p
    FROM propostas_bancos pb
    WHERE pb.cpf = v_cpf
      AND (NEW.banco IS NULL OR normalizar_banco(pb.banco) = v_banco_norm)
    ORDER BY pb.atualizado_em DESC NULLS LAST LIMIT 1;
  END IF;

  IF FOUND THEN
    IF NEW.banco IS NULL AND p.banco IS NOT NULL THEN NEW.banco := p.banco; END IF;
    IF NEW.adesao IS NULL AND p.proposal_number IS NOT NULL THEN
      v_nova_adesao := case
        when regexp_replace(p.proposal_number, '\D', '', 'g') ~ '^\d{1,18}$'
        then regexp_replace(p.proposal_number, '\D', '', 'g')::bigint end;
      -- cinto de seguranca: nunca herdar uma adesao que ja pertence a outra
      -- venda do mesmo CPF, senao o indice unico derruba a operacao inteira
      IF v_nova_adesao IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM vendas_gerais v
        WHERE v.cpf = NEW.cpf AND v.adesao = v_nova_adesao
          AND (TG_OP = 'INSERT' OR v.id <> NEW.id)
      ) THEN
        NEW.adesao := v_nova_adesao;
      END IF;
    END IF;
    IF NEW.parcelas IS NULL THEN NEW.parcelas := p.parcelas; END IF;
    IF (NEW.tabela IS NULL OR v_tabela_lixo) AND p.tabela_nome IS NOT NULL
       AND p.tabela_nome !~ '^[0-9a-f]{8}-[0-9a-f]{4}-' THEN
      -- o padronizador do V8 (a0_v8_tabela_canonica) ja rodou: padroniza aqui
      NEW.tabela := case when normalizar_banco(NEW.banco) = 'V8'
                         then v8_tabela_canonica(p.tabela_nome) else p.tabela_nome end;
    END IF;
    IF coalesce(NEW.valor,0) = 0 AND p.valor IS NOT NULL THEN NEW.valor := p.valor; END IF;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- nunca derrubar o INSERT/UPDATE da venda por causa do enriquecimento
  INSERT INTO triggers_falhas_log (gatilho, tabela, registro_id, erro, detalhe)
  VALUES ('completa_venda_pela_proposta', 'vendas_gerais', NEW.id, SQLERRM, SQLSTATE);
  RETURN NEW;
END;
$function$;
