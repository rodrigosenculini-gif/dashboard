-- Consulta de cliente com tres fontes em cascata: CRM (quando ligado),
-- Nova Vida e Lemit. Guardamos o resultado normalizado -- as consultas sao
-- pagas por chamada, entao repetir o mesmo CPF no dia nao gasta credito.
create table if not exists consultas_cliente (
  id bigserial primary key,
  cpf text not null,
  fonte text not null,                    -- crm | novavida | lemit
  consultado_em timestamptz not null default now(),
  consultado_por text,
  ok boolean not null default false,
  mensagem text,
  nome text, nascimento date, idade integer, nome_mae text, sexo text,
  situacao_cpf text, obito boolean,
  renda text, score text, faixa_score text, ocupacao text,
  fgts_tem boolean, fgts_valor numeric,
  telefones jsonb not null default '[]'::jsonb,   -- [{ddd,numero,whatsapp,tipo}]
  emails    jsonb not null default '[]'::jsonb,   -- [{email}]
  enderecos jsonb not null default '[]'::jsonb,   -- [{logradouro,bairro,cidade,uf,cep}]
  extras    jsonb not null default '{}'::jsonb,
  payload   jsonb
);
create index if not exists cc_cpf_idx on consultas_cliente (cpf, consultado_em desc);

-- token da Nova Vida vale 24h: nao gerar a cada consulta
create table if not exists api_tokens (
  servico text primary key,
  token text,
  expira_em timestamptz
);

-- ultima consulta boa do CPF dentro da validade
create or replace function public.dashboard_consulta_cache(p_cpf text, p_horas integer default 24)
returns setof consultas_cliente
language sql stable security definer set search_path to 'public' as $function$
  select * from consultas_cliente
  where cpf = regexp_replace(coalesce(p_cpf,''),'\D','','g')
    and ok and consultado_em > now() - make_interval(hours => greatest(p_horas,1))
  order by consultado_em desc limit 1;
$function$;

create or replace function public.dashboard_consulta_salvar(p jsonb)
returns setof consultas_cliente
language sql volatile security definer set search_path to 'public' as $function$
  insert into consultas_cliente (
    cpf, fonte, consultado_por, ok, mensagem, nome, nascimento, idade, nome_mae,
    sexo, situacao_cpf, obito, renda, score, faixa_score, ocupacao,
    fgts_tem, fgts_valor, telefones, emails, enderecos, extras, payload)
  values (
    regexp_replace(coalesce(p->>'cpf',''),'\D','','g'),
    coalesce(p->>'fonte','?'), p->>'por',
    coalesce((p->>'ok')::boolean, false), p->>'mensagem',
    p->>'nome',
    nullif(p->>'nascimento','')::date,
    nullif(p->>'idade','')::int,
    p->>'nome_mae', p->>'sexo', p->>'situacao_cpf',
    coalesce((p->>'obito')::boolean, false),
    p->>'renda', p->>'score', p->>'faixa_score', p->>'ocupacao',
    coalesce((p->>'fgts_tem')::boolean, false),
    nullif(regexp_replace(coalesce(p->>'fgts_valor',''),'[^0-9.]','','g'),'')::numeric,
    coalesce(p->'telefones','[]'::jsonb),
    coalesce(p->'emails','[]'::jsonb),
    coalesce(p->'enderecos','[]'::jsonb),
    coalesce(p->'extras','{}'::jsonb),
    p->'payload')
  returning *;
$function$;
