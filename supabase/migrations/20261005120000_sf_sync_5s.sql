-- Sempre Facil: com o tick a cada 20 s a descoberta (1 min) e a varredura (30 s)
-- ocupavam quase todos os ciclos e as propostas em aberto ficavam ate 4 h sem
-- reconsulta (pagamento entrava com horas de atraso). A cada 5 s sobra espaco
-- para ~180 reconsultas/hora; 429 continua pausando 2 min.
select cron.alter_job(24, schedule := '5 seconds');
