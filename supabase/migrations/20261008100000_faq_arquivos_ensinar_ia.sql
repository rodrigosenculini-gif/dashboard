-- "Ensinar a IA" com arquivo (08/10): o dashboard manda o arquivo + contexto para o n8n
-- (IA Vendedoras - Consulta FAQ, webhook vendedoras-ia-arquivo); o n8n extrai o texto,
-- guarda o original no bucket ia-conhecimento e grava aqui. A consulta rapida le
-- faq_aprendizado + faq_arquivos (ativos) no prompt.
create table if not exists public.faq_arquivos (
  id bigserial primary key,
  nome text not null,
  contexto text not null,
  vendedora text,
  mime text,
  tamanho integer,
  caminho text,
  texto text,
  aviso text,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);
alter table public.faq_arquivos enable row level security;
insert into storage.buckets (id, name, public, file_size_limit)
values ('ia-conhecimento', 'ia-conhecimento', false, 26214400)
on conflict (id) do nothing;
