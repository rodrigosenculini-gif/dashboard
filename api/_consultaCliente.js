// Consulta de cliente em tres fontes, em cascata:
//   1) CRM proprio  — sera a primeira quando ligado (CONSULTA_CRM_ATIVO=1)
//   2) Nova Vida    — NVBOOK CEL OBG WHATS (SOAP): so retorna quem tem
//                     celular com WhatsApp, que e o que interessa pra abordagem
//   3) Lemit        — reserva, quando a Nova Vida nao acha
//
// Todas devolvem o mesmo formato normalizado, para a tela nao saber de onde veio.

const NV_WS = 'https://wsnv.novavidati.com.br/WSLocalizador.asmx'
const LEMIT_URL = 'https://api.lemit.com.br/api/v1/consulta/pessoa'
const CRM_URL = process.env.CONSULTA_CRM_URL || 'https://server-hotline.appsi.online/api-lemit/'

const soNum = (v) => String(v || '').replace(/\D/g, '')

// ---------- utilidades de XML (a Nova Vida responde SOAP) ----------
function tag(xml, nome) {
  const m = xml.match(new RegExp(`<${nome}>([\\s\\S]*?)</${nome}>`, 'i'))
  return m ? m[1].trim() : ''
}
function blocos(xml, nome) {
  const re = new RegExp(`<${nome}>([\\s\\S]*?)</${nome}>`, 'gi')
  const out = []
  let m
  while ((m = re.exec(xml)) !== null) out.push(m[1])
  return out
}
// o retorno vem escapado dentro do envelope: &lt;CONSULTA&gt;...
function desescapar(t) {
  return String(t || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

const vazio = () => ({
  ok: false, nome: null, nascimento: null, idade: null, nome_mae: null,
  sexo: null, situacao_cpf: null, obito: false, renda: null, score: null,
  faixa_score: null, ocupacao: null, fgts_tem: false, fgts_valor: null,
  telefones: [], emails: [], enderecos: [], extras: {},
})

// ---------- Nova Vida (SOAP) ----------
async function novaVidaToken(client, { renovar = false } = {}) {
  if (!renovar) {
    const guardado = await client.query(
      "select token from api_tokens where servico='novavida' and expira_em > now()")
    if (guardado.rows.length) return guardado.rows[0].token
  }

  const usuario = process.env.NOVAVIDA_USUARIO
  const senha = process.env.NOVAVIDA_SENHA
  const cliente = process.env.NOVAVIDA_CLIENTE
  if (!usuario || !senha || !cliente) throw new Error('credenciais da Nova Vida ausentes')

  // a doc pede as credenciais em BASE64
  const b64 = (v) => Buffer.from(String(v), 'utf8').toString('base64')
  const corpo = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GerarToken xmlns="http://tempuri.org/">
      <usuario>${b64(usuario)}</usuario>
      <senha>${b64(senha)}</senha>
      <cliente>${b64(cliente)}</cliente>
    </GerarToken>
  </soap:Body>
</soap:Envelope>`

  const r = await fetch(`${NV_WS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'http://tempuri.org/GerarToken' },
    body: corpo,
  })
  const xml = await r.text()
  const token = tag(xml, 'GerarTokenResult')
  if (!token || token.length < 10) throw new Error('token da Nova Vida nao veio')

  await client.query(
    `insert into api_tokens (servico, token, expira_em)
     values ('novavida', $1, now() + interval '23 hours')
     on conflict (servico) do update set token=excluded.token, expira_em=excluded.expira_em`,
    [token])
  return token
}

