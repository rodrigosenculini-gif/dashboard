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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Senhas ficam só aqui no servidor — nunca são enviadas ao navegador.
// "geral" enxerga o dashboard inteiro; as outras só a própria aba de vendas.
const SENHAS = {
  '654321': { role: 'geral', vendedor: null },
  '123456': { role: 'vendedora', vendedor: 'JEANNE BARBOZA' },
  '123567': { role: 'vendedora', vendedor: 'KAYANE BASQUE' },
  '123789': { role: 'vendedora', vendedor: 'Leticia.Splendore' },
  '123908': { role: 'vendedora', vendedor: 'Rafaela Ferreira' },
  '345612': { role: 'entradas_lp', vendedor: null },
};

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    const { type } = req.query;

    if (type === 'auth_login') {
      const senha = (req.body?.senha || '').toString().trim();
      const found = SENHAS[senha];
      if (found) return res.status(200).json(found);
      // Nao esta nas senhas fixas: tenta as vendedoras cadastradas dinamicamente
      // (primeiro acesso feito pela Trilha do Especialista)
      try {
        const client = getPool();
        const result = await client.query(
          'select nome_completo from vendedoras_login where senha = $1 limit 1',
          [senha]
        );
        if (result.rows[0]) {
          return res.status(200).json({ role: 'vendedora', vendedor: result.rows[0].nome_completo });
        }
      } catch (e) {
        // tabela pode nao existir ainda; ignora e cai no erro padrao abaixo
      }
      return res.status(401).json({ error: 'Senha incorreta.' });
    }

    if (type === 'vendedoras_register') {
      try {
        const nome = (req.body?.nome || '').toString().trim();
        const senha = (req.body?.senha || '').toString().trim();
        const nomePattern = /^[A-ZÀ-Ý][a-zà-ÿ]+(?:\s[A-ZÀ-Ý][a-zà-ÿ]+)+$/u;
        if (!nomePattern.test(nome)) {
          return res.status(400).json({ error: 'Use o formato Nome Sobrenome (com iniciais maiúsculas).' });
        }
        if (senha.length < 4) {
          return res.status(400).json({ error: 'A senha precisa ter pelo menos 4 caracteres.' });
        }
        if (SENHAS[senha]) {
          return res.status(400).json({ error: 'Essa senha já está em uso. Escolha outra.' });
        }
        const client = getPool();
        await client.query(
          `insert into vendedoras_login (nome_completo, senha)
           values ($1, $2)
           on conflict (nome_completo) do update set senha = excluded.senha`,
          [nome, senha]
        );
        return res.status(200).json({ ok: true, vendedor: nome });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (type === 'vendedoras_add_venda') {
      try {
        const { vendedor, adesao, cpf, nome, valor, banco, tabela, data_pagamento, parcelas, seguro } = req.body || {};
        const client = getPool();
        const result = await client.query(
          'select * from dashboard_vendedoras_add_venda($1::text,$2::bigint,$3::text,$4::text,$5::numeric,$6::text,$7::text,$8::date,$9::int,$10::text)',
          [vendedor || null, adesao || null, cpf || null, nome || null, valor || null, banco || null, tabela || null, data_pagamento || null, parcelas || null, seguro || null]
        );
        return res.status(200).json(result.rows);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (type === 'vendedoras_import' || type === 'vendas_import') {
      try {
        const rows = req.body?.rows;
        if (!Array.isArray(rows) || rows.length === 0) {
          return res.status(400).json({ error: 'Nenhuma linha para importar.' });
        }
        const fn = type === 'vendas_import' ? 'dashboard_vendas_import' : 'dashboard_vendedoras_import';
        const client = getPool();
        const result = await client.query(
          `select * from ${fn}($1::jsonb)`,
          [JSON.stringify(rows)]
        );
        return res.status(200).json(result.rows);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: `type inválido para POST: ${type}` });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const { type = 'kpis', campanha, origem, meta, date_from, date_to, hora_inicio, hora_fim, tipo_envio, mensagem } = req.query;
  const p_campanha = campanha || null;
  const p_origem = origem || null;
  const p_meta = meta || null;
  const p_date_from = date_from || null;
  const p_date_to = date_to || null;
  const p_hora_inicio = hora_inicio !== undefined && hora_inicio !== '' ? parseInt(hora_inicio, 10) : null;
  const p_hora_fim = hora_fim !== undefined && hora_fim !== '' ? parseInt(hora_fim, 10) : null;
  const p_tipo_envio = tipo_envio || null;
  const p_mensagem = mensagem || null;

  const csvEsc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const sendCsv = (res, cols, rows, filename) => {
    const lines = [cols.join(';')];
    for (const row of rows) lines.push(cols.map((c) => csvEsc(row[c])).join(';'));
    const csv = '\uFEFF' + lines.join('\r\n'); // BOM pra acentuação abrir certo no Excel
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  };

  if (type === 'vendas_export') {
    try {
      const p_produto = req.query.produto || null;
      const client = getPool();
      const result = await client.query(
        `select adesao, cpf, nome, tabela, produto, banco, parcelas, seguro, peso, ponto, valor, data, campanha, origem
         from vendas_gerais
         where ($1::date is null or data >= $1::date) and ($2::date is null or data <= $2::date)
           and ($3::text is null or produto = $3::text)
         order by data desc nulls last, id desc`,
        [p_date_from, p_date_to, p_produto]
      );
      const cols = ['adesao', 'cpf', 'nome', 'tabela', 'produto', 'banco', 'parcelas', 'seguro', 'peso', 'ponto', 'valor', 'data', 'campanha', 'origem'];
      return sendCsv(res, cols, result.rows, `vendas_gerais_${p_date_from || 'todas'}_${p_date_to || 'todas'}.csv`);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (type === 'disparos_export') {
    try {
      const client = getPool();
      const result = await client.query(
        `select efetiva_campanha(campanha, campanha_reenvio, reenvio) as campanha, origem, meta, tipo_envio, mensagem,
                conversa, status, banco, valor, pagas, interacao, whatsapp, cpf, realizado, reenvio
         from disparochat
         where ($1::text is null or efetiva_campanha(campanha, campanha_reenvio, reenvio) = $1::text)
           and ($2::text is null or origem = $2::text)
           and ($3::text is null or meta = $3::text)
           and ($4::text is null or tipo_envio = $4::text)
           and ($5::text is null or mensagem = $5::text)
           and (
             ($6::timestamptz is null and $7::timestamptz is null)
             or (($6::timestamptz is null or realizado >= $6::timestamptz) and ($7::timestamptz is null or realizado <= $7::timestamptz))
             or (reenvio is not null and ($6::timestamptz is null or reenvio >= $6::timestamptz) and ($7::timestamptz is null or reenvio <= $7::timestamptz))
           )
         order by coalesce(reenvio, realizado) desc nulls last
         limit 20000`,
        [p_campanha, p_origem, p_meta, p_tipo_envio, p_mensagem, p_date_from, p_date_to]
      );
      const cols = ['campanha', 'origem', 'meta', 'tipo_envio', 'mensagem', 'conversa', 'status', 'banco', 'valor', 'pagas', 'interacao', 'whatsapp', 'cpf', 'realizado', 'reenvio'];
      return sendCsv(res, cols, result.rows, `disparochat_${p_date_from || 'todas'}_${p_date_to || 'todas'}.csv`);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (type === 'entradas_export') {
    try {
      const p_produto = req.query.produto || null;
      const client = getPool();
      const result = await client.query(
        `select campanha, origem, produto, interacao, aprovadas, pagas, valor, banco, whatsapp, cpf, created_at
         from total_produtos
         where ($1::text is null or campanha = $1::text)
           and ($2::text is null or origem = $2::text)
           and ($3::text is null or produto = $3::text)
           and ($4::timestamptz is null or created_at >= $4::timestamptz)
           and ($5::timestamptz is null or created_at <= $5::timestamptz)
         order by created_at desc nulls last
         limit 20000`,
        [p_campanha, p_origem, p_produto, p_date_from, p_date_to]
      );
      const cols = ['campanha', 'origem', 'produto', 'interacao', 'aprovadas', 'pagas', 'valor', 'banco', 'whatsapp', 'cpf', 'created_at'];
      return sendCsv(res, cols, result.rows, `total_produtos_${p_date_from || 'todas'}_${p_date_to || 'todas'}.csv`);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (type === 'vendedoras_export') {
    try {
      const p_vendedor = req.query.vendedor || null;
      const client = getPool();
      const result = await client.query(
        `select data_status, vendedor, banco, tabela, adesao, cpf, nome, valor, parcelas, seguro, data_pagamento
         from vendedoras_analise
         where ($1::text is null or vendedor = $1::text)
           and ($2::date is null or data_status >= $2::date)
           and ($3::date is null or data_status <= $3::date)
         order by data_status desc nulls last
         limit 20000`,
        [p_vendedor, p_date_from, p_date_to]
      );
      const cols = ['data_status', 'vendedor', 'banco', 'tabela', 'adesao', 'cpf', 'nome', 'valor', 'parcelas', 'seguro', 'data_pagamento'];
      return sendCsv(res, cols, result.rows, `vendedoras_${p_date_from || 'todas'}_${p_date_to || 'todas'}.csv`);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

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
    sql = 'select * from dashboard_kpis($1::text,$2::text,$3::text,$4::timestamptz,$5::timestamptz,$6::int,$7::int,$8::text,$9::text)';
    params = [p_campanha, p_origem, p_meta, p_date_from, p_date_to, p_hora_inicio, p_hora_fim, p_tipo_envio, p_mensagem];
  } else if (type === 'envios') {
    sql = 'select * from dashboard_envios_por_dia($1::text,$2::text,$3::text,$4::timestamptz,$5::timestamptz,$6::int,$7::int,$8::text,$9::text)';
    params = [p_campanha, p_origem, p_meta, p_date_from, p_date_to, p_hora_inicio, p_hora_fim, p_tipo_envio, p_mensagem];
  } else if (type === 'campanhas') {
    sql = 'select * from dashboard_campanhas($1::text,$2::text,$3::timestamptz,$4::timestamptz,$5::text,$6::text)';
    params = [p_origem, p_meta, p_date_from, p_date_to, p_tipo_envio, p_mensagem];
  } else if (type === 'por_conversa') {
    sql = 'select * from dashboard_por_conversa($1::text,$2::text,$3::text,$4::timestamptz,$5::timestamptz,$6::text,$7::text)';
    params = [p_campanha, p_origem, p_meta, p_date_from, p_date_to, p_tipo_envio, p_mensagem];
  } else if (type === 'por_meta') {
    sql = 'select * from dashboard_por_meta($1::text,$2::text,$3::text,$4::timestamptz,$5::timestamptz,$6::text,$7::text)';
    params = [p_campanha, p_origem, p_meta, p_date_from, p_date_to, p_tipo_envio, p_mensagem];
  } else if (type === 'por_mensagem') {
    sql = 'select * from dashboard_por_mensagem($1::text,$2::text,$3::text,$4::timestamptz,$5::timestamptz,$6::text)';
    params = [p_campanha, p_origem, p_meta, p_date_from, p_date_to, p_tipo_envio];
  } else if (type === 'hoje_kpis') {
    sql = 'select * from dashboard_hoje_kpis($1::timestamptz,$2::timestamptz,$3::text,$4::int,$5::int)';
    params = [p_date_from, p_date_to, p_campanha, p_hora_inicio, p_hora_fim];
  } else if (type === 'falha_por_minuto') {
    const minutos = parseInt(req.query.minutos, 10) || 60;
    sql = 'select * from dashboard_falha_por_minuto($1::int,$2::text)';
    params = [minutos, p_campanha];
  } else if (type === 'por_template_hoje') {
    sql = 'select * from dashboard_por_template_hoje($1::timestamptz,$2::timestamptz,$3::text)';
    params = [p_date_from, p_date_to, p_campanha];
  } else if (type === 'produtos_kpis') {
    sql = 'select * from dashboard_produtos_kpis($1::text,$2::text,$3::text,$4::timestamptz,$5::timestamptz,$6::int,$7::int)';
    params = [p_campanha, req.query.produto || null, p_origem, p_date_from, p_date_to, p_hora_inicio, p_hora_fim];
  } else if (type === 'produtos_entradas_por_dia') {
    sql = 'select * from dashboard_produtos_entradas_por_dia($1::text,$2::text,$3::text,$4::timestamptz,$5::timestamptz,$6::int,$7::int)';
    params = [p_campanha, req.query.produto || null, p_origem, p_date_from, p_date_to, p_hora_inicio, p_hora_fim];
  } else if (type === 'produtos_aprovadas_por_dia') {
    sql = 'select * from dashboard_produtos_aprovadas_por_dia($1::text,$2::text,$3::text,$4::timestamptz,$5::timestamptz)';
    params = [p_campanha, req.query.produto || null, p_origem, p_date_from, p_date_to];
  } else if (type === 'produtos_campanhas') {
    sql = 'select * from dashboard_produtos_campanhas($1::text,$2::text,$3::text,$4::timestamptz,$5::timestamptz)';
    params = [p_campanha, req.query.produto || null, p_origem, p_date_from, p_date_to];
  } else if (type === 'produtos_filtros') {
    sql = 'select * from dashboard_produtos_filtros()';
    params = [];
  } else if (type === 'funil') {
    sql = 'select * from dashboard_funil($1::timestamptz,$2::timestamptz,$3::text,$4::text)';
    params = [p_date_from, p_date_to, p_campanha, p_origem];
  } else if (type === 'funil_produtos') {
    sql = 'select * from dashboard_funil_produtos($1::timestamptz,$2::timestamptz,$3::text,$4::text,$5::text)';
    params = [p_date_from, p_date_to, p_campanha, p_origem, req.query.produto || null];
  } else if (type === 'vendas_kpis') {
    sql = 'select * from dashboard_vendas_kpis($1::date,$2::date,$3::text)';
    params = [p_date_from, p_date_to, req.query.produto || null];
  } else if (type === 'vendas_por_produto') {
    sql = 'select * from dashboard_vendas_por_produto($1::date,$2::date)';
    params = [p_date_from, p_date_to];
  } else if (type === 'vendas_dias_mes') {
    sql = 'select * from dashboard_vendas_dias_mes($1::text)';
    params = [req.query.produto || null];
  } else if (type === 'vendas_por_dia') {
    sql = 'select * from dashboard_vendas_por_dia($1::date,$2::date)';
    params = [p_date_from, p_date_to];
  } else if (type === 'vendas_por_campanha') {
    sql = 'select * from dashboard_vendas_por_campanha($1::date,$2::date,$3::text)';
    params = [p_date_from, p_date_to, req.query.produto || null];
  } else if (type === 'vendas_por_origem') {
    sql = 'select * from dashboard_vendas_por_origem($1::date,$2::date,$3::text)';
    params = [p_date_from, p_date_to, req.query.produto || null];
  } else if (type === 'vendas_sync') {
    sql = 'select * from dashboard_vendas_sync()';
    params = [];
  } else if (type === 'vendedoras_filtros') {
    sql = 'select * from dashboard_vendedoras_filtros()';
    params = [];
  } else if (type === 'vendedoras_sync') {
    sql = 'select * from dashboard_vendedoras_sync()';
    params = [];
  } else if (type === 'vendedoras_kpis_geral') {
    sql = 'select * from dashboard_vendedoras_kpis_geral($1::date,$2::date)';
    params = [p_date_from, p_date_to];
  } else if (type === 'vendedoras_kpis_vendedor') {
    sql = 'select * from dashboard_vendedoras_kpis_vendedor($1::text,$2::date,$3::date)';
    params = [req.query.vendedor || null, p_date_from, p_date_to];
  } else if (type === 'vendedoras_por_dia') {
    sql = 'select * from dashboard_vendedoras_por_dia($1::text,$2::date,$3::date)';
    params = [req.query.vendedor || null, p_date_from, p_date_to];
  } else if (type === 'vendedoras_ranking') {
    sql = 'select * from dashboard_vendedoras_ranking($1::date,$2::date)';
    params = [p_date_from, p_date_to];
  } else if (type === 'vendedoras_tabela') {
    const limit = parseInt(req.query.limit, 10) || 10;
    const offset = parseInt(req.query.offset, 10) || 0;
    sql = 'select * from dashboard_vendedoras_tabela($1::text,$2::date,$3::date,$4::int,$5::int)';
    params = [req.query.vendedor || null, p_date_from, p_date_to, limit, offset];
  } else if (type === 'vendedoras_meta') {
    sql = 'select * from dashboard_vendedoras_meta($1::text)';
    params = [req.query.vendedor || null];
  } else if (type === 'vendedoras_medias_geral') {
    sql = 'select * from dashboard_vendedoras_medias_geral()';
    params = [];
  } else if (type === 'vendedoras_semanas_mes') {
    sql = 'select * from dashboard_vendedoras_semanas_mes($1::text)';
    params = [req.query.vendedor || null];
  } else if (type === 'debug_peso_nulo') {
    sql = 'select * from dashboard_debug_peso_nulo()';
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
