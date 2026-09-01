import { Pool } from 'pg';

// Remove qualquer sslmode da connection string (pode forçar validação
// estrita do certificado e sobrescrever a opção ssl abaixo) — mesma
// correção já aplicada em api/dashboard.js
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

const N8N_TREINO_WEBHOOK =
  process.env.N8N_TREINO_WEBHOOK ||
  'https://hotn8n.querosacarfgts.com.br/webhook/treinamento-ia';

async function q(text, params = []) {
  const { rows } = await getPool().query(text, params);
  return rows;
}

export default async function handler(req, res) {
  const type = String(req.query.type || '');

  try {
    if (req.method === 'POST') return await handlePost(type, req, res);
    return await handleGet(type, req, res);
  } catch (err) {
    console.error('[api/ia]', type, err);
    return res.status(500).json({ error: err.message || 'Erro interno' });
  }
}

// ---------------------------------------------------------------- GET

async function handleGet(type, req, res) {
  const vendedor = req.query.vendedor && req.query.vendedor !== 'todos'
    ? String(req.query.vendedor)
    : null;

  if (type === 'vendedores') {
    return res.json({
      data: await q(
        `select vendedor, ciclo, fase, status, nota_minima,
                atendimentos_necessarios, atendimentos_abertos,
                atendimentos_concluidos, media_fase,
                inicio_agendado, agendado_por, agendado_em, entrou_na_fase_em
         from sim_vendedor_fase
         order by vendedor`
      ),
    });
  }

  if (type === 'status') {
    return res.json({
      data: await q(
        `select * from vw_ia_vendedor_status
         where ($1::text is null or vendedor = $1)
         order by vendedor`,
        [vendedor]
      ),
    });
  }

  if (type === 'criterios') {
    return res.json({
      data: await q(
        `select * from vw_ia_criterios_vendedor
         where ($1::text is null or vendedor = $1)
         order by vendedor, ciclo, fase`,
        [vendedor]
      ),
    });
  }

  if (type === 'evolucao') {
    return res.json({
      data: await q(
        `select vendedor, tipo, ciclo, fase, data, nota_final,
                classificacao, atingiu_minimo
         from vw_ia_evolucao
         where ($1::text is null or vendedor = $1)
           and data is not null
         order by data`,
        [vendedor]
      ),
    });
  }

  if (type === 'trilha') {
    const [serie, resumo] = await Promise.all([
      q(
        `select vendedor, fonte, dia, eventos, indicador, indicador_tipo
         from vw_trilha_x_treinamento
         where ($1::text is null or vendedor = $1)
         order by dia`,
        [vendedor]
      ),
      q(
        `select * from vw_trilha_resumo
         where ($1::text is null or vendedor = $1)`,
        [vendedor]
      ),
    ]);
    return res.json({ data: serie, resumo });
  }

  // Desempenho por etapa/pergunta da trilha — mostra onde as vendedoras
  // mais erram (a "pontuação de critérios" da trilha)
  if (type === 'trilha_etapas') {
    return res.json({
      data: await q(
        `select etapa_id,
                coalesce(origem, '(sem origem)') as origem,
                max(pergunta) as pergunta,
                count(*) as respostas,
                count(*) filter (where acertou) as acertos,
                count(*) filter (where not acertou) as erros,
                round(100.0 * count(*) filter (where acertou) / nullif(count(*), 0), 1) as pct_acerto,
                count(distinct vendedor) as vendedores
           from trilha_respostas
          where vendedor is not null and btrim(vendedor) <> ''
            and ($1::text is null or vendedor = $1)
          group by etapa_id, coalesce(origem, '(sem origem)')
          order by pct_acerto asc, respostas desc`,
        [vendedor]
      ),
    });
  }

  // Respostas individuais — permite abrir o que cada vendedora respondeu
  if (type === 'trilha_respostas') {
    const etapa = req.query.etapa || null;
    const somenteErros = String(req.query.erros || '') === '1';
    return res.json({
      data: await q(
        `select id, sessao_id, vendedor, origem, etapa_id, pergunta,
                resposta_dada, resposta_correta, acertou, motivo_especial, criado_em
           from trilha_respostas
          where vendedor is not null and btrim(vendedor) <> ''
            and ($1::text is null or vendedor = $1)
            and ($2::text is null or etapa_id = $2)
            and ($3::boolean is false or not acertou)
          order by criado_em desc
          limit 500`,
        [vendedor, etapa, somenteErros]
      ),
    });
  }

  if (type === 'atendimentos') {
    return res.json({
      data: await q(
        `select id, vendedor, ciclo, fase, cenario_fluxograma, roteiro_entrada,
                status, turnos, nota_final, classificacao, atingiu_minimo,
                precisa_refazer, created_at, avaliado_em, conversation
         from sim_atendimentos
         where ($1::text is null or vendedor = $1)
         order by created_at desc
         limit 200`,
        [vendedor]
      ),
    });
  }

  if (type === 'fases') {
    return res.json({
      data: await q(
        `select vendedor, ciclo, fase, tentativa, qtd_atendimentos, media_nota,
                nota_minima, aprovado, atendimentos_abaixo_minimo,
                criterios_fortes, criterios_fracos, parecer, created_at
         from sim_fase_resultado
         where ($1::text is null or vendedor = $1)
         order by created_at desc
         limit 100`,
        [vendedor]
      ),
    });
  }

  if (type === 'treinos') {
    return res.json({
      data: await q(
        `select id, vendedor, titulo, ciclo, fase, status, turnos,
                nota_parcial, nota_final, classificacao, atingiu_minimo,
                nota_minima, notas_criterio, resumo_final,
                created_at, encerrado_em
         from trein_sessoes
         where ($1::text is null or vendedor = $1)
         order by created_at desc
         limit 50`,
        [vendedor]
      ),
    });
  }

  if (type === 'sistema') {
    const rows = await q(
      `select id, ativo, hora_inicio, hora_fim, dias_semana, atualizado_em
         from sim_config
        where id = 1`
    );
    return res.json({ data: rows[0] || null });
  }

  return res.status(400).json({ error: `type desconhecido: ${type}` });
}

