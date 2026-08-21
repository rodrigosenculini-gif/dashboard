// api/chatwoot-scrape.js
// =====================================================================
// Versão Vercel (serverless) do scraper de conversas do Chatwoot.
// Só pra TESTES por enquanto — serverless tem timeout curto, então só
// funciona bem pra conversas com histórico não muito grande.
//
// Diferente da versão VPS: não tem disco persistente entre execuções,
// então a sessão de login fica guardada no Supabase (tabela
// chatwoot_sessao) em vez de um arquivo local.
// =====================================================================

import chromium from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';
import { createClient } from '@supabase/supabase-js';

const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'https://crm.vendeaitecnologia.com.br/app/accounts/75';
const TOKEN_SERVICO = process.env.SCRAPER_TOKEN_SERVICO || '';

const supabase = createClient(process.env.POSTGRES_URL_SUPABASE_PROJECT || process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const MESES = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };

function parseTimestampChatwoot(texto) {
  const m = texto.match(/([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{1,2}):(\d{2})\s*(AM|PM)/);
  if (!m) return null;
  const [, mesAbrev, dia, hora12, min, ampm] = m;
  const mes = MESES[mesAbrev];
  if (mes === undefined) return null;
  let hora = parseInt(hora12, 10) % 12;
  if (ampm === 'PM') hora += 12;
  const anoAtual = new Date().getFullYear();
  let data = new Date(anoAtual, mes, parseInt(dia, 10), hora, parseInt(min, 10));
  if (data.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    data = new Date(anoAtual - 1, mes, parseInt(dia, 10), hora, parseInt(min, 10));
  }
  return data;
}

async function carregarHistoricoCompleto(page) {
  const seletor = '[class*="conversation-panel" i], .messages-wrapper, .conversation-messages-list';
  let alturaAnterior = -1;
  // menos tentativas que a versão VPS, pra caber no timeout do serverless
  for (let i = 0; i < 15; i++) {
    const alturaAtual = await page.evaluate((sel) => {
      const el = document.querySelector(sel) || document.scrollingElement;
      if (!el) return 0;
      el.scrollTop = 0;
      return el.scrollHeight;
    }, seletor);
    if (alturaAtual === alturaAnterior) break;
    alturaAnterior = alturaAtual;
    await page.waitForTimeout(500);
  }
}

async function extrairMensagens(page) {
  const brutas = await page.evaluate(() => {
    const bubbles = [...document.querySelectorAll('.message-bubble-container')];
    return bubbles.map((el) => {
      const classe = el.className || '';
      let lado = 'sistema';
      if (classe.includes('justify-start')) lado = 'cliente';
      else if (classe.includes('justify-end')) lado = 'vendedor';
      const timeEl = el.querySelector('time');
      const horarioTexto = timeEl ? timeEl.textContent.trim() : '';
      const temAudio = !!el.querySelector('audio');
      const imgGrande = [...el.querySelectorAll('img')].find((img) => (img.naturalWidth || img.width) > 60);
      const temImagem = !!imgGrande;
      const container = el.closest('[class*="wrapper" i]') || el.parentElement;
      const avatar = container ? container.querySelector('img[alt]') : null;
      const nomeRemetente = avatar ? avatar.getAttribute('alt') : null;
      let texto = el.textContent || '';
      if (horarioTexto) texto = texto.replace(horarioTexto, '');
      texto = texto.trim();
      let tipoMidia = 'texto';
      if (temAudio) tipoMidia = 'audio';
      else if (temImagem) tipoMidia = 'imagem';
      return { lado, horarioTexto, nomeRemetente, texto, tipoMidia };
    });
  });
  return brutas
    .filter((m) => m.lado !== 'sistema')
    .map((m) => ({ ...m, timestamp: parseTimestampChatwoot(m.horarioTexto) }))
    .filter((m) => m.timestamp);
}

function montarLinhasVendedoras(mensagens, meta) {
  const linhas = [];
  let linhaAtual = null;
  let primeiraJaRegistrada = false;

  for (const msg of mensagens) {
    const textoComTipo =
      msg.tipoMidia === 'audio' ? `[ÁUDIO] ${msg.texto || '(sem transcrição)'}`
      : msg.tipoMidia === 'imagem' ? `[IMAGEM] ${msg.texto || '(sem descrição)'}`
      : msg.texto;
    const ehIA = (msg.nomeRemetente || '').toUpperCase().includes('IA');
    const vendedorNome = ehIA ? 'IA' : (msg.nomeRemetente || null);

    if (msg.lado === 'cliente') {
      linhaAtual = {
        whatsapp: meta.whatsapp,
        cpf: meta.cpf,
        conversation: meta.conversation_id,
        mensagem_cliente: textoComTipo,
        created_at: msg.timestamp.toISOString(),
        vendedor: null,
        mensagem_vendedor: null,
        mensagem_vendedor_hora: null,
        atribuicao: null,
        diferença: null,
        primeira_mensagem: primeiraJaRegistrada ? null : textoComTipo,
      };
      primeiraJaRegistrada = true;
      linhas.push(linhaAtual);
    } else {
      if (!linhaAtual) {
        linhaAtual = {
          whatsapp: meta.whatsapp,
          cpf: meta.cpf,
          conversation: meta.conversation_id,
          mensagem_cliente: null,
          created_at: msg.timestamp.toISOString(),
          vendedor: vendedorNome,
          mensagem_vendedor: textoComTipo,
          mensagem_vendedor_hora: msg.timestamp.toISOString(),
          atribuicao: msg.timestamp.toISOString(),
          diferença: null,
          primeira_mensagem: null,
        };
        linhas.push(linhaAtual);
        continue;
      }
      if (!linhaAtual.mensagem_vendedor) {
        const diffMin = Math.floor((msg.timestamp.getTime() - new Date(linhaAtual.created_at).getTime()) / 60000);
        linhaAtual.vendedor = vendedorNome;
        linhaAtual.mensagem_vendedor = textoComTipo;
        linhaAtual.mensagem_vendedor_hora = msg.timestamp.toISOString();
        linhaAtual.atribuicao = msg.timestamp.toISOString();
        linhaAtual.diferença = diffMin >= 0 ? diffMin : null;
      } else {
        linhaAtual.mensagem_vendedor += `\n${textoComTipo}`;
      }
    }
  }
  return linhas;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  if (TOKEN_SERVICO && req.headers.authorization !== `Bearer ${TOKEN_SERVICO}`) {
    return res.status(401).json({ ok: false, erro: 'Token inválido.' });
  }

  const { conversation_id, whatsapp, cpf } = req.body || {};
  if (!conversation_id) {
    return res.status(400).json({ ok: false, erro: 'conversation_id é obrigatório.' });
  }

  let browser;
  try {
    // busca a sessão salva no Supabase (gerada localmente e enviada 1x)
    const { data: sessaoRow, error: erroSessao } = await supabase
      .from('chatwoot_sessao')
      .select('dados')
      .eq('id', 1)
      .maybeSingle();
    if (erroSessao) throw new Error(`Erro ao buscar sessão: ${erroSessao.message}`);
    if (!sessaoRow) {
      return res.status(400).json({ ok: false, erro: 'Nenhuma sessão de login salva ainda. Rode o script de login e envie pro Supabase primeiro.' });
    }

    browser = await playwrightChromium.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    const context = await browser.newContext({ storageState: sessaoRow.dados });
    const page = await context.newPage();

    await page.goto(`${CHATWOOT_BASE_URL}/conversations/${conversation_id}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('.message-bubble-container', { timeout: 12000 }).catch(() => {});
    await carregarHistoricoCompleto(page);
    const mensagens = await extrairMensagens(page);

    const linhas = mensagens.length
      ? montarLinhasVendedoras(mensagens, { whatsapp, cpf, conversation_id })
      : [];

    return res.status(200).json({ ok: true, total_mensagens: mensagens.length, linhas });
  } catch (e) {
    return res.status(500).json({ ok: false, erro: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export const config = {
  maxDuration: 60, // segundos — ajuste conforme seu plano Vercel permitir
};