async function consultaNovaVida(client, cpf, { renovar = false } = {}) {
  const token = await novaVidaToken(client, { renovar })
  const corpo = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <NvBookCelObWhats xmlns="http://tempuri.org/">
      <documento>${cpf}</documento>
      <token>${token}</token>
    </NvBookCelObWhats>
  </soap:Body>
</soap:Envelope>`

  const r = await fetch(NV_WS, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'http://tempuri.org/NvBookCelObWhats' },
    body: corpo,
  })
  const bruto = await r.text()
  const xml = desescapar(tag(bruto, 'NvBookCelObWhatsResult') || bruto)

  const d = vazio()
  d.payload = { xml: xml.slice(0, 8000) }

  // A Nova Vida pode invalidar o token antes das 23h que guardamos (outro
  // login, inatividade). Nesse caso ela responde TOKEN EXPIRADO e o codigo
  // seguia mandando o token velho pra sempre. Agora gera outro e repete uma vez.
  if (/token\s*expirado/i.test(xml) && !renovar) {
    await client.query("delete from api_tokens where servico='novavida'")
    return consultaNovaVida(client, cpf, { renovar: true })
  }

  if (!/\<CADASTRO\>/i.test(xml)) {
    // guarda o inicio do XML: o erro da Nova Vida vem no proprio envelope
    const falha = tag(bruto, 'faultstring') || tag(xml, 'MENSAGEM') || tag(xml, 'ERRO')
    d.mensagem = `Nova Vida HTTP ${r.status}: ${
      falha || (xml || '').replace(/\s+/g, ' ').slice(0, 200) || 'resposta vazia'}`
    return d
  }

  const cad = tag(xml, 'CADASTRO')
  d.ok = true
  d.nome = tag(cad, 'NOME') || null
  d.nome_mae = tag(cad, 'NOME_MAE') || null
  d.sexo = tag(cad, 'SEXO') || null
  // NASC vem como AAAAMMDD
  const nasc = soNum(tag(cad, 'NASC'))
  d.nascimento = nasc.length === 8 ? `${nasc.slice(0,4)}-${nasc.slice(4,6)}-${nasc.slice(6,8)}` : null
  d.idade = Number(tag(cad, 'IDADE')) || null
  d.ocupacao = tag(cad, 'DESCRICAO_CBO') || null

  for (const c of blocos(xml, 'CELULAR')) {
    const num = soNum(tag(c, 'CEL'))
    if (!num) continue
    d.telefones.push({
      ddd: soNum(tag(c, 'DDDCEL')), numero: num, tipo: 'celular',
      whatsapp: /^s/i.test(tag(c, 'FLWHATSAPP')),
      procon: /^s/i.test(tag(c, 'PROCON')),
    })
  }
  for (const t of blocos(xml, 'TELEFONE')) {
    const num = soNum(tag(t, 'TELEFONE'))
    if (!num || num.length < 8) continue
    d.telefones.push({ ddd: soNum(tag(t, 'DDD')), numero: num, tipo: 'fixo', whatsapp: false })
  }
  for (const e of blocos(xml, 'EMAIL')) {
    const mail = tag(e, 'EMAIL')
    if (mail && mail.includes('@')) d.emails.push({ email: mail })
  }
  for (const en of blocos(xml, 'ENDERECO')) {
    const log = [tag(en,'TIPO'), tag(en,'TITULO'), tag(en,'LOGRADOURO'), tag(en,'NUMERO')]
      .filter(Boolean).join(' ')
    if (!log && !tag(en,'CEP')) continue
    d.enderecos.push({
      logradouro: log, complemento: tag(en,'COMPLEMENTO') || null,
      bairro: tag(en,'BAIRRO') || null, cidade: tag(en,'CIDADE') || null,
      uf: tag(en,'UF') || null, cep: soNum(tag(en,'CEP')) || null,
    })
  }

  const cred = tag(xml, 'CREDITO')
  if (cred) {
    d.score = tag(cred, 'SCORE') || null
    d.faixa_score = tag(cred, 'FAIXA_SCORE') || null
    d.obito = /^s/i.test(tag(cred, 'FLOBITO'))
    d.extras.fonte_renda = tag(cred, 'FONTE_RENDA') || null
    d.extras.veiculo = /^s/i.test(tag(cred, 'FLVEICULO'))
    d.extras.imovel = /^s/i.test(tag(cred, 'FLIMOVEL'))
  }
  const emp = tag(xml, 'EMPRESA')
  if (emp) {
    d.fgts_tem = /^s/i.test(tag(emp, 'FLFGTS'))
    d.fgts_valor = Number(soNum(tag(emp, 'VALOR_PRESUMIDO'))) || null
    d.extras.empresa = tag(emp, 'RAZAO') || null
  }
  return d
}

// ---------- Lemit ----------
// O Lemit trava por IP e o servidor do Vercel nao esta liberado -- de la a
// resposta e 403 "Acesso fora do local permitido". Por isso a chamada sai
// pelo n8n, cujo IP a empresa ja liberou. Direto so em ambiente onde o IP
// esteja autorizado (LEMIT_DIRETO=1).
async function consultaLemit(cpf) {
  const token = process.env.LEMIT_TOKEN
  const viaN8n = process.env.LEMIT_WEBHOOK
  const d = vazio()

  if (viaN8n && process.env.LEMIT_DIRETO !== '1') {
    const r = await fetch(viaN8n, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cpf, chave: process.env.CONSULTA_CHAVE || '' }),
    })
    const bruto = await r.text()
    let j = null
    try { j = JSON.parse(bruto) } catch { /* nao veio json */ }
    d.payload = j || { bruto: bruto.slice(0, 500) }
    const p = j?.pessoa || j?.data?.pessoa
    if (!p) {
      d.mensagem = `Lemit (via n8n) HTTP ${r.status}: ${
        j?.erro || j?.errors ? JSON.stringify(j.erro || j.errors) : bruto.slice(0, 160) || 'resposta vazia'}`
      return d
    }
    return preencherLemit(d, p)
  }

  if (!token) { d.mensagem = 'token do Lemit ausente'; return d }
  const r = await fetch(`${LEMIT_URL}/${cpf}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  const bruto = await r.text()
  let j = null
  try { j = JSON.parse(bruto) } catch { /* nao veio json */ }
  d.payload = j || { bruto: bruto.slice(0, 500) }
  const p = j?.pessoa
  if (!p) {
    // o motivo importa: 401 e token, 403 e IP, 404 e CPF sem cadastro
    d.mensagem = `Lemit HTTP ${r.status}: ${
      j?.errors ? JSON.stringify(j.errors) : bruto.slice(0, 160) || 'resposta vazia'}`
    return d
  }
  return preencherLemit(d, p)
}

