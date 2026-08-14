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
  } else if (type === 'debug_distinct') {
    const table = req.query.table || 'total_produtos';
    const column = req.query.column || 'pagas';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column)) {
      return res.status(400).json({ error: 'nome inválido' });
    }
    sql = `select ${column}, count(*) from ${table} group by 1 order by 2 desc limit 20`;
    params = [];
  } else if (type === 'debug_table') {
    const table = req.query.table || 'total_produtos';
    sql = 'select column_name, data_type from information_schema.columns where table_name = $1 order by ordinal_position';
    params = [table];
  } else if (type === 'debug_sample') {
    const table = req.query.table || 'total_produtos';
    // nomes de tabela não podem ser parametrizados; validamos que só tem letras/underscore
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      return res.status(400).json({ error: 'nome de tabela inválido' });
    }
    sql = `select * from ${table} limit 5`;
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
    sql = 'select * from dashboard_hoje_kpis($1::timestamptz,$2::timestamptz,$3::text)';
    params = [p_date_from, p_date_to, p_campanha];
  } else if (type === 'falha_por_minuto') {
    const minutos = parseInt(req.query.minutos, 10) || 60;
    sql = 'select * from dashboard_falha_por_minuto($1::int,$2::text)';
    params = [minutos, p_campanha];
  } else if (type === 'por_template_hoje') {
    sql = 'select * from dashboard_por_template_hoje($1::timestamptz,$2::timestamptz,$3::text)';
    params = [p_date_from, p_date_to, p_campanha];
  } else if (type === 'produtos_kpis') {
    sql = 'select * from dashboard_produtos_kpis($1::text,$2::text,$3::text,$4::timestamptz,$5::timestamptz)';
    params = [p_campanha, req.query.produto || null, p_origem, p_date_from, p_date_to];
  } else if (type === 'produtos_entradas_por_dia') {
    sql = 'select * from dashboard_produtos_entradas_por_dia($1::text,$2::text,$3::text,$4::timestamptz,$5::timestamptz)';
    params = [p_campanha, req.query.produto || null, p_origem, p_date_from, p_date_to];
  } else if (type === 'produtos_aprovadas_por_dia') {
    sql = 'select * from dashboard_produtos_aprovadas_por_dia($1::text,$2::text,$3::text,$4::timestamptz,$5::timestamptz)';
    params = [p_campanha, req.query.produto || null, p_origem, p_date_from, p_date_to];
  } else if (type === 'produtos_campanhas') {
    sql = 'select * from dashboard_produtos_campanhas($1::text,$2::text,$3::timestamptz,$4::timestamptz)';
    params = [req.query.produto || null, p_origem, p_date_from, p_date_to];
  } else if (type === 'produtos_filtros') {
    sql = 'select * from dashboard_produtos_filtros()';
    params = [];
  } else if (type === 'funil') {
    sql = 'select * from dashboard_funil($1::timestamptz,$2::timestamptz,$3::text,$4::text)';
    params = [p_date_from, p_date_to, p_campanha, p_origem];
  } else if (type === 'funil_produtos') {
    sql = 'select * from dashboard_funil_produtos($1::timestamptz,$2::timestamptz,$3::text,$4::text,$5::text)';
    params = [p_date_from, p_date_to, p_campanha, p_origem, req.query.produto || null];
  } else if (type === 'vendedoras_filtros') {
    sql = 'select * from dashboard_vendedoras_filtros()';
    params = [];
  } else if (type === 'vendedoras_sync') {
    sql = 'select * from dashboard_vendedoras_sync()';
    params = [];
  } else if (type === 'vendedoras_kpis_geral') {
    sql = 'select * from dashboard_vendedoras_kpis_geral($1::timestamptz,$2::timestamptz)';
    params = [p_date_from, p_date_to];
  } else if (type === 'vendedoras_kpis_vendedor') {
    sql = 'select * from dashboard_vendedoras_kpis_vendedor($1::text,$2::timestamptz,$3::timestamptz)';
    params = [req.query.vendedor || null, p_date_from, p_date_to];
  } else if (type === 'vendedoras_por_dia') {
    sql = 'select * from dashboard_vendedoras_por_dia($1::text,$2::timestamptz,$3::timestamptz)';
    params = [req.query.vendedor || null, p_date_from, p_date_to];
  } else if (type === 'vendedoras_tabela') {
    const limit = parseInt(req.query.limit, 10) || 10;
    const offset = parseInt(req.query.offset, 10) || 0;
    sql = 'select * from dashboard_vendedoras_tabela($1::text,$2::timestamptz,$3::timestamptz,$4::int,$5::int)';
    params = [req.query.vendedor || null, p_date_from, p_date_to, limit, offset];
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
