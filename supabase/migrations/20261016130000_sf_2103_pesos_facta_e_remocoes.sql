-- 16/10 (dono), aplicado via MCP:
-- tabela_pontos: SF "2103 - NOVO GOLD 61 a 120 meses" com os pesos da Facta NOVO GOLD 61 a 120
--   (24x 1,144 | 36 ou 48x 1,232 | 60x 1,320), vigencia 2026-10-01. Vendas da 2103 recalculadas.
-- Removidas com analise e log (status_api "... varredura 16/10"): V8 17182 (codigo de outro cliente) e 14 vendas SF
-- sem confirmacao na conta SF (7 sem nada por codigo/CPF/valor; 7 cujo cliente so tem proposta cancelada).
-- Backups: backup_vg_1610, backup_va_1610, backup_tabela_pontos_1610.
insert into tabela_pontos (banco, produto, nome_tabela, regras_especificas, prazos, pontos, vigencia_inicio, ativo)
select 'SEMPRE FACIL', 'CLT', '2103 - NOVO GOLD 61 a 120 meses', 'Dono 16/10: mesmos pesos da Facta NOVO GOLD 61 a 120 (vigencia Facta 13/10).', x.prazos, x.pontos, '2026-10-01', true
from (values ('24 parcelas', 1.144), ('36 ou 48 parcelas', 1.232), ('60 parcelas', 1.320)) x(prazos, pontos)
where not exists (select 1 from tabela_pontos t where normalizar_banco(t.banco)='SEMPRE FACIL' and t.nome_tabela ~ '^2103');
