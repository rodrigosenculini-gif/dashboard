-- =========================================================
-- CORREÇÃO (substitui o commit anterior 0a01aeb, que continha
-- valores inventados para V8 privado / Itaú / Bradesco na
-- função de fallback — nunca chegou a rodar no banco).
--
-- Descoberta em produção: a função calc_peso_vendas(5 args),
-- já chamada pelo trigger trg_vendas_gerais_calcula com new.data,
-- já tratava boa parte da transição de 01/09/2026 direto no
-- código (FACTA 69213/69230/69248, PRESENÇA, V8 FGTS, V8 CLT
-- Acelera). Essa lógica foi preservada 100% verbatim abaixo,
-- só renomeada para calc_peso_vendas_legado.
--
-- O que este arquivo adiciona de fato:
--  - tabela_pontos: repositório editável de pesos, com vigência
--    por data (vigencia_inicio/vigencia_fim), para consulta e
--    correção manual futura sem precisar mexer em função SQL.
--  - Suporte a C6 (26 tabelas) e SOMA "2687" (bancarizadora UY3),
--    que não existiam em NENHUMA versão anterior da função.
--  - calc_peso_vendas(5 args) passa a consultar tabela_pontos
--    primeiro; se não achar, cai no calc_peso_vendas_legado
--    (comportamento anterior, intacto).
-- =========================================================

