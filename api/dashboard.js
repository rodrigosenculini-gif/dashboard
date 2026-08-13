import { Pool } from 'pg';

// Remove qualquer sslmode da connection string (pode forçar validação
// estrita do certificado e sobrescrever a opção ssl abaixo)
function cleanConnectionString(raw) {
  try {
    const url = new URL(raw);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    return raw;
  }
}

// Reaproveita a conexão entre chamadas (evita abrir uma conexão nova a cada request)
let pool;
function getPool() {
  if (!pool) {
    // A integração oficial Supabase↔Vercel cria POSTGRES_URL (ou variações,
    // dependendo da versão). Também aceitamos DATABASE_URL caso você tenha
    // configurado manualmente.
    const raw =
      process.env.POSTGRES_URL ||
      process.env.POSTGRES_URL_NON_POOLING ||
      process.env.DATABASE_URL;

    if (!raw) {
      throw new Error(
        'Nenhuma connection string encontrada. Configure DATABASE_URL (ou conecte a integração Supabase↔Vercel, que cria POSTGRES_URL automaticamente) em Settings > Environments > Production.'
      );
    }
    pool = new Pool({
      connectionString: cleanConnectionString(raw),
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  }
  return pool;
}

function setCors(res) {
  // Libera para o site publicado e para artifacts do claude.ai testarem a API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const { type = 'kpis', campanha, origem, meta, date_from, date_to } = req.query;
  const p_campanha = campanha || null;
  const p_origem = origem || null;
  const p_meta = meta || null;
  const p_date_from = date_from || null;
  const p_date_to = date_to || null;

  let sql;
  let params;

  if (type === 'count') {
    // Teste simples: só conta linhas da tabela, sem depender das funções SQL
    sql = 'select count(*)::int as total from disparochat';
    params = [];
  } else if (type === 'debug') {
    sql = "select proname, pg_get_function_identity_arguments(oid) as args from pg_proc where proname like 'dashboard_%' order by proname";
    params = [];
  } else if (type === 'kpis') {
    sql = 'select * from dashboard_kpis($1::text,$2::text,$3::text,$4::timestamptz,$5::timestamptz)';
    params = [p_campanha, p_origem, p_meta, p_date_from, p_date_to];
  } else if (type === 'envios') {
    sql = 'select * from dashboard_envios_por_dia($1::text,$2::text,$3::text,$4::timestamptz,$5::timestamptz)';
    params = [p_campanha, p_origem, p_meta, p_date_from, p_date_to];
  } else if (type === 'campanhas') {
    sql = 'select * from dashboard_campanhas($1::text,$2::text,$3::timestamptz,$4::timestamptz)';
    params = [p_origem, p_meta, p_date_from, p_date_to];
  } else if (type === 'por_conversa') {
    sql = 'select * from dashboard_por_conversa($1::text,$2::text,$3::text,$4::timestamptz,$5::timestamptz)';
    params = [p_campanha, p_origem, p_meta, p_date_from, p_date_to];
  } else if (type === 'por_meta') {
    sql = 'select * from dashboard_por_meta($1::text,$2::text,$3::text,$4::timestamptz,$5::timestamptz)';
    params = [p_campanha, p_origem, p_meta, p_date_from, p_date_to];
  } else if (type === 'por_mensagem') {
    sql = 'select * from dashboard_por_mensagem($1::text,$2::text,$3::text,$4::timestamptz,$5::timestamptz)';
    params = [p_campanha, p_origem, p_meta, p_date_from, p_date_to];
  } else if (type === 'hoje_kpis') {
    sql = 'select * from dashboard_hoje_kpis()';
    params = [];
  } else if (type === 'falha_por_minuto') {
    const minutos = parseInt(req.query.minutos, 10) || 60;
    sql = 'select * from dashboard_falha_por_minuto($1::int)';
    params = [minutos];
  } else if (type === 'por_template_hoje') {
    sql = 'select * from dashboard_por_template_hoje()';
    params = [];
  } else if (type === 'filtros') {
    sql = 'select * from dashboard_filtros()';
    params = [];
  } else {
    return res.status(400).json({ error: `type inválido: ${type}` });
  }

  try {
    const client = getPool();
    const result = await client.query(sql, params);
    return res.status(200).json(result.rows);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
