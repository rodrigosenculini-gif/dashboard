// Função serverless que consulta a API do n8n (execuções de workflows).
// A chave do n8n fica só aqui no servidor — nunca é enviada ao navegador.
//
// Configure no Vercel (Settings > Environments > Production):
//   N8N_BASE_URL = https://hotn8n.querosacarfgts.com.br
//   N8N_API_KEY  = sua chave (a que você já usou pra conectar)
//
// Também usa a mesma conexão Postgres (POSTGRES_URL) já configurada pro
// dashboard, pra guardar um histórico de quanto tempo cada execução ficou
// pendente — assim a média não zera quando não há nada pendente agora.

import { Pool } from 'pg';

function cleanConnectionString(raw) {
  try {
    const url = new URL(raw);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    return raw;
  }
}

let pool;
function getPool() {
  if (!pool) {
    const raw = process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL;
    if (!raw) return null;
    pool = new Pool({
      connectionString: cleanConnectionString(raw),
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  }
  return pool;
}

async function ensureTable() {
  const p = getPool();
  if (!p) return;
  await p.query(`
    create table if not exists n8n_pending_log (
      execution_id text primary key,
      workflow_id text,
      first_seen timestamptz not null default now(),
      last_seen timestamptz not null default now(),
      last_elapsed_sec numeric not null
    );
  `);
}

async function logPending(pendingList) {
  const p = getPool();
  if (!p || pendingList.length === 0) return;
  await ensureTable();
  for (const item of pendingList) {
    await p.query(
      `insert into n8n_pending_log (execution_id, workflow_id, last_seen, last_elapsed_sec)
       values ($1, $2, now(), $3)
       on conflict (execution_id)
       do update set last_seen = now(), last_elapsed_sec = excluded.last_elapsed_sec`,
      [item.id, item.workflowId, item.elapsedSec]
    );
  }
}

async function getHistoricalAvgPending() {
  const p = getPool();
  if (!p) return null;
  try {
    await ensureTable();
    const r = await p.query('select avg(last_elapsed_sec)::numeric as avg, count(*)::int as n from n8n_pending_log');
    const row = r.rows[0];
    return { avg: row.avg ? Number(row.avg) : 0, n: row.n || 0 };
  } catch {
    return null;
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function n8nFetch(path) {
  const base = process.env.N8N_BASE_URL;
  const key = process.env.N8N_API_KEY;
  if (!base || !key) {
    throw new Error(
      'Faltam N8N_BASE_URL / N8N_API_KEY no Vercel (Settings > Environments > Production).'
    );
  }
  const res = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    headers: { 'X-N8N-API-KEY': key },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || `Erro HTTP ${res.status} ao chamar o n8n`);
  }
  return data;
}

// Busca execuções de UM status específico, paginando até sair do intervalo
// de datas pedido (ou até um teto de segurança). Statuses "waiting"/"running"
// não usam corte por data — são sempre poucos, então buscamos todos.
// Retorna também se bateu no teto de páginas (resultado pode estar incompleto).
async function fetchByStatus({ status, workflowId, from, useDateCutoff, maxPages }) {
  let all = [];
  let cursor = null;
  let capped = false;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ limit: '250', status });
    if (workflowId) params.set('workflowId', workflowId);
    if (cursor) params.set('cursor', cursor);
    const data = await n8nFetch(`/api/v1/executions?${params.toString()}`);
    const items = data.data || [];
    all = all.concat(items);
    cursor = data.nextCursor || null;
    if (!cursor) break;
    if (useDateCutoff) {
      const oldest = items[items.length - 1];
      if (oldest && new Date(oldest.startedAt) < from) break;
    }
    if (page === maxPages - 1 && cursor) capped = true;
  }
  return { items: all, capped };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const { type = 'stats', workflowId, date_from, date_to } = req.query;

  try {
    if (type === 'workflows') {
      let all = [];
      let cursor = null;
      for (let i = 0; i < 4; i++) {
        const params = new URLSearchParams({ limit: '250', active: 'true' });
        if (cursor) params.set('cursor', cursor);
        const data = await n8nFetch(`/api/v1/workflows?${params.toString()}`);
        all = all.concat(data.data || []);
        cursor = data.nextCursor || null;
        if (!cursor) break;
      }
      return res.status(200).json(all.map((w) => ({ id: w.id, name: w.name })));
    }

    if (type === 'stats') {
      const from = date_from ? new Date(date_from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
      const to = date_to ? new Date(date_to) : new Date();
      const now = new Date();
      const wf = workflowId || null;

      const [successRes, errorRes, waitingRes, runningRes] = await Promise.all([
        fetchByStatus({ status: 'success', workflowId: wf, from, useDateCutoff: true, maxPages: 30 }),
        fetchByStatus({ status: 'error', workflowId: wf, from, useDateCutoff: true, maxPages: 30 }),
        fetchByStatus({ status: 'waiting', workflowId: wf, from, useDateCutoff: false, maxPages: 6 }),
        fetchByStatus({ status: 'running', workflowId: wf, from, useDateCutoff: false, maxPages: 6 }),
      ]);

      const inRange = (list) => list.filter((e) => {
        const t = new Date(e.startedAt);
        return t >= from && t <= to;
      });

      const success = inRange(successRes.items);
      const error = inRange(errorRes.items);
      const pendingRaw = [...waitingRes.items, ...runningRes.items];

      let durationSum = 0;
      let durationCount = 0;
      for (const e of [...success, ...error]) {
        if (e.stoppedAt && e.startedAt) {
          const dur = (new Date(e.stoppedAt) - new Date(e.startedAt)) / 1000;
          if (dur >= 0) {
            durationSum += dur;
            durationCount++;
          }
        }
      }

      const pending = pendingRaw.map((e) => ({
        id: e.id,
        workflowId: e.workflowId,
        status: e.status,
        startedAt: e.startedAt,
        elapsedSec: (now - new Date(e.startedAt)) / 1000,
      })).sort((a, b) => b.elapsedSec - a.elapsedSec);

      // grava no histórico (não bloqueia a resposta se falhar)
      try { await logPending(pending); } catch { /* ignora erro de log */ }

      // média histórica acumulada (não zera quando não há nada pendente agora)
      const hist = await getHistoricalAvgPending();

      return res.status(200).json({
        total: success.length + error.length + pending.length,
        total_capped: successRes.capped || errorRes.capped,
        success: success.length,
        success_capped: successRes.capped,
        error: error.length,
        error_capped: errorRes.capped,
        pending: pending.length,
        avg_duration_sec: durationCount ? durationSum / durationCount : 0,
        avg_pending_sec: hist ? hist.avg : 0,
        avg_pending_sample_size: hist ? hist.n : 0,
        pending_list: pending.slice(0, 50),
      });
    }

    return res.status(400).json({ error: `type inválido: ${type}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
