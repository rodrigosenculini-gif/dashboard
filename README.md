# Dashboard de Disparos (Supabase + Vercel)

Dashboard que lê direto da sua tabela `disparochat` no Supabase e atualiza
sozinho a cada 60 segundos (e sempre que você troca um filtro).

## 1. Rodar o SQL no Supabase (uma vez só)

1. Abra o painel do Supabase → **SQL Editor** → **New query**
2. Cole todo o conteúdo do arquivo `supabase_setup.sql` (está nesta pasta)
3. Clique em **Run**

Isso cria 4 funções (`dashboard_kpis`, `dashboard_envios_por_dia`,
`dashboard_campanhas`, `dashboard_filtros`) que o site vai chamar. Nenhuma
delas grava dados — só leem e agregam, com segurança.

> Os cálculos (o que conta como "Pagas", "Faturado" etc.) estão comentados
> no topo do arquivo `.sql`. Se sua regra de negócio for diferente, é só
> editar as funções lá e rodar de novo.

## 2. Configurar as variáveis de ambiente

Copie `.env.example` para `.env` e preencha:

```
VITE_SUPABASE_URL=https://mvzqywdmhdylsuclrqrg.supabase.co
VITE_SUPABASE_ANON_KEY=sua_anon_key_aqui
```

⚠️ Use apenas a **anon public key** (a que você já me passou). Nunca a
`service_role`/`secret` key — essa não deve aparecer em nenhum site.

## 3. Rodar localmente (opcional, para testar antes)

```bash
npm install
npm run dev
```

Abre em `http://localhost:5173`.

## 4. Deploy no Vercel (grátis)

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
