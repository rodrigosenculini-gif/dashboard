-- =========================================================
-- ALTERAÇÃO: Suporte a nova tabela de pontos (01/09/2026)
-- Arquivo único com toda a migration + dados + função nova
-- =========================================================

-- =========================================================
-- 1. CRIAR TABELA_PONTOS
-- =========================================================

CREATE TABLE IF NOT EXISTS tabela_pontos (
  id BIGSERIAL PRIMARY KEY,
  banco TEXT NOT NULL,
  produto TEXT NOT NULL,
  nome_tabela TEXT,
  regras_especificas TEXT,
  prazos TEXT NOT NULL,
  pontos NUMERIC NOT NULL CHECK (pontos >= 0),
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW(),
  ativo BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_tabela_pontos_banco_produto ON tabela_pontos(banco, produto);
CREATE INDEX IF NOT EXISTS idx_tabela_pontos_banco_prazos ON tabela_pontos(banco, prazos);
CREATE INDEX IF NOT EXISTS idx_tabela_pontos_ativo ON tabela_pontos(ativo);

CREATE TABLE IF NOT EXISTS tabela_pontos_historico (
  id BIGSERIAL PRIMARY KEY,
  tabela_pontos_id BIGINT,
  banco TEXT,
  produto TEXT,
  pontos_antigo NUMERIC,
  pontos_novo NUMERIC,
  alterado_em TIMESTAMPTZ DEFAULT NOW(),
  alterado_por TEXT
);

CREATE OR REPLACE FUNCTION atualizar_historico_pontos()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.pontos != NEW.pontos THEN
    INSERT INTO tabela_pontos_historico 
      (tabela_pontos_id, banco, produto, pontos_antigo, pontos_novo)
    VALUES 
      (NEW.id, NEW.banco, NEW.produto, OLD.pontos, NEW.pontos);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_historico_pontos ON tabela_pontos;
CREATE TRIGGER trigger_historico_pontos
AFTER UPDATE ON tabela_pontos
FOR EACH ROW
EXECUTE FUNCTION atualizar_historico_pontos();

-- =========================================================
-- 2. FUNÇÕES AUXILIARES
-- =========================================================

CREATE OR REPLACE FUNCTION normalizar_texto(txt TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT UPPER(TRIM(COALESCE(txt, '')));
$$;

CREATE OR REPLACE FUNCTION buscar_pontos_tabela(
  p_banco TEXT,
  p_tabela TEXT,
  p_parcelas INT,
  p_seguro TEXT
)
RETURNS NUMERIC
LANGUAGE PLPGSQL
STABLE
AS $$
DECLARE
  v_pontos NUMERIC;
  v_banco_norm TEXT := normalizar_texto(p_banco);
  v_produto TEXT;
BEGIN
  -- 1) Match EXATO (banco + prazos)
  IF p_parcelas IS NOT NULL THEN
    SELECT pontos INTO v_pontos
    FROM tabela_pontos
    WHERE normalizar_texto(banco) = v_banco_norm
      AND ativo = TRUE
      AND (
        prazos LIKE '%' || p_parcelas || '%parcela%'
        OR prazos = p_parcelas || ' parcelas'
      )
    LIMIT 1;
    
    IF v_pontos IS NOT NULL THEN
      RETURN v_pontos;
    END IF;
  END IF;
  
  -- 2) Match por produto
  v_produto := calc_produto_vendas(p_banco, p_tabela);
  IF v_produto IS NOT NULL THEN
    SELECT pontos INTO v_pontos
    FROM tabela_pontos
    WHERE normalizar_texto(banco) = v_banco_norm
      AND normalizar_texto(produto) = normalizar_texto(v_produto)
      AND ativo = TRUE
    ORDER BY 
      CASE WHEN prazos LIKE '%' || COALESCE(p_parcelas, 0) || '%' THEN 0 ELSE 1 END,
      LENGTH(prazos) DESC
    LIMIT 1;
    
    IF v_pontos IS NOT NULL THEN
      RETURN v_pontos;
    END IF;
  END IF;
  
  -- 3) Fallback: função antiga
  RETURN calc_peso_vendas_legacy(p_banco, p_tabela, p_parcelas, p_seguro);
