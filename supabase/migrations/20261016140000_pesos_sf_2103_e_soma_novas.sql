-- 16/10 (dono), aplicado via MCP. Substitui a copia provisoria da Facta na SF 2103.
update tabela_pontos set pontos = case prazos when '24 parcelas' then 1.00 when '36 ou 48 parcelas' then 1.17 when '60 parcelas' then 1.24 end,
       regras_especificas = 'Dono 16/10: 24x 1,00 | 36/48x 1,17 | 60x 1,24.', atualizado_em = now()
 where normalizar_banco(banco)='SEMPRE FACIL' and nome_tabela ~ '^2103';
insert into tabela_pontos (banco, produto, nome_tabela, regras_especificas, prazos, pontos, vigencia_inicio, ativo)
select 'SOMA', 'CONS. PRIVADO', x.nome, x.regra, x.prazos, x.pontos, '2026-10-01', true
from (values
  ('Tabela 3388 - NOVO SELECT ABAIXO 24 MESES', 'Com seguro. Dono 16/10.', '48 parcelas', 0.65),
  ('Tabela 3227 - NOVO EASY - 36 A 60 MESES', 'Sem seguro. Dono 16/10.', '48 parcelas', 0.82),
  ('Tabela 3321 - CLT J17', 'Com seguro. Dono 16/10.', '24 parcelas', 0.67)) x(nome, regra, prazos, pontos)
where not exists (select 1 from tabela_pontos t where normalizar_banco(t.banco)='SOMA' and t.nome_tabela = x.nome);
