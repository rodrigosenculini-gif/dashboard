import { Pool } from 'pg';

// Nuvem de arquivos de ajuda das vendedoras.
// Os bytes ficam no Supabase Storage (bucket "arquivos-vendedoras", publico);
// aqui ficam so os metadados (pastas, nomes, dono). O upload/remocao do
// binario e feito direto do navegador contra o Storage, entao nada pesado
// passa pela Vercel.
//
// dono = null  -> arquivo/pasta "geral" (todas as vendedoras veem)
// dono = nome  -> so aquela vendedora ve (alem dos gerais)

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

function donoParam(v) {
  const s = v == null ? '' : String(v).trim();
  return s && s !== 'geral' && s !== 'todos' ? s : null;
}

export default async function handler(req, res) {
  const type = String(req.query.type || '');
  try {
    if (req.method === 'POST') return await handlePost(type, req, res);
    return await handleGet(type, req, res);
  } catch (err) {
    console.error('[api/arquivos]', type, err);
    return res.status(500).json({ error: err.message || 'Erro interno' });
  }
}

// ---------------------------------------------------------------- GET

async function handleGet(type, req, res) {
  const dono = donoParam(req.query.dono);

  // Lista pastas + arquivos visiveis para esse dono:
  //  - dono null (view geral): so o que e geral
  //  - dono = vendedora: o que e geral + o que e dela
  if (type === 'listar') {
    const pastas = await q(
      `select id, nome, dono, criado_em
         from arquivos_pastas
        where dono is null or ($1::text is not null and dono = $1)
        order by dono nulls first, nome`,
      [dono]
    );
    const arquivos = await q(
      `select id, pasta_id, nome, dono, storage_path, mime, tamanho, criado_em
         from arquivos_vendedoras
        where dono is null or ($1::text is not null and dono = $1)
        order by criado_em desc`,
      [dono]
    );
    return res.json({ data: { pastas, arquivos } });
  }

  return res.status(400).json({ error: `type desconhecido: ${type}` });
}

// --------------------------------------------------------------- POST

async function handlePost(type, req, res) {
  const body = req.body || {};
  const dono = donoParam(body.dono);

  if (type === 'criar_pasta') {
    const nome = String(body.nome || '').trim();
    if (!nome) return res.status(400).json({ error: 'nome da pasta e obrigatorio' });
    const rows = await q(
      `insert into arquivos_pastas (nome, dono) values ($1, $2)
       returning id, nome, dono, criado_em`,
      [nome, dono]
    );
    return res.json({ ok: true, data: rows[0] });
  }

  if (type === 'renomear_pasta') {
    const id = Number(body.id);
    const nome = String(body.nome || '').trim();
    if (!id || !nome) return res.status(400).json({ error: 'id e nome sao obrigatorios' });
    const rows = await q(
      `update arquivos_pastas set nome = $2 where id = $1 returning id, nome, dono`,
      [id, nome]
    );
    return res.json({ ok: true, data: rows[0] });
  }

  // Devolve os storage_path dos arquivos da pasta pra o front apagar do
  // Storage; a remocao dos metadados e em cascata.
  if (type === 'excluir_pasta') {
    const id = Number(body.id);
    if (!id) return res.status(400).json({ error: 'id e obrigatorio' });
    const paths = await q(`select storage_path from arquivos_vendedoras where pasta_id = $1`, [id]);
    await q(`delete from arquivos_pastas where id = $1`, [id]);
    return res.json({ ok: true, storage_paths: paths.map((r) => r.storage_path) });
  }

  // Registra um arquivo que o navegador ja subiu pro Storage
  if (type === 'registrar_arquivo') {
    const nome = String(body.nome || '').trim();
    const storage_path = String(body.storage_path || '').trim();
    if (!nome || !storage_path) {
      return res.status(400).json({ error: 'nome e storage_path sao obrigatorios' });
    }
    const pasta_id = body.pasta_id ? Number(body.pasta_id) : null;
    const rows = await q(
      `insert into arquivos_vendedoras (pasta_id, nome, dono, storage_path, mime, tamanho)
       values ($1, $2, $3, $4, $5, $6)
       returning id, pasta_id, nome, dono, storage_path, mime, tamanho, criado_em`,
      [pasta_id, nome, dono, storage_path, body.mime || null, body.tamanho ? Number(body.tamanho) : null]
    );
    return res.json({ ok: true, data: rows[0] });
  }

  if (type === 'renomear_arquivo') {
    const id = Number(body.id);
    const nome = String(body.nome || '').trim();
    if (!id || !nome) return res.status(400).json({ error: 'id e nome sao obrigatorios' });
    const rows = await q(
      `update arquivos_vendedoras set nome = $2 where id = $1 returning id, nome`,
      [id, nome]
    );
    return res.json({ ok: true, data: rows[0] });
  }

  if (type === 'mover_arquivo') {
    const id = Number(body.id);
    if (!id) return res.status(400).json({ error: 'id e obrigatorio' });
    const pasta_id = body.pasta_id ? Number(body.pasta_id) : null;
    const rows = await q(
      `update arquivos_vendedoras set pasta_id = $2 where id = $1 returning id, pasta_id`,
      [id, pasta_id]
    );
    return res.json({ ok: true, data: rows[0] });
  }

  if (type === 'excluir_arquivo') {
    const id = Number(body.id);
    if (!id) return res.status(400).json({ error: 'id e obrigatorio' });
    const rows = await q(
      `delete from arquivos_vendedoras where id = $1 returning storage_path`,
      [id]
    );
    return res.json({ ok: true, storage_path: rows[0]?.storage_path || null });
  }

  return res.status(400).json({ error: `type desconhecido: ${type}` });
}