END;
$$;

GRANT EXECUTE ON FUNCTION buscar_pontos_tabela TO anon;
GRANT EXECUTE ON FUNCTION normalizar_texto TO anon;

-- =========================================================
-- 3. RENOMEAR FUNÇÃO ANTIGA + CRIAR NOVA COM LOOKUP
-- =========================================================

-- Primeiro, renomear a função antiga como "legacy"
DROP FUNCTION IF EXISTS calc_peso_vendas_legacy(text, text, int, text);
CREATE OR REPLACE FUNCTION calc_peso_vendas_legacy(
  p_banco text,
  p_tabela text,
  p_parcelas int,
  p_seguro text
)
returns numeric
language plpgsql
immutable
as $$
declare
  banco_norm text := upper(replace(coalesce(p_banco, ''), '_', ' '));
  tabela_norm text := upper(coalesce(p_tabela, ''));
  codigo text;
  tem_seguro boolean := upper(coalesce(p_seguro, '')) in ('SIM', 'S', 'TRUE', '1', 'COM SEGURO', 'COM');
  parcelas_texto int := nullif(substring(upper(coalesce(p_tabela, '')) from '[^0-9A-Za-z]([0-9]{1,2})(?:[^0-9]|$)'), '')::int;
  tem_seguro_efetivo boolean := case
    when p_seguro is not null and trim(p_seguro) <> '' then tem_seguro
    when upper(coalesce(p_tabela, '')) like '%S/SEGURO%' or upper(coalesce(p_tabela, '')) like '%SEM SEGURO%' then false
    when upper(coalesce(p_tabela, '')) like '%C/SEGURO%' or upper(coalesce(p_tabela, '')) like '%COM SEGURO%' then true
    else tem_seguro
  end;
