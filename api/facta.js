// Integração com a API da Facta (só consulta — nunca cria/altera nada lá).
// Credenciais ficam só aqui no servidor (variáveis de ambiente FACTA_USER /
// FACTA_PASS no Vercel), nunca chegam no navegador da vendedora.
//
// Endpoints usados:
//  - GET /gera-token                              (autenticação, token de 1h)
//  - GET /proposta/andamento-propostas             (propostas de qualquer tipo, por cpf ou af)
//  - GET /proposta/contratos-refinanciamento       (contratos elegíveis a refin, por cpf)
//  - GET /proposta/consulta-cliente                (dados cadastrais do cliente, por cpf)

const FACTA_BASE = 'https://webservice.facta.com.br';

// cache em memória do processo — best-effort: sobrevive entre requisições
// enquanto a função serverless ficar "quente", mas não é garantido (cold
// start gera um token novo, o que é seguro, só um pouco mais lento)
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getFactaToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry) {
    return cachedToken;
  }

  const user = process.env.FACTA_USER;
  const pass = process.env.FACTA_PASS;
  if (!user || !pass) {
    throw new Error('Credenciais da Facta não configuradas no servidor (FACTA_USER / FACTA_PASS).');
  }

  const basic = Buffer.from(`${user}:${pass}`).toString('base64');
  const resp = await fetch(`${FACTA_BASE}/gera-token`, {
    method: 'GET',
    headers: { Authorization: `Basic ${basic}` },
  });
  const data = await resp.json();
  if (data.erro) {
    throw new Error(data.mensagem || 'Erro ao gerar token na Facta.');
  }

  cachedToken = data.token;
  // o token dura 1h de verdade — usamos 50min por segurança (margem pra
  // relógio/latência), sem precisar parsear o campo "expira"
  cachedTokenExpiry = now + 50 * 60 * 1000;
  return cachedToken;
}

async function factaGet(path, params, token) {
  const qs = new URLSearchParams(params);
  const resp = await fetch(`${FACTA_BASE}${path}?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return resp.json();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const { type, cpf, af } = req.query;
  const cpfLimpo = cpf ? String(cpf).replace(/\D/g, '') : '';

  try {
    const token = await getFactaToken();

    if (type === 'andamento') {
      if (!cpfLimpo && !af) {
        return res.status(400).json({ error: 'Informe CPF ou código AF.' });
      }
      const params = {};
      if (cpfLimpo) params.cpf = cpfLimpo;
      if (af) params.af = af;
      const data = await factaGet('/proposta/andamento-propostas', params, token);
      return res.status(200).json(data);
    }

    if (type === 'refin') {
      if (!cpfLimpo) {
        return res.status(400).json({ error: 'A consulta de refinanciamento precisa do CPF.' });
      }
      const data = await factaGet('/proposta/contratos-refinanciamento', {
        cpf: cpfLimpo,
        tipo_operacao: '14',
        averbador: '3',
        convenio: '3',
      }, token);
      return res.status(200).json(data);
    }

    if (type === 'cliente') {
      if (!cpfLimpo) {
        return res.status(400).json({ error: 'A consulta de cliente precisa do CPF.' });
      }
      const data = await factaGet('/proposta/consulta-cliente', { cpf: cpfLimpo }, token);
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: `type inválido: ${type}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
