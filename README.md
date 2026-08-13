# Dashboard de Disparos (Supabase + Vercel)

Dashboard que lê direto da sua tabela `disparochat` no Supabase e atualiza
sozinho a cada 60 segundos (e sempre que você troca um filtro).

**Como funciona:** o site (front-end) nunca fala direto com o Supabase.
Ele chama uma função serverless (`api/dashboard.js`, roda só no servidor do
Vercel) que conecta direto no Postgres com o usuário `postgres` — isso
ignora o RLS da tabela, então os números vêm completos. A senha do banco
fica só numa variável de ambiente no Vercel, nunca no navegador nem no
GitHub.

## 1. Rodar o SQL no Supabase (uma vez só, se ainda não rodou)

1. Abra o painel do Supabase → **SQL Editor** → **New query**
2. Cole todo o conteúdo do arquivo `supabase_setup.sql` (está nesta pasta)
3. Clique em **Run**

Isso cria 4 funções (`dashboard_kpis`, `dashboard_envios_por_dia`,
`dashboard_campanhas`, `dashboard_filtros`) que a API serverless vai chamar.
Nenhuma delas grava dados — só leem e agregam.

> Os cálculos (o que conta como "Pagas", "Faturado" etc.) estão comentados
> no topo do arquivo `.sql`. Se sua regra de negócio for diferente, é só
> editar as funções lá e rodar de novo.

## 2. Pegar a connection string do Postgres

No Supabase: **Project Settings → Database → Connection string → URI**.
Vai ser algo como:

```
postgresql://postgres:SUA_SENHA_AQUI@db.mvzqywdmhdylsuclrqrg.supabase.co:5432/postgres
```

## 3. Configurar a variável de ambiente **no Vercel** (não local)

No painel do Vercel do seu projeto: **Settings → Environments → Production**
→ adicione:

```
DATABASE_URL=postgresql://postgres:SUA_SENHA_AQUI@db.mvzqywdmhdylsuclrqrg.supabase.co:5432/postgres
```

⚠️ Essa variável **não** tem o prefixo `VITE_` de propósito — isso garante
que ela só existe no servidor (na função `api/dashboard.js`), nunca é
enviada para o navegador de quem visita o site.

## 4. Rodar localmente (opcional, para testar antes)

Pra testar com a API serverless local, use o Vercel CLI em vez do `vite dev`
puro (senão a rota `/api/dashboard` não funciona):

```bash
npm install -g vercel
vercel dev
```

Ele vai pedir pra logar e vincular o projeto na primeira vez, e também vai
pedir a `DATABASE_URL` (ou você configura via `vercel env pull` depois de já
ter salvo no painel do Vercel).

## 5. Deploy no Vercel (grátis)

Você não precisa de GitHub — dá para publicar direto do terminal:

```bash
npm install -g vercel
vercel login
vercel
```

Na primeira vez ele vai perguntar algumas coisas — pode aceitar os padrões
(Enter em tudo). Quando perguntar sobre variáveis de ambiente, ou depois do
primeiro deploy, rode:

```bash
vercel env add VITE_SUPABASE_URL
vercel env add VITE_SUPABASE_ANON_KEY
```

Cole os valores quando pedir (ambiente: Production). Depois, publique a
versão final:

```bash
vercel --prod
```

Isso te dá uma URL pública (tipo `https://seu-projeto.vercel.app`) que
sempre mostra os dados mais recentes do Supabase — sem precisar fazer nada
de novo depois disso. Sempre que quiser atualizar o design ou os filtros,
edite os arquivos e rode `vercel --prod` de novo.

## Estrutura

- `src/App.jsx` — toda a lógica e o layout do dashboard
- `src/supabaseClient.js` — conexão com o Supabase
- `supabase_setup.sql` — as funções que agregam os dados no banco