// --------------------------------------------------------------- POST

async function handlePost(type, req, res) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};

  if (type === 'agendar') {
    const { vendedor, inicio, agendado_por } = body;
    if (!vendedor || !inicio) {
      return res.status(400).json({ error: 'vendedor e inicio sao obrigatorios' });
    }
    const rows = await q(
      `update sim_vendedor_fase
          set inicio_agendado = $2,
              agendado_por    = $3,
              agendado_em     = now(),
              status          = 'ativo',
              atualizado_em   = now()
        where vendedor = $1
      returning vendedor, status, inicio_agendado, ciclo, fase`,
      [vendedor, inicio, agendado_por || 'dashboard']
    );
    if (!rows.length) return res.status(404).json({ error: 'vendedora nao encontrada' });
    return res.json({ ok: true, data: rows[0] });
  }

  if (type === 'pausar') {
    const { vendedor } = body;
    const rows = await q(
      `update sim_vendedor_fase
          set status = 'pausado', inicio_agendado = null, atualizado_em = now()
        where vendedor = $1
      returning vendedor, status, inicio_agendado`,
      [vendedor]
    );
    if (!rows.length) return res.status(404).json({ error: 'vendedora nao encontrada' });
    return res.json({ ok: true, data: rows[0] });
  }

  if (type === 'habilitar') {
    const { vendedor, chatwoot_agent_id } = body;
    const rows = await q(
      `insert into sim_vendedor_fase
         (vendedor, chatwoot_agent_id, ciclo, fase, status,
          atendimentos_necessarios, nota_minima)
       values ($1, $2, 1, 1, 'pausado', 1, 3.5)
       on conflict (vendedor) do update set chatwoot_agent_id = excluded.chatwoot_agent_id
       returning vendedor, ciclo, fase, status`,
      [vendedor, chatwoot_agent_id || null]
    );
    return res.json({ ok: true, data: rows[0] });
  }

  if (type === 'sistema') {
    const { ativo } = body;
    if (typeof ativo !== 'boolean') {
      return res.status(400).json({ error: 'ativo (boolean) é obrigatório' });
    }
    const rows = await q(
      `update sim_config
          set ativo = $1, atualizado_em = now()
        where id = 1
      returning id, ativo, hora_inicio, hora_fim, dias_semana, atualizado_em`,
      [ativo]
    );
    if (!rows.length) return res.status(404).json({ error: 'sim_config (id=1) não encontrado' });
    return res.json({ ok: true, data: rows[0] });
  }

  // proxy para o W4 do n8n (iniciar | mensagem | encerrar | historico)
  if (type === 'treino') {
    const r = await fetch(N8N_TREINO_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const txt = await r.text();
    let data;
    try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
    return res.status(r.ok ? 200 : 502).json(data);
  }

  return res.status(400).json({ error: `type desconhecido: ${type}` });
}
