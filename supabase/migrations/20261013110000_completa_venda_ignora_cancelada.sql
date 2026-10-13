-- 13/10: a venda cadastrada pela vendedora (Adicionar venda) recebia a adesao de uma proposta
-- CANCELADA do mesmo CPF (fallback por CPF do gatilho completa_venda_pela_proposta), e a analise
-- ficava sem venda (5 casos em outubro: SPF 6809, 7703, 7765, 7880, 7915).
-- Agora: codigo SPF no proposal_id_raw vira adesao direto; o fallback por CPF ignora
-- proposta cancelada/reprovada e prefere a paga.
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
  -- Sempre Facil: SPF0000006809 e o proprio codigo da proposta
  IF NEW.adesao IS NULL AND coalesce(NEW.proposal_id_raw,'') ~ '^SPF[0-9]+$' THEN
    NEW.adesao := ltrim(substr(NEW.proposal_id_raw, 4), '0')::bigint;
    v_ades := NEW.adesao::text;
  END IF;

  v_cpf_ok := v_cpf IS NOT NULL AND length(v_cpf) = 11 AND v_cpf !~ '^(\d)\1{10}$';

  v_tabela_lixo := (NEW.tabela IS NOT NULL) AND (
       NEW.tabela ~ '^[0-9a-f]{8}-[0-9a-f]{4}-'
    OR (v_banco_norm = 'SOMA' AND NEW.tabela !~ '^[0-9]')
  );

  IF NEW.banco IS NOT NULL AND NOT v_tabela_lixo AND NEW.adesao IS NOT NULL
     AND NEW.parcelas IS NOT NULL AND NEW.tabela IS NOT NULL AND NEW.seguro IS NOT NULL THEN
    RETURN NEW;
  END IF;

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

  -- fallback por CPF: nunca uma proposta cancelada/reprovada; a paga vem primeiro
  IF NOT FOUND AND v_cpf_ok THEN
    SELECT pb.banco, pb.parcelas, pb.tabela_nome, pb.tabela_id, pb.valor, pb.proposal_number
      INTO p
    FROM propostas_bancos pb
    WHERE pb.cpf = v_cpf
      AND (NEW.banco IS NULL OR normalizar_banco(pb.banco) = v_banco_norm)
      AND coalesce(pb.cancelado, false) = false
      AND coalesce(pb.status,'') !~* 'cancel|reprov|negad|rejeit|estorn'
    ORDER BY coalesce(pb.pago, false) DESC, pb.atualizado_em DESC NULLS LAST LIMIT 1;
  END IF;

  IF FOUND THEN
    IF NEW.banco IS NULL AND p.banco IS NOT NULL THEN NEW.banco := p.banco; END IF;
    IF NEW.adesao IS NULL AND p.proposal_number IS NOT NULL THEN
      v_nova_adesao := case
        when regexp_replace(p.proposal_number, '\D', '', 'g') ~ '^\d{1,18}$'
        then regexp_replace(p.proposal_number, '\D', '', 'g')::bigint end;
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
      NEW.tabela := case when normalizar_banco(NEW.banco) = 'V8'
                         then v8_tabela_canonica(p.tabela_nome) else p.tabela_nome end;
    END IF;
    IF coalesce(NEW.valor,0) = 0 AND p.valor IS NOT NULL THEN NEW.valor := p.valor; END IF;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO triggers_falhas_log (gatilho, tabela, registro_id, erro, detalhe)
  VALUES ('completa_venda_pela_proposta', 'vendas_gerais', NEW.id, SQLERRM, SQLSTATE);
  RETURN NEW;
END;
$function$;
