import { Pool } from 'pg';

// Esteira do Presenca: pendencias, atribuicao de vendedora e acoes.
// As acoes com efeito no banco passam pelo n8n (fluxo presenca-acao), que
// guarda o token e registra tudo em presenca_acoes_log. Aqui fica a leitura
// da esteira e a atribuicao de responsavel.

const N8N_BASE = process.env.N8N_BASE_URL || 'https://hotn8n.querosacarfgts.com.br';
const N8N_ACAO_URL = `${N8N_BASE}/webhook/presenca-acao`;

function cleanConnectionString(raw) {
  try {
    const url = new URL(raw);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    return raw;
  }
}

const CONNECTION_STRING =
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.DATABASE_URL;

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: cleanConnectionString(CONNECTION_STRING),
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10_000,
    });
  }
  return pool;
}

async function q(text, params = []) {
  const { rows } = await getPool().query(text, params);
  return rows;
}

// Status de trabalho aceitos (o fluxo do lead, do primeiro contato ao fecho).

const ACOES_PERMITIDAS = ['reapresentar', 'cancelar', 'upload', 'motivos', 'tipos'];
// Cancelar so na visao geral: e irreversivel do lado do banco.
const ACOES_SO_GERAL = ['cancelar'];

export default async function handler(req, res) {
  const type = String(req.query.type || 'esteira');
  try {
    if (req.method === 'GET') return await handleGet(type, req, res);
    if (req.method === 'POST') return await handlePost(type, req, res);
    return res.status(405).json({ erro: 'metodo nao permitido' });
  } catch (e) {
    return res.status(500).json({ erro: String((e && e.message) || e) });
  }
}

async function handleGet(type, req, res) {
  const vendedor = req.query.vendedor ? String(req.query.vendedor) : null;
  const faixa = req.query.faixa ? String(req.query.faixa) : null;
  const soTratavel = String(req.query.tratavel || '') === '1';
  const incluirFechadas = String(req.query.fechadas || '') === '1';

  if (type === 'catalogos') {
    const motivos = await q("select motivo_id, nome from presenca_motivos_cancelamento where ativo order by nome");
    const tipos = await q("select tipo_id, nome from presenca_tipos_documento order by nome");
    return res.json({ motivos, tipos });
  }

  if (type === 'vendedores') {
    const rows = await q("select distinct vendedor from vendedoras_analise " +
      "where vendedor is not null and btrim(vendedor) <> '' order by vendedor");
    return res.json({ vendedores: rows.map((r) => r.vendedor) });
  }

  if (type === 'resumo') {
    const rows = await q(
      "select faixa, count(*)::int as qtd, coalesce(sum(valor_liberado),0)::float as valor, min(prioridade) as ord " +
      "from presenca_esteira_view " +
      "where ($1::text is null or vendedor = $1) " +
      "group by faixa order by min(prioridade)", [vendedor]);
    return res.json({ resumo: rows });
  }

  if (type === 'historico') {
    const op = Number(req.query.operacao || 0);
    if (!op) return res.status(400).json({ erro: 'operacao obrigatoria' });
    const rows = await q(
      "select criado_em, acao, solicitante, http_status, sucesso, parametros " +
      "from presenca_acoes_log where operacao_id = $1 order by id desc limit 50", [op]);
    return res.json({ historico: rows });
  }

  const rows = await q(
    "select * from presenca_esteira_view " +
    "where ($4::boolean is true or faixa not in ('pago','cancelado')) " +
    "  and ($1::text is null or vendedor = $1) " +
    "  and ($2::text is null or faixa = $2) " +
    "  and ($3::boolean is not true or tratavel) " +
    "order by prioridade, data_operacao desc nulls last limit 400",
    [vendedor, faixa, soTratavel, incluirFechadas]);
  return res.json({ itens: rows });
}

async function handlePost(type, req, res) {
  const body = req.body || {};
  const modo = String(body.modo || 'vendedora');
  const solicitante = body.solicitante ? String(body.solicitante) : 'geral';

  if (type === 'atribuir') {
    const op = Number(body.operacao || 0);
    if (!op) return res.status(400).json({ erro: 'operacao obrigatoria' });
    // a vendedora so pode assumir para si mesma; a visao geral atribui a qualquer um
    let alvo = body.vendedor === null ? '' : (body.vendedor ? String(body.vendedor) : null);
    if (modo !== 'geral' && alvo !== null && alvo !== '' && alvo !== solicitante) {
      return res.status(403).json({ erro: 'vendedora so pode assumir para si' });
    }
    const rows = await q(
      "select presenca_esteira_atribuir($1,$2,$3,$4) as r",
      [op, alvo, body.observacao ? String(body.observacao) : null, !!body.visto]);
    return res.json(rows[0] ? rows[0].r : { ok: false });
  }

  if (type === 'acao') {
    const acao = String(body.acao || '').toLowerCase();
    if (!ACOES_PERMITIDAS.includes(acao)) {
      return res.status(400).json({ erro: 'acao invalida', permitidas: ACOES_PERMITIDAS });
    }
    if (ACOES_SO_GERAL.includes(acao) && modo !== 'geral') {
      return res.status(403).json({ erro: 'acao permitida apenas na visao geral' });
    }
    const op = Number(body.operacaoId || 0);
    if (['reapresentar','cancelar','upload'].includes(acao)) {
      if (!op) return res.status(400).json({ erro: 'operacaoId obrigatorio' });
      // a vendedora so age no que esta atribuido a ela
      if (modo !== 'geral') {
        const dono = await q("select vendedor from presenca_esteira where operacao_id = $1", [op]);
        const v = dono[0] ? dono[0].vendedor : null;
        if (v !== solicitante) {
          return res.status(403).json({ erro: 'operacao nao esta atribuida a voce' });
        }
      }
    }
    const payload = Object.assign({}, body, { solicitante });
    delete payload.modo;
    const r = await fetch(N8N_ACAO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch { j = { bruto: txt.slice(0, 500) }; }
    return res.status(r.ok ? 200 : 502).json(j);
  }

  return res.status(400).json({ erro: 'type desconhecido' });
}