begin
  codigo := substring(tabela_norm from '[0-9]{4,6}');

  if banco_norm like '%FACTA%' then
    if codigo = '69205' then return 1.45; end if;
    if codigo in ('69191','69183','69035','69027','69043','69051') then return 1.35; end if;
    if codigo in ('69167','69175') then return 1.25; end if;
    if codigo = '69159' then return 1.20; end if;
    if codigo in ('69140','69060') then return 1.15; end if;
    if codigo = '69132' then return 1.10; end if;
    if codigo in ('692213','69221','69230') then return 1.10; end if;
    if codigo in ('69078','69086') then return 0.90; end if;
    if codigo = '69213' then return 0.90; end if;
    if codigo = '69116' then return 0.90; end if;
    if codigo in ('69019','69094') then return 0.80; end if;
    if codigo = '69272' then return 0.90; end if;
    if codigo = '69264' then return 0.80; end if;
    if codigo = '69256' then return 0.70; end if;
    if codigo = '69280' then return 0.60; end if;
    if codigo in ('61107','61093','61085') then return 0.35; end if;
    if codigo in ('69299','69302') then return 0.35; end if;
    if codigo in ('64815','64823','64831') then return 0.00; end if;
    if codigo in ('66044','65943') then return 0.75; end if;
    if codigo in ('66060','66052','65951') then return 0.90; end if;
    if codigo = '641130' then return 0.75; end if;
    if codigo = '64181' then return 0.60; end if;
    if codigo in ('61433','64785') then return 0.30; end if;
    if codigo in ('66036','66028') then
      if p_parcelas = 60 then return 1.15; end if;
      if p_parcelas = 48 then return 1.00; end if;
      return null;
    end if;
    if codigo = '66010' then
      if p_parcelas = 48 then return 1.00; end if;
      if p_parcelas = 36 then return 0.90; end if;
      return null;
    end if;
    if codigo in ('66095','66087') then
      if p_parcelas in (48,60) then return 0.80; end if;
      if p_parcelas = 36 then return 0.65; end if;
      return null;
    end if;
    if codigo in ('66079','65935') then
      if p_parcelas = 36 then return 0.65; end if;
      if p_parcelas = 24 then return 0.55; end if;
      return null;
    end if;
    return null;
  end if;

  if banco_norm like '%CREFAZ%' then
    if p_parcelas is not null then
      if p_parcelas between 9 and 24 then return 1.65; end if;
      if p_parcelas between 1 and 8 then return 1.30; end if;
      return null;
    end if;
    if tabela_norm ~ '9\s*-\s*24' or tabela_norm ~ '9\s*A\s*24' then return 1.65; end if;
    if tabela_norm ~ '1\s*-\s*8' or tabela_norm ~ '1\s*A\s*8' then return 1.30; end if;
    return null;
  end if;

  if banco_norm like '%PAN%' then return 0.80; end if;
  if banco_norm like '%MERCANTIL%' then return 1.10; end if;
  if banco_norm like '%PRESEN%' then
    return case coalesce(p_parcelas, nullif(substring(tabela_norm from '[0-9]{2}'), '')::int)
      when 48 then 1.75
      when 36 then 1.25
      when 26 then 0.75
      when 24 then 0.60
      when 18 then 0.20
      else null
    end;
  end if;

  if banco_norm like '%SOMA%' then
    if codigo is not null then
      return case codigo
        when '2267' then 1.50
        when '2266' then 1.35
        when '2265' then 1.15
        when '2283' then 1.15
        when '2264' then 0.80
        when '2282' then 0.80
        when '2263' then 0.65
        when '2281' then 0.60
        when '2280' then 0.45
        when '2275' then 0.45
        when '2274' then 0.45
        when '2273' then 0.30
        when '2272' then 0.30
        when '2279' then 0.25
        when '2271' then 0.15
        else null
      end;
    end if;
    if tem_seguro then
      return case p_parcelas
        when 48 then 1.50
        when 42 then 1.35
        when 36 then 1.15
        when 30 then 0.80
        when 24 then 0.65
        when 18 then 0.45
        when 12 then 0.25
        else null
      end;
    else
      return case p_parcelas
        when 48 then 0.45
        when 42 then 0.45
        when 36 then 0.30
        when 30 then 0.30
        when 24 then 0.15
        else null
      end;
    end if;
  end if;

  if banco_norm like '%NOVO SAQUE%' or (trim(banco_norm) = '' and tabela_norm ~ '(^|[^A-Z])(TABELA )?(NS|CAMPANHA|DIAMANTE|GOLD|MONEY|LIGHT|SOFT|SMART|ZERO)([^A-Z]|$)') then
    if tabela_norm like '%CAMPANHA%' then return 9.50; end if;
    if tabela_norm like '%DIAMANTE%' then return 7.50; end if;
    if tabela_norm like '%GOLD%' then return 6.00; end if;
    if tabela_norm like '%MONEY%' then return 4.50; end if;
    if tabela_norm like '%LIGHT%' then return 3.50; end if;
    if tabela_norm like '%SOFT%' then return 2.00; end if;
    if tabela_norm like '%SMART%' then return 1.10; end if;
    if tabela_norm like '%ZERO%' then return 0.70; end if;
    if tabela_norm like '%NS%' or tabela_norm like '%NOVO SAQUE%' then return 12.00; end if;
    return null;
  end if;

  if banco_norm like '%V8%' then
    if tabela_norm like '%ACELERA%' then return 12.00; end if;
    if tabela_norm like '%COMETA%' then return 9.00; end if;
    if tabela_norm like '%GRID%' then return 6.00; end if;
    if tabela_norm like '%TURBO%' then return 5.50; end if;
    if tabela_norm like '%PIT STOP%' or tabela_norm like '%PITSTOP%' then return 1.80; end if;
    if tabela_norm like '%NORMAL%' then return 4.50; end if;
  end if;

  if banco_norm like '%V8%' then
    if tabela_norm like '%PLUS%' then return 3.50; end if;
    if tabela_norm like '%SMART%' then return 2.50; end if;
    if tabela_norm like '%GOLD%' then return 2.00; end if;
    if tabela_norm like '%TOP%' then return 1.50; end if;
    if tabela_norm like '%PRIME%' then return 1.20; end if;
    return null;
  end if;

  if banco_norm like '%C6%' then
    if tabela_norm like '%TOP PLAN%13%' and p_parcelas = 48 then return 1.35; end if;
    if tabela_norm like '%TOP PLAN%13%' and p_parcelas = 36 then return 1.20; end if;
    if tabela_norm like '%TOP PLAN%13%' and p_parcelas = 24 then return 1.20; end if;
    if tabela_norm like '%TOP PLAN%13%' then return 1.20; end if;
    return null;
  end if;

  if banco_norm like '%ITAU%' then
    if tem_seguro_efetivo then
      return case p_parcelas
        when 48 then 0.95
        when 36 then 0.80
        when 24 then 0.65
        else null
      end;
    else
      return case p_parcelas
        when 48 then 0.70
        when 36 then 0.55
        when 24 then 0.40
        else null
      end;
    end if;
  end if;

  if banco_norm like '%BRADESCO%' then
    return case p_parcelas
      when 48 then 0.85
      when 36 then 0.70
      when 24 then 0.55
      else null
    end;
  end if;

  return null;
