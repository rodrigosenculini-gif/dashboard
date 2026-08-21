// enviar-sessao-chatwoot.mjs
// Roda LOCAL, uma vez (ou sempre que a sessão expirar): abre o Chatwoot,
// você loga manualmente, e o script envia a sessão pro Supabase — de lá
// o endpoint do Vercel (api/chatwoot-scrape.js) consegue usá-la.
//
// Uso:
//   npm install playwright @supabase/supabase-js
//   npx playwright install chromium
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node enviar-sessao-chatwoot.mjs

import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import readline from 'readline';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function esperarEnter(mensagem) {
  console.log(mensagem);
  const rl = readline.createInterface({ input: process.stdin });
  await new Promise((resolve) => rl.once('line', resolve));
  rl.close();
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://crm.vendeaitecnologia.com.br');

  await esperarEnter('\n>>> Faça login manualmente na janela que abriu.\n>>> Depois de ver a lista de conversas, volte aqui e aperte ENTER.\n');

  const storageState = await context.storageState();

  const { error } = await supabase
    .from('chatwoot_sessao')
    .upsert({ id: 1, dados: storageState, atualizado_em: new Date().toISOString() });

  if (error) {
    console.error('Erro ao enviar sessão pro Supabase:', error.message);
  } else {
    console.log('Sessão enviada com sucesso pro Supabase.');
  }

  await browser.close();
  process.exit(0);
}

main();