CREATE TABLE IF NOT EXISTS tabela_pontos (
  id BIGSERIAL PRIMARY KEY,
  banco TEXT NOT NULL,
  produto TEXT NOT NULL,
  nome_tabela TEXT,
  regras_especificas TEXT,
  prazos TEXT NOT NULL,
  pontos NUMERIC NOT NULL CHECK (pontos >= 0),
  vigencia_inicio DATE,
  vigencia_fim DATE,
  ativo BOOLEAN DEFAULT TRUE,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tabela_pontos_banco ON tabela_pontos(banco);
CREATE INDEX IF NOT EXISTS idx_tabela_pontos_vigencia ON tabela_pontos(vigencia_inicio, vigencia_fim);
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
  NEW.atualizado_em := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_historico_pontos ON tabela_pontos;
CREATE TRIGGER trigger_historico_pontos
BEFORE UPDATE ON tabela_pontos
FOR EACH ROW
EXECUTE FUNCTION atualizar_historico_pontos();

-- Parser de prazos: "1 a 8 parcelas", "36, 48 ou 60 parcelas",
-- "De 6 a 36 parcelas", "12 ou 18 parcelas" etc.
CREATE OR REPLACE FUNCTION prazos_contem(p_prazos TEXT, p_parcelas INT)
RETURNS BOOLEAN
LANGUAGE PLPGSQL
IMMUTABLE
AS $$
DECLARE
  txt TEXT := upper(coalesce(p_prazos, ''));
  lo INT;
  hi INT;
  nums INT[];
BEGIN
  IF p_parcelas IS NULL THEN
    RETURN FALSE;
  END IF;

  IF txt ~ '[0-9]+\s*A\s*[0-9]+' THEN
    lo := substring(txt from '([0-9]+)\s*A\s*[0-9]+')::int;
    hi := substring(txt from '[0-9]+\s*A\s*([0-9]+)')::int;
    RETURN p_parcelas BETWEEN lo AND hi;
  END IF;

  SELECT array_agg(m[1]::int) INTO nums
  FROM regexp_matches(txt, '([0-9]+)', 'g') AS m;

  RETURN nums IS NOT NULL AND p_parcelas = ANY(nums);
END;
$$;

CREATE OR REPLACE FUNCTION normalizar_texto(txt TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT upper(trim(coalesce(txt, '')));
$$;

-- Lookup na tabela_pontos, considerando vigência por data
CREATE OR REPLACE FUNCTION buscar_pontos_tabela(
  p_banco TEXT,
  p_tabela TEXT,
  p_parcelas INT,
  p_seguro TEXT,
  p_data DATE
)
RETURNS NUMERIC
LANGUAGE PLPGSQL
STABLE
AS $$
DECLARE
  v_pontos NUMERIC;
  v_banco_norm TEXT := normalizar_texto(p_banco);
  v_data DATE := coalesce(p_data, current_date);
BEGIN
  SELECT pontos INTO v_pontos
  FROM tabela_pontos
  WHERE normalizar_texto(banco) = v_banco_norm
    AND ativo = TRUE
    AND (vigencia_inicio IS NULL OR v_data >= vigencia_inicio)
    AND (vigencia_fim IS NULL OR v_data <= vigencia_fim)
    AND prazos_contem(prazos, p_parcelas)
    AND (
      nome_tabela IS NULL
      OR normalizar_texto(p_tabela) LIKE '%' || normalizar_texto(nome_tabela) || '%'
      OR normalizar_texto(nome_tabela) LIKE '%' || normalizar_texto(p_tabela) || '%'
    )
  ORDER BY length(coalesce(nome_tabela, '')) DESC
  LIMIT 1;

  RETURN v_pontos;
END;
$$;

GRANT EXECUTE ON FUNCTION prazos_contem(text, int) TO anon;
GRANT EXECUTE ON FUNCTION normalizar_texto(text) TO anon;
GRANT EXECUTE ON FUNCTION buscar_pontos_tabela(text, text, int, text, date) TO anon;

-- Lógica de produção ATUAL (5 args), preservada verbatim sob
-- novo nome — usada como fallback quando não há linha em tabela_pontos
CREATE OR REPLACE FUNCTION calc_peso_vendas_legado(
  p_banco text,
  p_tabela text,
  p_parcelas integer,
  p_seguro text,
  p_data date DEFAULT NULL::date
)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $function$
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
  eh_clt boolean := tabela_norm like '%CLT%';
  eh_facta boolean;
  eh_tabela_nova boolean := p_data is not null and p_data >= date '2026-09-01';
  parc int := coalesce(p_parcelas, parcelas_texto);
begin
  codigo := substring(tabela_norm from '[0-9]{4,6}');
  eh_facta := banco_norm like '%FACTA%'
    or (trim(banco_norm) = '' and codigo is not null and codigo ~ '^6[0-9]{4}$');

  if eh_facta then
    if codigo = '69205' then return 1.45; end if;
    if codigo in ('69191','69183','69035','69027','69043','69051') then return 1.35; end if;
    if codigo in ('69167','69175') then return 1.25; end if;
    if codigo = '69159' then return 1.20; end if;
    if codigo in ('69140','69060') then return 1.15; end if;
    if codigo = '69132' then return 1.10; end if;

    if codigo = '69221' then return 1.10; end if;
    if codigo = '69213' then
      if eh_tabela_nova then
        if parc = 24 then return 0.90; end if;
        if parc in (36,48,60) then return 1.10; end if;
        return null;
      else
        return 1.10;
      end if;
    end if;
    if codigo = '69230' then
      if eh_tabela_nova then
        if parc = 24 then return 0.70; end if;
        if parc in (36,48) then return 1.10; end if;
        return null;
      else
        return 1.10;
      end if;
    end if;

    if codigo in ('69078','69086') then return 0.90; end if;
    if codigo = '69116' then return 0.90; end if;
    if codigo in ('69019','69094') then return 0.80; end if;
    if codigo = '69272' then return 0.90; end if;
    if codigo = '69264' then return 0.80; end if;
    if codigo = '69256' then return 0.70; end if;

    if codigo = '69248' then
      return case when eh_tabela_nova then 0.60 else 0.90 end;
    end if;

    if codigo = '69280' then return 0.60; end if;
    if codigo in ('61107','61093','61085') then return 0.35; end if;
    if codigo in ('69299','69302') then return 0.35; end if;
    if codigo in ('64815','64823','64831') then return 0.00; end if;
    if codigo in ('66044','65943') then return 0.75; end if;
    if codigo in ('66060','66052','65951') then return 0.90; end if;
    if codigo = '641130' then return 0.75; end if;
    if codigo = '64181' then return 0.60; end if;
    if codigo in ('61433','64785') then return 0.30; end if;
    if codigo = '68489' then return 0.60; end if;
    if codigo = '64173' then return 1.45; end if;
    if codigo = '65960' then return 0.80; end if;
    if codigo = '65978' then return 1.20; end if;

    if codigo in ('66036','66028') then
      if parc = 60 then return 1.15; end if;
      if parc = 48 then return 1.00; end if;
      return null;
    end if;
    if codigo = '66010' then
      if parc = 48 then return 1.00; end if;
      if parc = 36 then return 0.90; end if;
      return null;
    end if;
    if codigo in ('66095','66087') then
      if parc in (48,60) then return 0.80; end if;
      if parc = 36 then return 0.65; end if;
      return null;
    end if;
    if codigo in ('66079','65935') then
      if parc = 36 then return 0.65; end if;
      if parc = 24 then return 0.55; end if;
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
    if eh_tabela_nova and tabela_norm like '%ESPECIAL%' then
      return case parc when 36 then 0.75 when 24 then 0.60 else null end;
    end if;
    if eh_tabela_nova then
      return case parc when 48 then 1.75 when 36 then 1.25 when 24 then 0.60 when 18 then 0.20 else null end;
    end if;
    return case parc
      when 48 then 1.75 when 36 then 1.25 when 26 then 0.75 when 24 then 0.60 when 18 then 0.20
      else null end;
  end if;

  if banco_norm like '%SOMA%' then
    if codigo is not null then
      return case codigo
        when '2267' then 1.50 when '2266' then 1.35 when '2265' then 1.15 when '2283' then 1.15
        when '2264' then 0.80 when '2282' then 0.80 when '2263' then 0.65 when '2281' then 0.60
        when '2280' then 0.45 when '2275' then 0.45 when '2274' then 0.45 when '2273' then 0.30
        when '2272' then 0.30 when '2279' then 0.25 when '2271' then 0.15
        else null end;
    end if;
    if tem_seguro then
      return case p_parcelas when 48 then 1.50 when 42 then 1.35 when 36 then 1.15 when 30 then 0.80
        when 24 then 0.65 when 18 then 0.45 when 12 then 0.25 else null end;
    else
      return case p_parcelas when 48 then 0.45 when 42 then 0.45 when 36 then 0.30 when 30 then 0.30
        when 24 then 0.15 else null end;
    end if;
  end if;

  if banco_norm like '%NOVO SAQUE%'
     or (
       trim(banco_norm) = ''
       and not (codigo is not null and codigo ~ '^6[0-9]{4}$')
       and tabela_norm ~ '(^|[^A-Z])(TABELA )?(NS|CAMPANHA|DIAMANTE|GOLD|MONEY|LIGHT|SOFT|SMART|ZERO)([^A-Z]|$)'
     )
  then
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

  if banco_norm like '%V8%' and not eh_clt then
    if tabela_norm like '%ACELERA%' then return case when eh_tabela_nova then 11.50 else 12.00 end; end if;
    if tabela_norm like '%COMETA%' then return case when eh_tabela_nova then 8.80 else 9.00 end; end if;
    if tabela_norm like '%GRID%' then return 6.00; end if;
    if tabela_norm like '%TURBO%' then return case when eh_tabela_nova then 5.80 else 5.50 end; end if;
    if tabela_norm like '%PIT STOP%' or tabela_norm like '%PITSTOP%' then return 1.80; end if;
    if tabela_norm like '%NORMAL%' then return 4.50; end if;
    if parc between 1 and 5 then return case when eh_tabela_nova then 11.50 else 12.00 end; end if;
  end if;

  if banco_norm like '%V8%' then
    if eh_tabela_nova then
      if tem_seguro_efetivo then
        if parc in (46,48) then return 1.90; end if;
        if parc in (24,36,38) then return 1.40; end if;
        if parc = 18 then return 0.90; end if;
        if parc = 12 then return 0.80; end if;
        if parc between 3 and 11 then return 0.60; end if;
        return null;
      else
        if parc between 24 and 48 then return 0.60; end if;
        if parc in (12,18) then return 0.40; end if;
        if parc between 3 and 11 then return 0.20; end if;
        return null;
      end if;
    else
      if tem_seguro_efetivo then
        return case parc
          when 46 then 2.40 when 36 then 2.20 when 24 then 1.60 when 18 then 1.40 when 12 then 1.20
          when 6 then 0.60 when 8 then 0.60 when 10 then 0.60 else null end;
      else
        return case parc
          when 46 then 1.40 when 36 then 1.20 when 24 then 1.00 when 12 then 0.80 when 18 then 0.80
          when 6 then 0.20 when 8 then 0.20 when 10 then 0.20 else null end;
      end if;
    end if;
  end if;

  return null;
end;
$function$;

GRANT EXECUTE ON FUNCTION calc_peso_vendas_legado(text, text, int, text, date) TO anon;

-- calc_peso_vendas (5 args) — a que o trigger trg_vendas_gerais_calcula
-- realmente chama (passando new.data). Agora tenta tabela_pontos
-- primeiro; senão usa calc_peso_vendas_legado.
CREATE OR REPLACE FUNCTION calc_peso_vendas(
  p_banco text,
  p_tabela text,
  p_parcelas integer,
  p_seguro text,
  p_data date DEFAULT NULL::date
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_pontos numeric;
BEGIN
  v_pontos := buscar_pontos_tabela(p_banco, p_tabela, p_parcelas, p_seguro, p_data);

  IF v_pontos IS NOT NULL THEN
    RETURN v_pontos;
  END IF;

  RETURN calc_peso_vendas_legado(p_banco, p_tabela, p_parcelas, p_seguro, p_data);
END;
$$;

GRANT EXECUTE ON FUNCTION calc_peso_vendas(text, text, int, text, date) TO anon;

-- Nota: a função calc_peso_vendas(4 args, sem data) já existia em
-- produção antes desta alteração e NÃO foi tocada. O trigger não
-- a utiliza (usa a de 5 args acima); ela permanece disponível para
-- eventual compatibilidade com chamadas externas antigas.

-- Dados: 93 linhas do Excel TABELA_PONTOS_01_09, vigentes a partir
-- de 01/09/2026 (vigencia_fim NULL = em vigor). Cobre C6 (26 linhas)
-- e SOMA "2687" (bancarizadora UY3), que não existiam em nenhuma
-- versão anterior da função.
INSERT INTO tabela_pontos (banco, produto, nome_tabela, regras_especificas, prazos, pontos, vigencia_inicio, vigencia_fim, ativo)
VALUES
  ('CREFAZ', 'CONTA DE LUZ', 'EMPRÉSTIMO NA CONTA DE LUZ', NULL, '1 a 8 parcelas', 1.3, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 13 C/SEGURO', NULL, '48 parcelas', 1.35, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 10, 9, 8, 6 E 4 - TODAS C/SEGURO', NULL, '48 parcelas', 1.2, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 13, 10, 9, 8 E 6  - TODAS C/SEGURO', NULL, '36 parcelas', 1.2, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 13 C/SEGURO', NULL, '24 parcelas', 1.2, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 3,  2 E 1 - PLAN 13, 10, 9, 8, 6 E 4 - TODAS C/SEGURO', NULL, '48 parcelas', 1.0, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 4, 3, 2 E 1 - PLAN 13, 10, 9, E 6 - TODAS C/SEGURO', NULL, '36 parcelas', 1.0, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 10, 9, 8, 6, 4 E  3  - PLAN 13 - TODAS C/SEGURO', NULL, '24 parcelas', 1.0, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 13, 10, 9, 8, 6 E 4 - TODAS C/SEGURO', NULL, '18 parcelas', 1.0, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN13 C/SEGURO', NULL, '14 parcelas', 1.0, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'PLAN 3, 2 E 1 - TODAS C/SEGURO', NULL, '48 parcelas', 0.8, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'NOVO - SEM SEGURO', NULL, '48 parcelas', 0.8, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'PLAN  4, 3,  2 E 1 - TODAS C/ SEGURO', NULL, '36 parcelas', 0.8, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 2 E 1 - PLAN 10, 9, 8, 6, 4 E 3 -  TODAS C/SEGURO', NULL, '24 parcelas', 0.8, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 3, 2 E 1 - PLAN 13, 10, 9, 8, 6 E 4 - TODAS C/SEGURO', NULL, '18 parcelas', 0.8, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 10, 9, 8, 6, 4 E 3 -  PLAN 13 - TODAS C/SEGURO', NULL, '14 parcelas', 0.8, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'NOVO - SEM SEGURO', NULL, '36 parcelas', 0.7, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'PLAN 2 E 1 - TODAS C/SEGURO', NULL, '24 parcelas', 0.7, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'PLAN 3 E 2 - TODAS C/SEGURO', NULL, '18 parcelas', 0.7, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'TOP PLAN 2 E 1 - PLAN 10 E 9 - TODAS C/SEGURO', NULL, '14 parcelas', 0.7, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'NOVO - SEM SEGURO', NULL, '24 parcelas', 0.6, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'PLAN 1 C/SEGURO E NOVO SEM SEGURO', NULL, '18 parcelas', 0.6, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'PLAN 8, 6, 4 E 3 - TODAS C/SEGURO', NULL, '14 parcelas', 0.6, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'PLAN 2 E 1 C/SEGURO E NOVO SEM SEGURO', NULL, '14 parcelas', 0.5, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'ESP PLAN 6 C/ SEGURO', NULL, '18 parcelas', 0.35, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'ESP PLAN 4 C/ SEGURO', NULL, '18 parcelas', 0.3, '2026-09-01', NULL, TRUE),
  ('C6', 'CONS. PRIVADO', 'ESP PLAN 4 C/ SEGURO', NULL, '14 parcelas', 0.3, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69205 - NOVO GOLD', NULL, '60 parcelas', 1.45, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69191/69183/69035/69027/69043/69051 - NOVO GOLD', NULL, '36 ou 48 parcelas', 1.35, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69167/69175 - NOVO GOLD', NULL, '24 ou 60 parcelas', 1.25, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69159 - NOVO GOLD', NULL, '48 parcelas', 1.2, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69140/69060 - NOVO GOLD', NULL, '24 ou 36 parcelas', 1.15, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69132- NOVO GOLD', NULL, '24 parcelas', 1.1, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69213/69221 - NOVO SMART', NULL, '24, 36, 48 ou 60 parcelas', 1.1, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69230 - NOVO SMART', NULL, '36 ou 48 parcelas', 1.1, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69078/69086 - NOVO GOLD', NULL, '36 ou 48 parcelas', 0.9, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69213 - NOVO SMART', NULL, '24 parcelas', 0.9, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69116 - NOVO SMART', NULL, '24, 36 ou 48 parcelas', 0.9, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69019/69094 - NOVO GOLD', NULL, '24 parcelas', 0.8, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69230 - NOVO SMART', NULL, '24 parcelas', 0.7, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69272 - REFIN GOLD POWER', NULL, '36, 48 ou 60 parcelas', 0.9, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69264 - REFIN GOLD PLUS', NULL, '36, 48 ou 60 parcelas', 0.8, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69256 - REFIN GOLD PRIME', NULL, '36, 48 ou 60 parcelas', 0.7, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69248 - NOVO SMART', NULL, '24, 36 ou 48 parcelas', 0.6, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69280 - REFIN', NULL, '36, 48 ou 60 parcelas', 0.6, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', 'PORTABILIDADE - MAIOR QUE 12 PAGAS - 61107/61093/61085', NULL, '1 a 48 parcelas', 0.35, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', '69299/69302 - REFIN DA PORT', NULL, '36 e 60 parcelas', 0.35, '2026-09-01', NULL, TRUE),
  ('FACTA', 'CONS. PRIVADO', 'PORTABILIDADE - MENOR QUE 12 PAGAS - 64815/64823/64831', NULL, '1 a 48 parcelas', 0.0, '2026-09-01', NULL, TRUE),
  ('MERCANTIL', 'CONS. PRIVADO', 'MERCANTIL (SUP) - CONS. DO TRABALHADOR - NOVO', 'Com ou sem seguro.', '36 ou 48 parcelas', 1.1, '2026-09-01', NULL, TRUE),
  ('PAN', 'CONS. PRIVADO', 'CONSIG_PRIVADO_NOV_NORMAL', 'Com seguro ou sem seguro.', 'De 6 a 36 parcelas', 0.8, '2026-09-01', NULL, TRUE),
  ('PRESENÇA', 'CONS. PRIVADO', 'PRESENÇA BANK - NOVO - TX 4,98%', 'Com seguro.', '48 parcelas', 1.75, '2026-09-01', NULL, TRUE),
  ('PRESENÇA', 'CONS. PRIVADO', 'PRESENÇA BANK - NOVO - TX 4,98%', 'Com seguro.', '36 parcelas', 1.25, '2026-09-01', NULL, TRUE),
  ('PRESENÇA', 'CONS. PRIVADO', 'PRESENÇA BANK - NOVO - TX 4,98%', 'Com seguro.', '24 parcelas', 0.6, '2026-09-01', NULL, TRUE),
  ('PRESENÇA', 'CONS. PRIVADO', 'PRESENÇA BANK - NOVO - TX 4,98%', 'Com seguro.', '18 parcelas', 0.2, '2026-09-01', NULL, TRUE),
  ('PRESENÇA', 'CONS. PRIVADO', 'PRESENÇA BANK - NOVO - TX 4,98%', 'ESPECIAL Com seguro.', '36 parcelas', 0.75, '2026-09-01', NULL, TRUE),
  ('PRESENÇA', 'CONS. PRIVADO', 'PRESENÇA BANK - NOVO - TX 4,98%', 'ESPECIAL Com seguro.', '24 parcelas', 0.6, '2026-09-01', NULL, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2267 - Bancarizadora CELCOIN', 'Com seguro.', '48 parcelas', 1.5, '2026-09-01', NULL, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2687 - Bancarizadora UY3', 'Com seguro.', '48 parcelas', 1.4, '2026-09-01', NULL, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2266 - Bancarizadora CELCOIN', 'Com seguro.', '42 parcelas', 1.35, '2026-09-01', NULL, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2265 - Bancarizadora CELCOIN', 'Com seguro.', '36 parcelas', 1.15, '2026-09-01', NULL, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2283 - Bancarizadora UY3', 'Com seguro.', '36 parcelas', 1.15, '2026-09-01', NULL, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2264 - Bancarizadora CELCOIN', 'Com seguro.', '30 parcelas', 0.8, '2026-09-01', NULL, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2282 - Bancarizadora UY3', 'Com seguro.', '30 parcelas', 0.8, '2026-09-01', NULL, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2263 - Bancarizadora CELCOIN', 'Com seguro.', '24 parcelas', 0.65, '2026-09-01', NULL, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2281 - Bancarizadora UY3', 'Com seguro.', '24 parcelas', 0.6, '2026-09-01', NULL, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2280 - Bancarizadora UY3', 'Com seguro.', '18 parcelas', 0.45, '2026-09-01', NULL, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabelas 2275 e 2274 - Bancarizadora CELCOIN', 'Sem seguro.', '42 ou 48 parcelas', 0.45, '2026-09-01', NULL, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabelas 2273 e 2272 - Bancarizadora CELCOIN', 'Sem seguro.', '30 ou 36 parcelas', 0.3, '2026-09-01', NULL, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2279 - Bancarizadora UY3', 'Com seguro.', '12 parcelas', 0.25, '2026-09-01', NULL, TRUE),
  ('SOMA', 'CONS. PRIVADO', 'Tabela 2271 - Bancarizadora CELCOIN', 'Sem seguro.', '24 parcelas', 0.15, '2026-09-01', NULL, TRUE),
  ('V8', 'CONS. PRIVADO', 'CLT ACELERA', 'Com seguro.', '46 ou 48 parcelas', 1.9, '2026-09-01', NULL, TRUE),
  ('V8', 'CONS. PRIVADO', 'CLT ACELERA', 'Com seguro.', '24, 36 ou 38 parcelas', 1.4, '2026-09-01', NULL, TRUE),
  ('V8', 'CONS. PRIVADO', 'CLT ACELERA', 'Com seguro.', '18 parcelas', 0.9, '2026-09-01', NULL, TRUE),
  ('V8', 'CONS. PRIVADO', 'CLT ACELERA', 'Com seguro.', '12 parcelas', 0.8, '2026-09-01', NULL, TRUE),
  ('V8', 'CONS. PRIVADO', 'CLT ACELERA', 'Com seguro.', '3 a 11 parcelas', 0.6, '2026-09-01', NULL, TRUE),
  ('V8', 'CONS. PRIVADO', 'CLT ACELERA', 'Sem seguro.', '24 a 48 parcelas', 0.6, '2026-09-01', NULL, TRUE),
  ('V8', 'CONS. PRIVADO', 'CLT ACELERA', 'Sem seguro.', '12 ou 18 parcelas', 0.4, '2026-09-01', NULL, TRUE),
  ('V8', 'CONS. PRIVADO', 'CLT ACELERA', 'Sem seguro.', '3 a 11 parcelas', 0.2, '2026-09-01', NULL, TRUE),
  ('NOVO SAQUE', 'FGTS', 'TABELA NS', NULL, 'Prazos de 1 a 5 parcelas', 12.0, '2026-09-01', NULL, TRUE),
  ('NOVO SAQUE', 'FGTS', 'TABELA CAMPANHA', NULL, 'Prazos de 1 a 5 parcelas', 9.5, '2026-09-01', NULL, TRUE),
  ('NOVO SAQUE', 'FGTS', 'TABELA DIAMANTE', NULL, 'Prazos de 1 a 5 parcelas', 7.5, '2026-09-01', NULL, TRUE),
  ('NOVO SAQUE', 'FGTS', 'TABELA GOLD', NULL, 'Prazos de 1 a 5 parcelas', 6.0, '2026-09-01', NULL, TRUE),
  ('NOVO SAQUE', 'FGTS', 'TABELA MONEY', NULL, 'Prazos de 1 a 5 parcelas', 4.5, '2026-09-01', NULL, TRUE),
  ('NOVO SAQUE', 'FGTS', 'TABELA LIGHT', NULL, 'Prazos de 1 a 5 parcelas', 3.5, '2026-09-01', NULL, TRUE),
  ('NOVO SAQUE', 'FGTS', 'TABELA SOFT', NULL, 'Prazos de 1 a 5 parcelas', 2.0, '2026-09-01', NULL, TRUE),
  ('NOVO SAQUE', 'FGTS', 'TABELA SMART', NULL, 'Prazos de 1 a 5 parcelas', 1.1, '2026-09-01', NULL, TRUE),
  ('NOVO SAQUE', 'FGTS', 'TABELA ZERO', NULL, 'Prazos de 1 a 5 parcelas', 0.7, '2026-09-01', NULL, TRUE),
  ('V8', 'FGTS', 'ACELERA 2.0', NULL, 'Prazos de 1 a 5 parcelas', 11.5, '2026-09-01', NULL, TRUE),
  ('V8', 'FGTS', 'COMETA EXCLUSIVA BMS', NULL, 'Prazos de 1 a 5 parcelas', 8.8, '2026-09-01', NULL, TRUE),
  ('V8', 'FGTS', 'GRID', NULL, 'Prazos de 1 a 5 parcelas', 6.0, '2026-09-01', NULL, TRUE),
  ('V8', 'FGTS', 'TURBO', NULL, 'Prazos de 1 a 5 parcelas', 5.8, '2026-09-01', NULL, TRUE),
  ('V8', 'FGTS', 'NORMAL', NULL, 'Prazos de 1 a 5 parcelas', 4.5, '2026-09-01', NULL, TRUE),
  ('V8', 'FGTS', 'PITSTOP', NULL, 'Prazos de 1 a 5 parcelas', 1.8, '2026-09-01', NULL, TRUE)
ON CONFLICT DO NOTHING;

GRANT SELECT ON TABLE tabela_pontos TO anon;
GRANT SELECT ON TABLE tabela_pontos_historico TO anon;
