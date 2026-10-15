-- 15/10: a versao 20261015110000 lia new.pago_em tambem em interacoes (campo inexistente). Todo insert de
-- interacao de telefone com disparo falhou de 10:42 a 15:14 (SP) e o evento conversation_created do VendeAI
-- era desfeito inteiro. Base das horas agora fica numa variavel preenchida por tabela.
-- Recuperacao: 2.227 interacoes refeitas a partir de crm_mensagens/robo_fu_conversas (evento 'backfill_crm_1510'),
-- cobrindo tambem a queda dos webhooks do VendeAI de 14/10 21:15 a 15/10 ~11:00; 49 entradas LP com
-- interacao/reprovada/aprovada pelas etiquetas do CRM (backup_tp_crm_1510).
CREATE OR REPLACE FUNCTION public.atribui_disparo()
 RETURNS trigger LANGUAGE plpgsql
AS $function$
declare v_quando timestamptz; v_base timestamptz; v_dt timestamptz; v_pri record;
begin
  if TG_TABLE_NAME = 'pagamentos' then
    v_quando := ((new.pago_em at time zone 'America/Sao_Paulo')::date + 1)::timestamp at time zone 'America/Sao_Paulo';
    v_base := coalesce(new.pago_em, v_quando);
    if TG_OP = 'UPDATE' then
      new.disparo_id := null; new.horas_desde_disparo := null;
      new.primeiro_disparo_id := null; new.campanha_origem := null; new.canal_origem := null;
      new.campanha_ultimo_toque := null; new.disparo_ultimo_toque_id := null;
      new.canal_ultimo_toque := null; new.tipo_ultimo_toque := null; new.horas_ultimo_toque := null;
      new.campanha_primeiro_toque := null; new.disparo_primeiro_toque_id := null;
      new.canal_primeiro_toque := null; new.toques_ate_pagar := null;
    end if;
  else
    v_quando := new.ocorrida_em;
    v_base := new.ocorrida_em;
  end if;
  select d.id, d.disparado_em into new.disparo_id, v_dt
  from disparos d where d.telefone = new.telefone and d.disparado_em < v_quando
  order by d.disparado_em desc, d.id desc limit 1;
  if v_dt is not null then
    new.horas_desde_disparo := round(extract(epoch from (v_base - v_dt))/3600.0, 2);
  end if;
  select d.id, d.campanha, d.canal into v_pri
  from disparos d where d.telefone = new.telefone and d.disparado_em < v_quando
  order by d.disparado_em asc, d.id asc limit 1;
  if v_pri.id is not null then
    new.primeiro_disparo_id := v_pri.id; new.campanha_origem := v_pri.campanha; new.canal_origem := v_pri.canal;
  end if;
  return new;
end $function$;
