import { Pool } from 'pg';

// Leads de REFIN vindos da Facta.
// A consulta na Facta passa pelo n8n (IP fixo) — mesmo caminho já usado em
// api/facta.js. Aqui ficam a persistência, a divisão entre vendedoras e o
// controle de trabalho.

const N8N_BASE = process.env.N8N_BASE_URL || 'https://hotn8n.querosacarfgts.com.br';
const N8N_REFIN_URL = `${N8N_BASE}/webhook/facta-refin-lote`;

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
// 'pago' e 'cancelado_banco' também são setados pela sincronização com a Facta.
export const STATUS = [
  'novo',
  'em_abordagem',
  'sem_retorno',
  'nao_interagiu',
  'simulacao_enviada',
  'aguardando_cliente',
  'recusou',
  'nao_elegivel',
  'pago',
  'cancelado_banco',
];

export default async function handler(req, res) {
  const type = String(req.query.type || '');
  try {
    if (req.method === 'POST') return await handlePost(type, req, res);
    return await handleGet(type, req, res);
  } catch (err) {
    console.error('[api/refin]', type, err);
    return res.status(500).json({ error: err.message || 'Erro interno' });
  }
}

// ---------------------------------------------------------------- GET

async function handleGet(type, req, res) {
  // Lista os leads. Sem vendedor => visão geral (todos).
  if (type === 'listar') {
    const vendedor = req.query.vendedor ? String(req.query.vendedor) : null;
    const status = req.query.status ? String(req.query.status) : null;
    // "só os que ainda não fizeram"
    const soNovos = String(req.query.novos || '') === '1';

    return res.json({
      data: await q(
        `select id, codigo_af, cpf, cliente, telefone, tabela, tipo_operacao,
                averbador, valor_af, valor_bruto, vlrprestacao, numeroprestacao,
                taxa, saldo_devedor, valor_iof, valor_seguro, matricula,
                numero_contrato, numero_contrato_refin, banco, agencia, conta,
                tipo_chave_pix, chave_pix, assinatura_digital,
                observacao_ocorrencia, data_digitacao, data_movimento,
                status_proposta, status_crivo, status_banco_atualizado_em,
                vendedor, status_trabalho, observacao,
                valor_fechado, parcelas_fechado, marcado_pago_em, importado_em
           from refin_leads
          where ($1::text is null or vendedor = $1)
            and ($2::text is null or status_trabalho = $2)
            and ($3::boolean is false or status_trabalho = 'novo')
          order by (status_trabalho = 'novo') desc, data_digitacao desc nulls last, cliente`,
        [vendedor, status, soNovos]
      ),
    });
  }

  // Resumo por vendedora e por status — alimenta a visão de gestão
  if (type === 'resumo') {
    const porVendedora = await q(
      `select coalesce(vendedor, '(sem dono)') as vendedor,
              count(*) as total,
              count(*) filter (where status_trabalho = 'novo') as novos,
              count(*) filter (where status_trabalho = 'pago') as pagos,
              count(*) filter (where status_trabalho not in ('novo','pago','cancelado_banco')) as em_andamento,
              count(*) filter (where status_trabalho = 'cancelado_banco') as cancelados,
              round(sum(coalesce(valor_fechado, valor_af)) filter (where status_trabalho = 'pago'), 2) as valor_pago
         from refin_leads
        group by 1 order by 1`
    );
    const porStatus = await q(
      `select status_trabalho, count(*) as total from refin_leads group by 1 order by 2 desc`
    );
    const totais = await q(
      `select count(*) as total,
              count(*) filter (where status_trabalho = 'novo') as novos,
              count(*) filter (where vendedor is null) as sem_dono,
              max(importado_em) as ultima_importacao,
              max(status_banco_atualizado_em) as ultima_sincronizacao
         from refin_leads`
    );
    return res.json({ data: { porVendedora, porStatus, totais: totais[0] } });
  }

  if (type === 'historico') {
    const leadId = Number(req.query.lead_id);
    if (!leadId) return res.status(400).json({ error: 'lead_id é obrigatório' });
    return res.json({
      data: await q(
        `select de, para, por, observacao, criado_em
           from refin_leads_hist where lead_id = $1 order by criado_em desc`,
        [leadId]
      ),
    });
  }

  return res.status(400).json({ error: `type desconhecido: ${type}` });
}

// --------------------------------------------------------------- POST

