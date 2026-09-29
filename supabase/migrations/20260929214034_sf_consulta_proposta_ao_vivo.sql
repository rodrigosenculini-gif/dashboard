-- Busca de proposta Sempre Facil para o "Adicionar adesao": por codigo SPF/numero ou CPF.
-- Acha o id interno no espelho e consulta a API JoinBank ao vivo (chave no Vault).
create or replace function public.sf_consulta_proposta(p_busca text)
returns jsonb language plpgsql security definer set search_path = public, vault as $function$
declare
  v_dig text := regexp_replace(coalesce(p_busca,''), '\D', '', 'g');
  v_code int; v_cpf text; s record; v_key text; r record; v_fonte text := 'espelho';
begin
  if length(v_dig) = 11 and cpf_valido(v_dig) then v_cpf := v_dig;
  elsif length(v_dig) between 1 and 10 then v_code := v_dig::int;
  else return jsonb_build_object('encontrado', false, 'erro', 'Informe o código SPF (ex.: SPF0000004150) ou o CPF.');
  end if;

  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'sempre_facil_apikey';
  perform http_set_curlopt('CURLOPT_TIMEOUT', '12');

  select * into s from sf_propostas_api
   where (v_code is not null and code = v_code) or (v_cpf is not null and cpf = v_cpf)
   order by code desc limit 1;

  -- proposta nova, ainda fora do espelho: le a 1a pagina (mais novas) e tenta de novo
  if s.code is null then
    begin
      select status, content into r from http(('GET', 'https://integration.ajin.io/v3/loans', array[http_header('apikey', v_key)], null, null)::http_request);
      if r.status = 200 then
        perform sf_upsert(i) from jsonb_array_elements(r.content::jsonb->'items') i;
        select * into s from sf_propostas_api
         where (v_code is not null and code = v_code) or (v_cpf is not null and cpf = v_cpf)
         order by code desc limit 1;
      end if;
    exception when others then null;
    end;
  end if;

  if s.code is null then
    return jsonb_build_object('encontrado', false, 'erro', 'Proposta não encontrada na Sempre Fácil (propostas antigas ainda não estão disponíveis pela API).');
  end if;

  -- atualiza ao vivo pela API
  begin
    select status, content into r from http(('GET', 'https://integration.ajin.io/v3/loans/' || s.api_id, array[http_header('apikey', v_key)], null, null)::http_request);
    if r.status = 200 then
      perform sf_upsert(r.content::jsonb);
      v_fonte := 'api';
      select * into s from sf_propostas_api where code = s.code;
    end if;
  exception when others then null;   -- API fora/limite: devolve o espelho
  end;

  return jsonb_build_object(
    'encontrado', true, 'fonte', v_fonte, 'atualizado_em', s.sincronizado_em,
    'code', s.code, 'contrato', s.contract_number, 'cpf', s.cpf, 'nome', s.nome,
    'valor', s.valor_liquido, 'parcelas', s.parcelas, 'tabela', s.tabela,
    'status_code', s.status_code, 'status', s.status_nome,
    'situacao', coalesce(sf_status_final(s.status_code), 'andamento'),
    'data_pagamento', coalesce(nullif(s.data_desembolso,''), nullif(s.data_credito,'')));
end $function$;

revoke all on function public.sf_consulta_proposta(text) from anon, authenticated;