// o formato do Lemit e o mesmo vindo direto ou pelo n8n
function preencherLemit(d, p) {
  d.ok = true
  d.nome = p.nome || null
  d.nome_mae = p.nome_mae || null
  d.sexo = p.sexo || null
  d.nascimento = p.data_nascimento ? String(p.data_nascimento).slice(0, 10) : null
  d.situacao_cpf = p.situacao_cpf || null
  d.obito = !!p.falecido
  d.renda = p.renda != null ? String(p.renda) : null
  d.ocupacao = p.ocupacao || null
  d.faixa_score = p.risco_credito?.score_credito || null

  for (const c of p.celulares || []) {
    d.telefones.push({
      ddd: String(c.ddd || ''), numero: String(c.numero || ''), tipo: 'celular',
      whatsapp: !!c.whatsapp, ranking: c.ranking,
    })
  }
  for (const f of p.fixos || []) {
    d.telefones.push({ ddd: String(f.ddd || ''), numero: String(f.numero || ''), tipo: 'fixo', whatsapp: false })
  }
  for (const e of p.emails || []) if (e.email) d.emails.push({ email: e.email })
  for (const en of p.enderecos || []) {
    d.enderecos.push({
      logradouro: en.endereco || null, bairro: en.bairro || null,
      cidade: en.cidade || null, uf: en.uf || null, cep: soNum(en.cep) || null,
      tipo: en.tipo || null,
    })
  }
  if ((p.carros || []).length) d.extras.carros = p.carros.length
  if ((p.vinculos || []).length) d.extras.vinculos = p.vinculos.slice(0, 5)
  return d
}

