-- faltava excluir: dava pra criar e ligar/desligar, mas nao remover
create or replace function public.dashboard_regra_excluir(p_id bigint)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $function$
declare v_respostas int;
begin
  select count(*) into v_respostas from notificacoes_respostas where regra_id = p_id;
  -- com historico, desativa em vez de apagar: as respostas sao o registro de
  -- quem checou o que, e somem junto pelo cascade
  if v_respostas > 0 then
    update notificacoes_regras set ativo = false where id = p_id;
    return jsonb_build_object('ok', true, 'acao', 'desativada',
      'motivo', v_respostas || ' resposta(s) registradas — a regra foi desativada em vez de apagada');
  end if;
  delete from notificacoes_regras where id = p_id;
  return jsonb_build_object('ok', found, 'acao', 'excluida');
end $function$;
