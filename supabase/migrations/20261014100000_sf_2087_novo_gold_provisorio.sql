-- 14/10: Sempre Facil passou a mandar a tabela 2087 - NOVO GOLD 36 A 60 MESES (10 vendas em 14/10, ponto zerado).
-- Nao estava na planilha de 13/10. Provisorio: mesmos pesos da 2078 (NOVO GOLD 36 a 60) ate o usuario confirmar.
insert into tabela_pontos (banco, produto, nome_tabela, regras_especificas, prazos, pontos, vigencia_inicio, ativo) values
 ('SEMPRE FACIL','CLT','2087 - NOVO GOLD 36 a 60 meses','Provisorio 14/10: copiado da 2078 ate confirmacao.','24 parcelas',0.70,'2026-10-01',true),
 ('SEMPRE FACIL','CLT','2087 - NOVO GOLD 36 a 60 meses','Provisorio 14/10: copiado da 2078 ate confirmacao.','36 ou 48 parcelas',0.80,'2026-10-01',true);
update vendas_gerais set peso = peso where normalizar_banco(banco)='SEMPRE FACIL' and tabela ~ '^2087' and data >= '2026-10-01';