end;
$$;

-- DROP E RECREATE da função principal com lookup
DROP FUNCTION IF EXISTS calc_peso_vendas(text, text, int, text);

CREATE OR REPLACE FUNCTION calc_peso_vendas(
  p_banco text,
  p_tabela text,
  p_parcelas int,
  p_seguro text
)
returns numeric
language plpgsql
immutable
as $$
declare
  v_peso_tabela numeric;
begin
  -- NOVO: Primeiro tenta buscar na tabela_pontos (válido a partir de 01/09/2026)
  v_peso_tabela := buscar_pontos_tabela(p_banco, p_tabela, p_parcelas, p_seguro);
  
  if v_peso_tabela is not null then
    return v_peso_tabela;
  end if;

  -- Fallback: usa função legacy para compatibilidade
  return calc_peso_vendas_legacy(p_banco, p_tabela, p_parcelas, p_seguro);
end;
$$;

GRANT EXECUTE ON FUNCTION calc_peso_vendas TO anon;
GRANT EXECUTE ON FUNCTION calc_peso_vendas_legacy TO anon;

-- =========================================================
-- 4. IMPORTAR DADOS (93 linhas do Excel TABELA_PONTOS_01_09)
-- =========================================================

INSERT INTO tabela_pontos (banco, produto, nome_tabela, regras_especificas, prazos, pontos, ativo)
VALUES
  ('CREFAZ', 'CONTA DE LUZ', 'EMPRÉSTIMO NA CONTA DE LUZ', NULL, '1 a 8 parcelas', 1.3, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 13 C/SEGURO', NULL, '48 parcelas', 1.35, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 10, 9, 8, 6 E 4 - TODAS C/SEGURO', NULL, '48 parcelas', 1.2, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 13, 10, 9, 8 E 6  - TODAS C/SEGURO', NULL, '36 parcelas', 1.2, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 13 C/SEGURO', NULL, '24 parcelas', 1.2, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 3,  2 E 1 - PLAN 13, 10, 9, 8, 6 E 4 - TODAS C/SEGURO', NULL, '48 parcelas', 1.0, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 4, 3, 2 E 1 - PLAN 13, 10, 9, E 6 - TODAS C/SEGURO', NULL, '36 parcelas', 1.0, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 10, 9, 8, 6, 4 E  3  - PLAN 13 - TODAS C/SEGURO', NULL, '24 parcelas', 1.0, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 13, 10, 9, 8, 6 E 4 - TODAS C/SEGURO', NULL, '18 parcelas', 1.0, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN13 C/SEGURO', NULL, '14 parcelas', 1.0, TRUE),
  ('C6', 'CONS. PRIVADO', 'PLAN 3, 2 E 1 - TODAS C/SEGURO', NULL, '48 parcelas', 0.8, TRUE),
  ('C6', 'CONS. PRIVADO', 'NOVO - SEM SEGURO', NULL, '48 parcelas', 0.8, TRUE),
  ('C6', 'CONS. PRIVADO', 'PLAN  4, 3,  2 E 1 - TODAS C/ SEGURO', NULL, '36 parcelas', 0.8, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 2 E 1 - PLAN 10, 9, 8, 6, 4 E 3 -  TODAS C/SEGURO', NULL, '24 parcelas', 0.8, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 3, 2 E 1 - PLAN 13, 10, 9, 8, 6 E 4 - TODAS C/SEGURO', NULL, '18 parcelas', 0.8, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 10, 9, 8, 6, 4 E 3 -  PLAN 13 - TODAS C/SEGURO', NULL, '14 parcelas', 0.8, TRUE),
  ('C6', 'CONS. PRIVADO', 'NOVO - SEM SEGURO', NULL, '36 parcelas', 0.7, TRUE),
  ('C6', 'CONS. PRIVADO', 'PLAN 2 E 1 - TODAS C/SEGURO', NULL, '24 parcelas', 0.7, TRUE),
  ('C6', 'CONS. PRIVADO', 'PLAN 3 E 2 - TODAS C/SEGURO', NULL, '18 parcelas', 0.7, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 2 E 1 - PLAN 10 E 9 - TODAS C/SEGURO', NULL, '14 parcelas', 0.7, TRUE),
  ('C6', 'CONS. PRIVADO', 'NOVO - SEM SEGURO', NULL, '24 parcelas', 0.6, TRUE),
  ('C6', 'CONS. PRIVADO', 'PLAN 1 C/SEGURO E NOVO SEM SEGURO', NULL, '18 parcelas', 0.6, TRUE),
  ('C6', 'CONS. PRIVADO', 'PLAN 8, 6, 4 E 3 - TODAS C/SEGURO', NULL, '14 parcelas', 0.6, TRUE),
  ('C6', 'CONS. PRIVADO', 'PLAN 2 E 1 C/SEGURO E NOVO SEM SEGURO', NULL, '14 parcelas', 0.5, TRUE),
  ('C6', 'CONS. PRIVADO', 'ESP PLAN 6 C/ SEGURO', NULL, '18 parcelas', 0.35, TRUE),
  ('C6', 'CONS. PRIVADO', 'ESP PLAN 4 C/ SEGURO', NULL, '18 parcelas', 0.3, TRUE),
  ('C6', 'CONS. PRIVADO', 'ESP PLAN 4 C/ SEGURO', NULL, '14 parcelas', 0.3, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69205 - NOVO GOLD', NULL, '60 parcelas', 1.45, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69191/69183/69035/69027/69043/69051 - NOVO GOLD', NULL, '36 ou 48 parcelas', 1.35, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69167/69175 - NOVO GOLD', NULL, '24 ou 60 parcelas', 1.25, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69159 - NOVO GOLD', NULL, '48 parcelas', 1.2, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69140/69060 - NOVO GOLD', NULL, '24 ou 36 parcelas', 1.15, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69132- NOVO GOLD', NULL, '24 parcelas', 1.1, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69213/69221 - NOVO SMART', NULL, '24, 36, 48 ou 60 parcelas', 1.1, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69230 - NOVO SMART', NULL, '36 ou 48 parcelas', 1.1, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69078/69086 - NOVO GOLD', NULL, '36 ou 48 parcelas', 0.9, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69213 - NOVO SMART', NULL, '24 parcelas', 0.9, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69116 - NOVO SMART', NULL, '24, 36 ou 48 parcelas', 0.9, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69019/69094 - NOVO GOLD', NULL, '24 parcelas', 0.8, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69230 - NOVO SMART', NULL, '24 parcelas', 0.7, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69272 - REFIN GOLD POWER', NULL, '36, 48 ou 60 parcelas', 0.9, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69264 - REFIN GOLD PLUS', NULL, '36, 48 ou 60 parcelas', 0.8, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69256 - REFIN GOLD PRIME', NULL, '36, 48 ou 60 parcelas', 0.7, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69248 - NOVO SMART', NULL, '24, 36 ou 48 parcelas', 0.6, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69280 - REFIN', NULL, '36, 48 ou 60 parcelas', 0.6, TRUE),
  ('FACTA', 'CONS. PRIVADO', 'PORTABILIDADE - MAIOR QUE 12 PAGAS - 61107/61093/61085', NULL, '1 a 48 parcelas', 0.35, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69299/69302 - REFIN DA PORT', NULL, '36 e 60 parcelas', 0.35, TRUE),
  ('FACTA', 'CONS. PRIVADO', 'PORTABILIDADE - MENOR QUE 12 PAGAS - 64815/64823/64831', NULL, '1 a 48 parcelas', 0.0, TRUE),
  ('MERCANTIL', 'CONS. PRIVADO', 'MERCANTIL (SUP) - CONS. DO TRABALHADOR - NOVO', 'Com ou sem seguro.', '36 ou 48 parcelas', 1.1, TRUE),
  ('PAN', 'CONS. PRIVADO', 'CONSIG_PRIVADO_NOV_NORMAL', 'Com seguro ou sem seguro.', 'De 6 a 36 parcelas', 0.8, TRUE),
  ('PRESENÇA', 'CONS. PRIVADO', 'PRESENÇA BANK - NOVO - TX 4,98%', 'Com seguro.', '48 parcelas', 1.75, TRUE),
  ('PRESENÇA', 'CONS. PRIVADO', 'PRESENÇA BANK - NOVO - TX 4,98%', 'Com seguro.', '36 parcelas', 1.25, TRUE),
  ('PRESENÇA', 'CONS. PRIVADO', 'PRESENÇA BANK - NOVO - TX 4,98%', 'Com seguro.', '24 parcelas', 0.6, TRUE),
  ('PRESENÇA', 'CONS. PRIVADO', 'PRESENÇA BANK - NOVO - TX 4,98%', 'Com seguro.', '18 parcelas', 0.2, TRUE),
  ('PRESENÇA', 'CONS. PRIVADO', 'PRESENÇA BANK - NOVO - TX 4,98%', 'ESPECIAL Com seguro.', '36 parcelas', 0.75, TRUE),
  ('PRESENÇA', 'CONS. PRIVADO', 'PRESENÇA BANK - NOVO - TX 4,98%', 'ESPECIAL Com seguro.', '24 parcelas', 0.6, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2267 - Bancarizadora CELCOIN', 'Com seguro.', '48 parcelas', 1.5, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2687 - Bancarizadora UY3', 'Com seguro.', '48 parcelas', 1.4, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2266 - Bancarizadora CELCOIN', 'Com seguro.', '42 parcelas', 1.35, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2265 - Bancarizadora CELCOIN', 'Com seguro.', '36 parcelas', 1.15, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2283 - Bancarizadora UY3', 'Com seguro.', '36 parcelas', 1.15, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2264 - Bancarizadora CELCOIN', 'Com seguro.', '30 parcelas', 0.8, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2282 - Bancarizadora UY3', 'Com seguro.', '30 parcelas', 0.8, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2263 - Bancarizadora CELCOIN', 'Com seguro.', '24 parcelas', 0.65, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2281 - Bancarizadora UY3', 'Com seguro.', '24 parcelas', 0.6, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2280 - Bancarizadora UY3', 'Com seguro.', '18 parcelas', 0.45, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabelas 2275 e 2274 - Bancarizadora CELCOIN', 'Sem seguro.', '42 ou 48 parcelas', 0.45, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabelas 2273 e 2272 - Bancarizadora CELCOIN', 'Sem seguro.', '30 ou 36 parcelas', 0.3, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2279 - Bancarizadora UY3', 'Com seguro.', '12 parcelas', 0.25, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2271 - Bancarizadora CELCOIN', 'Sem seguro.', '24 parcelas', 0.15, TRUE),
  ('V8', 'CONS. PRIVADO', 'CLT ACELERA', 'Com seguro.', '46 ou 48 parcelas', 1.9, TRUE),
  ('V8', 'CONS. PRIVADO', 'CLT ACELERA', 'Com seguro.', '24, 36 ou 38 parcelas', 1.4, TRUE),
  ('V8', 'CONS. PRIVADO', 'CLT ACELERA', 'Com seguro.', '18 parcelas', 0.9, TRUE),
  ('V8', 'CONS. PRIVADO', 'CLT ACELERA', 'Com seguro.', '12 parcelas', 0.8, TRUE),
  ('V8', 'CONS. PRIVADO', 'CLT ACELERA', 'Com seguro.', '3 a 11 parcelas', 0.6, TRUE),
  ('V8', 'CONS. PRIVADO', 'CLT ACELERA', 'Sem seguro.', '24 a 48 parcelas', 0.6, TRUE),
  ('V8', 'CONS. PRIVADO', 'CLT ACELERA', 'Sem seguro.', '12 ou 18 parcelas', 0.4, TRUE),
  ('V8', 'CONS. PRIVADO', 'CLT ACELERA', 'Sem seguro.', '3 a 11 parcelas', 0.2, TRUE),
  ('NOVO SAQUE', 'FGTS', 'TABELA NS', NULL, 'Prazos de 1 a 5 parcelas', 12.0, TRUE),
  ('NOVO SAQUE', 'FGTS', 'TABELA CAMPANHA', NULL, 'Prazos de 1 a 5 parcelas', 9.5, TRUE),
  ('NOVO SAQUE', 'FGTS', 'TABELA DIAMANTE', NULL, 'Prazos de 1 a 5 parcelas', 7.5, TRUE),
  ('NOVO SAQUE', 'FGTS', 'TABELA GOLD', NULL, 'Prazos de 1 a 5 parcelas', 6.0, TRUE),
  ('NOVO SAQUE', 'FGTS', 'TABELA MONEY', NULL, 'Prazos de 1 a 5 parcelas', 4.5, TRUE),
  ('NOVO SAQUE', 'FGTS', 'TABELA LIGHT', NULL, 'Prazos de 1 a 5 parcelas', 3.5, TRUE),
  ('NOVO SAQUE', 'FGTS', 'TABELA SOFT', NULL, 'Prazos de 1 a 5 parcelas', 2.0, TRUE),
  ('NOVO SAQUE', 'FGTS', 'TABELA SMART', NULL, 'Prazos de 1 a 5 parcelas', 1.1, TRUE),
  ('NOVO SAQUE', 'FGTS', 'TABELA ZERO', NULL, 'Prazos de 1 a 5 parcelas', 0.7, TRUE),
  ('V8', 'FGTS', 'ACELERA 2.0', NULL, 'Prazos de 1 a 5 parcelas', 11.5, TRUE),
  ('V8', 'FGTS', 'COMETA EXCLUSIVA BMS', NULL, 'Prazos de 1 a 5 parcelas', 8.8, TRUE),
  ('V8', 'FGTS', 'GRID', NULL, 'Prazos de 1 a 5 parcelas', 6.0, TRUE),
  ('V8', 'FGTS', 'TURBO', NULL, 'Prazos de 1 a 5 parcelas', 5.8, TRUE),
  ('V8', 'FGTS', 'NORMAL', NULL, 'Prazos de 1 a 5 parcelas', 4.5, TRUE),
  ('V8', 'FGTS', 'PITSTOP', NULL, 'Prazos de 1 a 5 parcelas', 1.8, TRUE)
ON CONFLICT DO NOTHING;

-- =========================================================
-- 5. GRANT PERMISSIONS
-- =========================================================

GRANT SELECT ON TABLE tabela_pontos TO anon;
GRANT SELECT ON TABLE tabela_pontos_historico TO anon;

EOFFALL

echo "✓ Arquivo de migration criado: alteracao_tabela_pontos_01_09.sql"
wc -l /tmp/dashboard/alteracao_tabela_pontos_01_09.sql
