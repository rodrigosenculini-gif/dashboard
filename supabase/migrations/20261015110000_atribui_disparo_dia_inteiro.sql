-- 15/10: o pagamento e gravado as 12:00 do dia da venda (so temos a data). O disparo/entrada do mesmo dia
-- feito de tarde ficava "depois" do pagamento e a venda ficava sem disparo (1.023 pagamentos de outubro
-- sem canal; 905 tinham disparo no mesmo dia). Para pagamento, vale qualquer disparo ate o fim do dia da venda.
-- Depois de aplicar, os pagamentos de outubro foram refeitos (delete + venda_sincroniza_pagamento).
CREATE OR REPLACE FUNCTION public.atribui_disparo()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare v_quando timestamptz; v_dt timestamptz; v_pri record;
begin
  if TG_TABLE_NAME = 'pagamentos' then
    -- so sabemos o dia do pagamento: considera o dia inteiro (ate 23:59 em Sao Paulo)
    v_quando := ((new.pago_em at time zone 'America/Sao_Paulo')::date + 1) ::timestamp at time zone 'America/Sao_Paulo';
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
  end if;

  select d.id, d.disparado_em into new.disparo_id, v_dt
  from disparos d
  where d.telefone = new.telefone and d.disparado_em < v_quando
  order by d.disparado_em desc, d.id desc
  limit 1;

  if v_dt is not null then
    new.horas_desde_disparo := round(extract(epoch from (coalesce(new.pago_em, v_quando) - v_dt))/3600.0, 2);
  end if;

  select d.id, d.campanha, d.canal into v_pri
  from disparos d
  where d.telefone = new.telefone and d.disparado_em < v_quando
  order by d.disparado_em asc, d.id asc
  limit 1;

  if v_pri.id is not null then
    new.primeiro_disparo_id := v_pri.id;
    new.campanha_origem := v_pri.campanha;
    new.canal_origem := v_pri.canal;
  end if;

  return new;
end $function$;
