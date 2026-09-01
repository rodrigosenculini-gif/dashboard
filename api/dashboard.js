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


// ---------------------------------------------------------------------
// Sincroniza o Schedule Trigger do fluxo de leilao com a config salva.
// Assim o cron dispara exatamente nos horarios configurados (sem varrer
// de 15 em 15 min) e a mudanca vale na hora, sem esperar o proximo ciclo.
const N8N_BASE = 'https://hotn8n.querosacarfgts.com.br';
const N8N_LEILAO_WF = 'TKxMAT4NMFgh87zq';

function cronsDaConfig(cfg) {
  const hm = (v) => {
    const n = Number(v || 0);
    const h = Math.floor(n);
    const m = Math.round((n - h) * 60);
    return { h, m };
  };
  const dias = (Array.isArray(cfg.dias_semana) && cfg.dias_semana.length ? cfg.dias_semana : [1, 2, 3, 4, 5])
    .slice().sort((a, b) => a - b).join(',');

  const ini = hm(cfg.hora_inicio);
  const fim = hm(cfg.hora_fim);
  const crons = [
    // liga e desliga nos horarios da janela, nos dias ativos
    { field: 'cronExpression', expression: `${ini.m} ${ini.h} * * ${dias}` },
    { field: 'cronExpression', expression: `${fim.m} ${fim.h} * * ${dias}` },
  ];

  if (cfg.bloqueio_ativo !== false) {
    const bi = hm(cfg.bloqueio_hora_inicio);
    const bf = hm(cfg.bloqueio_hora_fim);
    // entra e sai do bloqueio mensal
    crons.push({ field: 'cronExpression', expression: `${bi.m} ${bi.h} ${Number(cfg.bloqueio_dia_inicio) || 20} * *` });
    crons.push({ field: 'cronExpression', expression: `${bf.m} ${bf.h} ${Number(cfg.bloqueio_dia_fim) || 23} * *` });
  }

  if (cfg.fim_semana_pausado !== false) {
    // garante o estado pausado logo no inicio do sabado
    crons.push({ field: 'cronExpression', expression: '0 0 * * 6' });
  }

  // remove duplicatas
  const vistos = new Set();
  return crons.filter((c) => (vistos.has(c.expression) ? false : vistos.add(c.expression)));
}


// Decide, pelo relogio de agora, se o leilao deveria estar ativo ou pausado
// segundo a config. Mesma regra do IF no fluxo n8n.
function estadoPelaConfig(cfg, agora = new Date()) {
  const spNow = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dia = spNow.getDay();
  const horaMin = spNow.getHours() + spNow.getMinutes() / 60;
  const diaMes = spNow.getDate();

  const hIni = Number(cfg.hora_inicio ?? 7);
  const hFim = Number(cfg.hora_fim ?? 21.5);
  const dias = Array.isArray(cfg.dias_semana) && cfg.dias_semana.length ? cfg.dias_semana : [1, 2, 3, 4, 5];

  // bloqueio mensal (virada de folha)
  if (cfg.bloqueio_ativo !== false) {
    const bDiaI = Number(cfg.bloqueio_dia_inicio ?? 20);
    const bHoraI = Number(cfg.bloqueio_hora_inicio ?? 21.5);
    const bDiaF = Number(cfg.bloqueio_dia_fim ?? 23);
    const bHoraF = Number(cfg.bloqueio_hora_fim ?? 8);
    const depoisDoInicio = diaMes > bDiaI || (diaMes === bDiaI && horaMin >= bHoraI);
    const antesDoFim = diaMes < bDiaF || (diaMes === bDiaF && horaMin <= bHoraF);
    if (depoisDoInicio && antesDoFim) return 'pausado';
  }

  if (cfg.fim_semana_pausado !== false && (dia === 0 || dia === 6)) return 'pausado';
  if (!dias.includes(dia)) return 'pausado';
  return horaMin >= hIni && horaMin < hFim ? 'ativo' : 'pausado';
}

