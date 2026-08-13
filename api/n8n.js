// Função serverless que consulta a API do n8n (execuções de workflows).
// A chave do n8n fica só aqui no servidor — nunca é enviada ao navegador.
//
// Configure no Vercel (Settings > Environments > Production):
//   N8N_BASE_URL = https://hotn8n.querosacarfgts.com.br
//   N8N_API_KEY  = sua chave (a que você já usou pra conectar)

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

// Busca várias páginas de execuções (mais recentes primeiro), parando cedo
// quando já passou da data mais antiga que precisamos.
async function fetchExecutions({ workflowId, oldestNeeded, maxPages = 8 }) {
  let all = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ limit: '250' });
    if (workflowId) params.set('workflowId', workflowId);
    if (cursor) params.set('cursor', cursor);
    const data = await n8nFetch(`/api/v1/executions?${params.toString()}`);
    const items = data.data || [];
    all = all.concat(items);
    cursor = data.nextCursor || null;
    const oldestInPage = items[items.length - 1];
    if (!cursor) break;
    if (oldestNeeded && oldestInPage && new Date(oldestInPage.startedAt) < oldestNeeded) break;
  }
  return all;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const { type = 'stats', workflowId, date_from, date_to } = req.query;

  try {
    if (type === 'workflows') {
      // lista de workflows pra popular o filtro (só ativos, pra não poluir)
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

      const executions = await fetchExecutions({ workflowId: workflowId || null, oldestNeeded: from });

      const inRange = executions.filter((e) => {
        const t = new Date(e.startedAt);
        return t >= from && t <= to;
      });

      const counts = { success: 0, error: 0, waiting: 0, running: 0, other: 0 };
      let durationSum = 0;
      let durationCount = 0;
      const pending = [];

      for (const e of inRange) {
        const status = e.status || 'other';
        if (counts[status] !== undefined) counts[status]++;
        else counts.other++;

        if (e.stoppedAt && e.startedAt) {
          const dur = (new Date(e.stoppedAt) - new Date(e.startedAt)) / 1000;
          if (dur >= 0) {
            durationSum += dur;
            durationCount++;
          }
        }

        if (status === 'waiting' || status === 'running') {
          const elapsedSec = (now - new Date(e.startedAt)) / 1000;
          pending.push({
            id: e.id,
            workflowId: e.workflowId,
            status,
            startedAt: e.startedAt,
            elapsedSec,
          });
        }
      }

      pending.sort((a, b) => b.elapsedSec - a.elapsedSec);
      const avgPendingSec = pending.length
        ? pending.reduce((s, p) => s + p.elapsedSec, 0) / pending.length
        : 0;

      return res.status(200).json({
        total: inRange.length,
        success: counts.success,
        error: counts.error,
        pending: counts.waiting + counts.running,
        other: counts.other,
        avg_duration_sec: durationCount ? durationSum / durationCount : 0,
        avg_pending_sec: avgPendingSec,
        pending_list: pending.slice(0, 50),
      });
    }

    return res.status(400).json({ error: `type inválido: ${type}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