// ---------- CRM proprio (fica pronto, ligado por variavel) ----------
async function consultaCrm(cpf) {
  const d = vazio()
  const r = await fetch(`${CRM_URL}?cpf=${encodeURIComponent(cpf)}`, {
    headers: { Accept: 'application/json' },
  })
  const j = await r.json().catch(() => null)
  d.payload = j
  // o CRM devolve o mesmo formato do Lemit
  const p = j?.pessoa || j?.data?.pessoa
  if (!p) { d.mensagem = 'sem retorno no CRM'; return d }

  d.ok = true
  d.nome = p.nome || null
  d.nome_mae = p.nome_mae || null
  d.nascimento = p.data_nascimento ? String(p.data_nascimento).slice(0, 10) : null
  d.situacao_cpf = p.situacao_cpf || null
  d.obito = !!p.falecido
  d.renda = p.renda != null ? String(p.renda) : null
  for (const c of p.celulares || []) {
    d.telefones.push({ ddd: String(c.ddd || ''), numero: String(c.numero || ''), tipo: 'celular', whatsapp: !!c.whatsapp })
  }
  for (const e of p.emails || []) if (e.email) d.emails.push({ email: e.email })
  for (const en of p.enderecos || []) {
    d.enderecos.push({
      logradouro: en.endereco || null, bairro: en.bairro || null,
      cidade: en.cidade || null, uf: en.uf || null, cep: soNum(en.cep) || null,
    })
  }
  return d
}

/**
 * Consulta nas tres fontes, na ordem, parando na primeira que responder.
 * Devolve o resultado normalizado com a fonte usada e o que foi tentado.
 */
async function consultarCliente(client, cpf, { forcar = false, por = null } = {}) {
  const n = soNum(cpf)
  if (n.length !== 11) return { erro: 'CPF inválido' }

  if (!forcar) {
    const cache = await client.query('select * from dashboard_consulta_cache($1::text, 24)', [n])
    if (cache.rows.length) return { ...cache.rows[0], do_cache: true }
  }

  const tentativas = []
  const fontes = []
  // o CRM sera o primeiro quando ligado
  if (process.env.CONSULTA_CRM_ATIVO === '1') fontes.push(['crm', () => consultaCrm(n)])
  fontes.push(['novavida', () => consultaNovaVida(client, n)])
  fontes.push(['lemit', () => consultaLemit(n)])

  for (const [nome, executar] of fontes) {
    try {
      const d = await executar()
      tentativas.push({ fonte: nome, ok: d.ok, mensagem: d.mensagem || null })
      // so aceita se achou a pessoa E tem algum contato util
      if (d.ok && (d.telefones.length || d.emails.length || d.nome)) {
        const salvo = await client.query('select * from dashboard_consulta_salvar($1::jsonb)', [
          JSON.stringify({ ...d, cpf: n, fonte: nome, por, ok: true }),
        ])
        return { ...salvo.rows[0], tentativas }
      }
    } catch (e) {
      tentativas.push({ fonte: nome, ok: false, mensagem: String(e.message || e) })
    }
  }

  const salvo = await client.query('select * from dashboard_consulta_salvar($1::jsonb)', [
    JSON.stringify({ cpf: n, fonte: 'nenhuma', por, ok: false,
      mensagem: 'não encontrado nas fontes consultadas',
      // o porque de cada fonte ter falhado fica gravado: sem isso so sobrava
      // o resultado final, que nao diz nada
      extras: { tentativas } }),
  ])
  return { ...salvo.rows[0], tentativas }
}

export { consultarCliente }