async function handlePost(type, req, res) {
  const body = req.body || {};

  // Muda o status de trabalho do lead (e registra no histórico)
  if (type === 'status') {
    const codigoAf = String(body.codigo_af || '');
    const novo = String(body.status || '');
    const por = body.por ? String(body.por) : null;
    if (!codigoAf) return res.status(400).json({ error: 'codigo_af é obrigatório' });
    if (!STATUS.includes(novo)) {
      return res.status(400).json({ error: `status inválido: ${novo}` });
    }
    // 'pago' tem caminho próprio, porque lança em vendas_gerais
    if (novo === 'pago') {
      return res.status(400).json({ error: "use type=pago para marcar como pago" });
    }

    const atual = await q(`select id, status_trabalho from refin_leads where codigo_af = $1`, [codigoAf]);
    if (!atual.length) return res.status(404).json({ error: 'lead não encontrado' });

    const rows = await q(
      `update refin_leads
          set status_trabalho = $2,
              observacao = coalesce($3, observacao),
              atualizado_em = now()
        where codigo_af = $1
      returning id, codigo_af, status_trabalho, observacao`,
      [codigoAf, novo, body.observacao ?? null]
    );
    await q(
      `insert into refin_leads_hist (lead_id, de, para, por, observacao)
       values ($1, $2, $3, $4, $5)`,
      [atual[0].id, atual[0].status_trabalho, novo, por, body.observacao ?? null]
    );
    return res.json({ ok: true, data: rows[0] });
  }

  // Marca como pago: atualiza o lead e lança em vendas_gerais
  if (type === 'pago') {
    const codigoAf = String(body.codigo_af || '');
    if (!codigoAf) return res.status(400).json({ error: 'codigo_af é obrigatório' });
    const rows = await q(
      `select refin_marcar_pago($1, $2, $3, $4, $5) as r`,
      [
        codigoAf,
        body.por ? String(body.por) : null,
        body.valor === undefined || body.valor === '' ? null : Number(body.valor),
        body.parcelas === undefined || body.parcelas === '' ? null : Number(body.parcelas),
        body.observacao ?? null,
      ]
    );
    return res.json(rows[0].r);
  }

  // Divide os leads intocados igualmente entre as vendedoras informadas
  if (type === 'distribuir') {
    const vendedoras = Array.isArray(body.vendedoras) ? body.vendedoras.filter(Boolean) : [];
    if (!vendedoras.length) {
      return res.status(400).json({ error: 'informe ao menos uma vendedora' });
    }
    const rows = await q(`select * from refin_distribuir($1::text[])`, [vendedoras]);
    return res.json({ ok: true, distribuicao: rows });
  }

  // Move um lead pra outra vendedora (gestão)
  if (type === 'atribuir') {
    const codigoAf = String(body.codigo_af || '');
    if (!codigoAf) return res.status(400).json({ error: 'codigo_af é obrigatório' });
    const rows = await q(
      `update refin_leads set vendedor = $2, atualizado_em = now()
        where codigo_af = $1 returning id, codigo_af, vendedor`,
      [codigoAf, body.vendedor ? String(body.vendedor) : null]
    );
    if (!rows.length) return res.status(404).json({ error: 'lead não encontrado' });
    return res.json({ ok: true, data: rows[0] });
  }

  if (type === 'excluir') {
    const codigoAf = String(body.codigo_af || '');
    if (!codigoAf) return res.status(400).json({ error: 'codigo_af é obrigatório' });
    const rows = await q(`delete from refin_leads where codigo_af = $1 returning id`, [codigoAf]);
    return res.json({ ok: true, excluidos: rows.length });
  }

  // Importa um período da Facta (via n8n) e grava os leads
  if (type === 'importar') {
    const dataIni = String(body.data_ini || '');
    const dataFim = String(body.data_fim || '');
    if (!dataIni || !dataFim) {
      return res.status(400).json({ error: 'informe data_ini e data_fim (DD/MM/AAAA)' });
    }
    const propostas = await buscaNoN8n({ acao: 'andamento', data_ini: dataIni, data_fim: dataFim });
    const rows = await q(`select refin_importar($1::jsonb) as r`, [JSON.stringify(propostas)]);
    return res.json({ ...rows[0].r, recebidas_da_facta: propostas.length });
  }

  // Sincroniza status com a Facta (16 = pago, 28 = cancelado)
  if (type === 'sincronizar') {
    const dataAlteracao = body.data_alteracao ? String(body.data_alteracao) : null;
    const propostas = await buscaNoN8n({ acao: 'atualizadas', data_alteracao: dataAlteracao });
    const rows = await q(`select refin_sincronizar_status($1::jsonb) as r`, [JSON.stringify(propostas)]);
    return res.json({ ...rows[0].r, recebidas_da_facta: propostas.length });
  }

  return res.status(400).json({ error: `type desconhecido: ${type}` });
}

// Fala com o n8n, que tem o IP fixo exigido pela Facta. O n8n cuida da
// paginação e devolve o array cru de propostas.
async function buscaNoN8n(payload) {
  const resp = await fetch(N8N_REFIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const texto = await resp.text();
  let data;
  try {
    data = JSON.parse(texto);
  } catch {
    const amostra = texto.slice(0, 300).replace(/\s+/g, ' ').trim();
    throw new Error(`n8n não devolveu JSON válido (status ${resp.status}): ${amostra}`);
  }
  if (data?.error || data?.erro) {
    throw new Error(data.error || data.mensagem || 'erro na consulta à Facta');
  }
  // aceita tanto { propostas: [...] } quanto o array direto
  const lista = Array.isArray(data) ? data : data.propostas || data.data || [];
  if (!Array.isArray(lista)) throw new Error('retorno da Facta em formato inesperado');
  return lista;
}