// Aplica o estado na data table do n8n na hora (mesmo webhook usado pelos
// botoes de acao imediata).
async function aplicaEstadoLeilao(estado) {
  const r = await fetch('https://hotnwh.querosacarfgts.com.br/webhook/leilao-estado', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ estado }),
  });
  if (!r.ok) throw new Error(`webhook respondeu ${r.status}`);
  return r.json().catch(() => ({}));
}

async function sincronizaCronLeilao(cfg) {
  const apiKey = process.env.N8N_API_KEY;
  if (!apiKey) return { ok: false, motivo: 'N8N_API_KEY nao configurada' };
  const h = { 'X-N8N-API-KEY': apiKey, 'Content-Type': 'application/json' };

  const rGet = await fetch(`${N8N_BASE}/api/v1/workflows/${N8N_LEILAO_WF}`, { headers: h });
  if (!rGet.ok) return { ok: false, motivo: `GET workflow ${rGet.status}` };
  const wf = await rGet.json();

  const trigger = wf.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger');
  if (!trigger) return { ok: false, motivo: 'Schedule Trigger nao encontrado' };
  trigger.parameters = { rule: { interval: cronsDaConfig(cfg) } };

  const rPut = await fetch(`${N8N_BASE}/api/v1/workflows/${N8N_LEILAO_WF}`, {
    method: 'PUT',
    headers: h,
    body: JSON.stringify({ name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: {} }),
  });
  if (!rPut.ok) return { ok: false, motivo: `PUT workflow ${rPut.status}` };
  return { ok: true, crons: cronsDaConfig(cfg).map((c) => c.expression) };
}

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

    if (type === 'metas_set') {
      try {
        const b = req.body || {};
        const client = getPool();
        const result = await client.query(
          `select * from dashboard_metas_set($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            b.valor_diaria ?? null, b.valor_semanal ?? null, b.valor_mensal ?? null,
            b.ponto_diaria ?? null, b.ponto_semanal ?? null, b.ponto_mensal ?? null,
            b.tipo_ativo ?? null, b.periodo_ativo ?? null,
          ]
        );
        return res.status(200).json(result.rows);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
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

    // Liga/desliga o leilao na hora (grava direto na data table do n8n,
    // sem esperar o proximo ciclo do agendamento)
    if (type === 'leilao_estado') {
      try {
        const estado = String(req.body?.estado || '');
        if (!['ativo', 'pausado'].includes(estado)) {
          return res.status(400).json({ error: "estado deve ser 'ativo' ou 'pausado'" });
        }
        const r = await fetch('https://hotnwh.querosacarfgts.com.br/webhook/leilao-estado', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ estado }),
        });
        if (!r.ok) throw new Error(`n8n respondeu ${r.status}`);
        const data = await r.json().catch(() => ({}));
        return res.status(200).json({ ok: true, estado, envio: data?.envio ?? null });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (type === 'leilao_config_salvar') {
      try {
        const b = req.body || {};
        const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
        const client = getPool();
        const r = await client.query(
          `update leilao_config set
             hora_inicio = $1, hora_fim = $2,
             dias_semana = $3::int[],
             fim_semana_pausado = $4,
             bloqueio_ativo = $5,
             bloqueio_dia_inicio = $6, bloqueio_hora_inicio = $7,
             bloqueio_dia_fim = $8, bloqueio_hora_fim = $9,
             atualizado_em = now(), atualizado_por = $10
           where id = 1
           returning *`,
          [
            num(b.hora_inicio, 7),
            num(b.hora_fim, 21.5),
            Array.isArray(b.dias_semana) && b.dias_semana.length ? b.dias_semana : [1, 2, 3, 4, 5],
            b.fim_semana_pausado !== false,
            b.bloqueio_ativo !== false,
            num(b.bloqueio_dia_inicio, 20),
            num(b.bloqueio_hora_inicio, 21.5),
            num(b.bloqueio_dia_fim, 23),
            num(b.bloqueio_hora_fim, 8),
            b.atualizado_por || null,
          ]
        );
        const cfg = r.rows[0];
        // 1) reescreve o cron pra disparar nos horarios novos
        const sync = await sincronizaCronLeilao(cfg).catch((e) => ({ ok: false, motivo: e.message }));
        // 2) aplica AGORA o estado que a nova config manda, sem esperar o cron
        const estado = estadoPelaConfig(cfg);
        const aplicado = await aplicaEstadoLeilao(estado)
          .then(() => ({ ok: true, estado }))
          .catch((e) => ({ ok: false, estado, motivo: e.message }));
        return res.status(200).json({ ok: true, data: cfg, sync, aplicado });
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

  // O CSV usa ';' como separador (padrao pt-BR), entao os numeros precisam
  // sair com virgula decimal. Com ponto ("5839.6580"), o Excel em portugues
  // le o ponto como separador de milhar e mostra 58.396.580.
  const csvEsc = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') {
      return String(Number.isInteger(v) ? v : Number(v.toFixed(2))).replace('.', ',');
    }
    const s = String(v);
    // valores numericos vindos do Postgres chegam como string ("5839.6580")
    if (/^-?\d+\.\d+$/.test(s)) {
      return String(Number(Number(s).toFixed(2))).replace('.', ',');
    }
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

  if (type === 'leilao_config') {
    try {
      const client = getPool();
      const r = await client.query('select * from leilao_config where id = 1');
      return res.json({ data: r.rows[0] || null });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

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
    sql = 'select * from dashboard_campanhas($1::text,$2::text,$3::timestamptz,$4::timestamptz,$5::text,$6::text,$7::text)';
    params = [p_origem, p_meta, p_date_from, p_date_to, p_tipo_envio, p_mensagem, p_campanha];
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
    sql = 'select * from dashboard_vendas_kpis($1::date,$2::date,$3::text,$4::text)';
    params = [p_date_from, p_date_to, req.query.produto || null, req.query.banco || null];
  } else if (type === 'vendas_por_produto') {
    sql = 'select * from dashboard_vendas_por_produto($1::date,$2::date)';
    params = [p_date_from, p_date_to];
  } else if (type === 'vendas_dias_mes') {
    sql = 'select * from dashboard_vendas_dias_mes($1::text,$2::text)';
    params = [req.query.produto || null, req.query.banco || null];
  } else if (type === 'vendas_por_dia') {
    sql = 'select * from dashboard_vendas_por_dia($1::date,$2::date)';
    params = [p_date_from, p_date_to];
  } else if (type === 'vendas_por_campanha') {
    sql = 'select * from dashboard_vendas_por_campanha($1::date,$2::date,$3::text,$4::text)';
    params = [p_date_from, p_date_to, req.query.produto || null, req.query.banco || null];
  } else if (type === 'vendas_por_origem') {
    sql = 'select * from dashboard_vendas_por_origem($1::date,$2::date,$3::text,$4::text)';
    params = [p_date_from, p_date_to, req.query.produto || null, req.query.banco || null];
  } else if (type === 'vendas_sync') {
    sql = 'select * from dashboard_vendas_sync()';
    params = [];
  } else if (type === 'vendas_filtros') {
    sql = 'select * from dashboard_vendas_filtros()';
    params = [];
  } else if (type === 'vendedoras_filtros') {
    sql = 'select * from dashboard_vendedoras_filtros()';
    params = [];
  } else if (type === 'vendedoras_sync') {
    sql = 'select * from dashboard_vendedoras_sync()';
    params = [];
  } else if (type === 'vendedoras_kpis_geral') {
    sql = 'select * from dashboard_vendedoras_kpis_geral($1::date,$2::date,$3::text)';
    params = [p_date_from, p_date_to, req.query.banco || null];
  } else if (type === 'vendedoras_kpis_vendedor') {
    sql = 'select * from dashboard_vendedoras_kpis_vendedor($1::text,$2::date,$3::date)';
    params = [req.query.vendedor || null, p_date_from, p_date_to];
  } else if (type === 'vendedoras_por_dia') {
    sql = 'select * from dashboard_vendedoras_por_dia($1::text,$2::date,$3::date,$4::text)';
    params = [req.query.vendedor || null, p_date_from, p_date_to, req.query.banco || null];
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
  } else if (type === 'metas_progresso') {
    sql = 'select * from dashboard_metas_progresso($1)';
    params = [req.query.vendedor || null];
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
