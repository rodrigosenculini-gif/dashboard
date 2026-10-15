-- 15/10: entrada Crefaz nasce com aprovadas=1 (pre-analise aprovada). Quando o Crefaz nega depois,
-- so reprovadas ia a 1 e o dash contava o lead nas duas colunas (42 casos). Negada zera aprovadas
-- (menos se ja esta paga). Backup: backup_tp_aprov_1510.
CREATE OR REPLACE FUNCTION atendimento.crefaz_registrar_reprovacao(p_cpf text, p_situacao text, p_motivo text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
begin
  if coalesce(p_cpf, '') = '' or coalesce(p_motivo, '') = '' then return; end if;
  update public.resultado_crefaz r
     set motivo_reprovacao = p_motivo,
         reprocessar_em = current_date + ((atendimento.crefaz_negativa(p_motivo)->>'prazo_dias')::int),
         "pre-analise" = case when p_situacao = 'Negada' then 'reprovado' else r."pre-analise" end,
         reprovado = case when p_situacao = 'Negada' then 1 else r.reprovado end, atualizado = now()
   where r.id = (select x.id from public.resultado_crefaz x where lpad(regexp_replace(coalesce(x.cpf, ''), '\D', '', 'g'), 11, '0') = p_cpf
                  order by x.id desc limit 1)
     and r.motivo_reprovacao is distinct from p_motivo;
  update public.total_produtos t
     set reprovado_info = p_motivo,
         reprovadas = case when p_situacao = 'Negada' then 1 else t.reprovadas end,
         aprovadas = case when p_situacao = 'Negada' and coalesce(t.pagas,0) <> 1 then 0 else t.aprovadas end
   where t.id = (select x.id from public.total_produtos x where x.cpf = p_cpf order by x.created_at desc limit 1)
     and t.reprovado_info is distinct from p_motivo;
end $function$;

update total_produtos t set aprovadas = 0
 where aprovadas = 1 and reprovadas = 1 and origem_aprovacao = 'insert' and coalesce(campanha,'') !~* 'fgts|clt'
   and coalesce(pagas,0) <> 1
   and not exists (select 1 from vendas_gerais v where norm_cpf(v.cpf) = norm_cpf(t.cpf) and v.data >= t.created_at::date - 1);
