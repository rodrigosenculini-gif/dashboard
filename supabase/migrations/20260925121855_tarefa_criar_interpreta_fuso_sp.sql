-- O campo datetime-local do navegador manda "2026-09-25T14:30", sem fuso.
-- Como timestamptz, o Postgres assume UTC: em SP isso vira 11:30, ou seja,
-- 3h no passado -- a tarefa nascia ja vencida, com o mascote vermelho na
-- hora. Agora o texto sem fuso e interpretado como horario de Sao Paulo.
create or replace function public.dashboard_tarefa_criar(
  p_vendedor text, p_titulo text, p_minutos integer default null, p_quando text default null)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $function$
declare v_quando timestamptz; v_id bigint; v_txt text;
begin
  if coalesce(btrim(p_titulo),'') = '' then
    return jsonb_build_object('ok', false, 'erro', 'informe o que lembrar');
  end if;

  if p_minutos is not null then
    v_quando := now() + make_interval(mins => greatest(p_minutos, 1));
  else
    v_txt := btrim(coalesce(p_quando,''));
    if v_txt = '' then
      return jsonb_build_object('ok', false, 'erro', 'informe quando lembrar');
    end if;
    -- com fuso declarado, respeita; sem fuso, e horario de Sao Paulo
    if v_txt ~ '(Z|[+-]\d{2}:?\d{2})$' then
      v_quando := v_txt::timestamptz;
    else
      v_quando := (replace(v_txt, 'T', ' ')::timestamp at time zone 'America/Sao_Paulo');
    end if;
  end if;

  insert into tarefas_lembrete (vendedor, titulo, lembrar_em)
  values (p_vendedor, btrim(p_titulo), v_quando) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id,
    'lembrar_em', to_char(v_quando at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'));
end $function$;

-- a versao antiga (com p_quando timestamptz) vira sobrecarga ambigua
drop function if exists public.dashboard_tarefa_criar(text, text, integer, timestamptz);
