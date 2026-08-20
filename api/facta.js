// Integração com a Facta (só consulta) — via n8n, porque o servidor da
// Facta exige IP fixo, e o Vercel serverless não tem IP fixo. O n8n roda
// numa VPS própria (IP fixo de verdade), então ele que fala direto com a
// Facta; esse endpoint só repassa a chamada do navegador pro n8n.

const N8N_WEBHOOK_URL = `${process.env.N8N_BASE_URL || 'https://hotn8n.querosacarfgts.com.br'}/webhook/facta-consulta`;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const { type, cpf, af } = req.query;
  const cpfLimpo = cpf ? String(cpf).replace(/\D/g, '') : '';

  if (type === 'andamento' && !cpfLimpo && !af) {
    return res.status(400).json({ error: 'Informe CPF ou código AF.' });
  }
  if ((type === 'refin' || type === 'cliente') && !cpfLimpo) {
    return res.status(400).json({ error: 'Essa consulta precisa do CPF.' });
  }
  if (!['andamento', 'refin', 'cliente'].includes(type)) {
    return res.status(400).json({ error: `type inválido: ${type}` });
  }

  try {
    const resp = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, cpf: cpfLimpo || undefined, af: af || undefined }),
    });
    const texto = await resp.text();
    let data;
    try {
      data = JSON.parse(texto);
    } catch {
      const amostra = texto.slice(0, 300).replace(/\s+/g, ' ').trim();
      return res.status(502).json({ error: `n8n não devolveu JSON válido (status ${resp.status}): ${amostra}` });
    }
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
