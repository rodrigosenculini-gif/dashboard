import React, { useCallback, useEffect, useMemo, useState } from 'react'
import './IATemplates.css'

// Templates do WhatsApp (Meta) no Painel — dono, 01/10: ver e criar templates das contas da Meta (como no Chatwoot),
// com desempenho (clientes, interação, proposta, pagamento) e sugestões da IA. A Meta só é chamada pelo n8n
// "Meta - Templates" (o token fica lá); o desempenho vem do banco (public.meta_tpl_uso, migração 161).

// dados da última busca (contas/templates da Meta e desempenho por período): voltar à tela abre na hora
const CHAVE_CACHE = 'iac_templates_cache'
let memoria = null
function lerCache() {
  if (memoria) return memoria
  try { memoria = JSON.parse(localStorage.getItem(CHAVE_CACHE) || 'null') || {} } catch { memoria = {} }
  return memoria
}
function gravarCache(parte) {
  memoria = { ...lerCache(), ...parte }
  try { localStorage.setItem(CHAVE_CACHE, JSON.stringify(memoria)) } catch { /* sem espaço: fica só na memória */ }
}

const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : 0)
const fmtPct = (v) => `${String(v).replace('.', ',')}%`
const num = (n) => Number(n || 0).toLocaleString('pt-BR')
const NOME_STATUS = { APPROVED: 'Aprovado', REJECTED: 'Reprovado', PENDING: 'Em análise', PAUSED: 'Pausado', DISABLED: 'Desativado', IN_APPEAL: 'Em recurso' }
const NOME_CAT = { MARKETING: 'Marketing', UTILITY: 'Utilidade', AUTHENTICATION: 'Autenticação' }
const COR_QUAL = { GREEN: 'ok', YELLOW: 'aviso', RED: 'ruim' }
const NOME_QUAL = { GREEN: 'Alta', YELLOW: 'Média', RED: 'Baixa', UNKNOWN: 'Sem avaliação' }

// casos prontos para pedir sugestão (os mesmos do modelo do Chatwoot, ajustados à jornada da IA)
const CASOS = [
  ['Oferta sem resposta', 'Quem recebeu a oferta e parou de responder', 'MARKETING'],
  ['Assinatura pendente', 'Quem recebeu o link de assinatura e não concluiu', 'UTILITY'],
  ['Proposta com pendência', 'O banco devolveu a proposta com uma pendência', 'UTILITY'],
  ['Reengajamento', 'Disparo para reativar contatos antigos', 'MARKETING'],
  ['Viu a oferta na página', 'Quem viu a oferta na página e não continuou', 'MARKETING'],
  ['Autorização pendente', 'Falta o cliente autorizar a consulta (FGTS no app / termo do CLT)', 'UTILITY'],
  ['Primeiro contato (leilão)', 'Primeira mensagem para o lead que veio do leilão', 'MARKETING'],
]

const vazio = () => ({ contas: [], nome: '', categoria: 'MARKETING', idioma: 'pt_BR', cabTipo: 'NENHUM', cabecalho: '', midia: null, corpo: '', exemplos: [], rodape: '', botoes: [] })
const TIPOS_CAB = [['NENHUM', 'Sem cabeçalho'], ['TEXT', 'Texto'], ['IMAGE', 'Imagem'], ['VIDEO', 'Vídeo'], ['DOCUMENT', 'Documento']]
const ACEITA = { IMAGE: 'image/jpeg,image/png', VIDEO: 'video/mp4', DOCUMENT: 'application/pdf' }
const NOME_MIDIA = { IMAGE: 'imagem', VIDEO: 'vídeo', DOCUMENT: 'documento' }
const varsDe = (t) => [...new Set((String(t).match(/\{\{(\d+)\}\}/g) || []).map((x) => Number(x.replace(/\D/g, ''))))].sort((a, b) => a - b)
const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)

function partes(t) {
  const c = t.components || []
  const h = c.find((x) => x.type === 'HEADER'), b = c.find((x) => x.type === 'BODY'), f = c.find((x) => x.type === 'FOOTER')
  const bt = c.find((x) => x.type === 'BUTTONS')
  return { formato: h && h.format !== 'TEXT' ? h.format : null, midiaUrl: h?.example?.header_handle?.[0] || null,
    cabecalho: h && h.format === 'TEXT' ? h.text : '', corpo: b?.text || '',
    exemplos: b?.example?.body_text?.[0] || [], rodape: f?.text || '', botoes: bt?.buttons || [] }
}

// erros que a Meta reprova (conferidos antes de enviar)
function conferir(f) {
  const e = []
  if (!f.contas.length) e.push('Escolha ao menos uma conta.')
  if (!/^[a-z0-9_]{1,512}$/.test(f.nome)) e.push('Nome: só letras minúsculas, números e _.')
  if (!f.corpo.trim()) e.push('Escreva a mensagem.')
  if (f.corpo.length > 1024) e.push('A mensagem passa de 1024 caracteres.')
  const v = varsDe(f.corpo)
  if (v.some((n, i) => n !== i + 1)) e.push('As variáveis precisam ir em ordem: {{1}}, {{2}}, ...')
  if (/^\s*\{\{\d+\}\}/.test(f.corpo) || /\{\{\d+\}\}[\s.!?]*$/.test(f.corpo)) e.push('A Meta não aceita variável no começo nem no fim da mensagem.')
  if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(f.corpo)) e.push('Duas variáveis seguidas: coloque texto entre elas.')
  if (v.some((n) => !String(f.exemplos[n - 1] || '').trim())) e.push('Cada variável precisa de um exemplo.')
  if (f.cabTipo === 'TEXT' && !f.cabecalho.trim()) e.push('Escreva o texto do cabeçalho ou escolha "Sem cabeçalho".')
  if (f.cabTipo === 'TEXT' && f.cabecalho.length > 60) e.push('Cabeçalho: até 60 caracteres.')
  if (ACEITA[f.cabTipo] && !f.midia?.arquivo) e.push(`Envie um arquivo de exemplo (${NOME_MIDIA[f.cabTipo]}) para o cabeçalho.`)
  if (/\{\{/.test(f.cabecalho) || /\{\{/.test(f.rodape)) e.push('Cabeçalho e rodapé sem variáveis.')
  if (f.rodape.length > 60) e.push('Rodapé: até 60 caracteres.')
  const qr = f.botoes.filter((b) => b.tipo === 'QUICK_REPLY').length, url = f.botoes.filter((b) => b.tipo === 'URL').length
  const tel = f.botoes.filter((b) => b.tipo === 'PHONE_NUMBER').length
  if (qr > 3 || url > 2 || tel > 1) e.push('Botões: até 3 de resposta, 2 de link e 1 de telefone.')
  for (const b of f.botoes) {
    if (!b.texto.trim() || b.texto.length > 25) e.push('Texto de botão: de 1 a 25 caracteres.')
    if (b.tipo === 'URL' && !/^https:\/\/\S+$/.test(b.url || '')) e.push('Botão de link precisa de URL https.')
    if (b.tipo === 'PHONE_NUMBER' && !/^\+?\d{12,14}$/.test(String(b.telefone || '').replace(/[\s()-]/g, ''))) e.push('Telefone do botão com DDI e DDD (ex.: +5517...).')
  }
  return [...new Set(e)]
}

function componentes(f, handle) {
  const c = []
  if (f.cabTipo === 'TEXT' && f.cabecalho.trim()) c.push({ type: 'HEADER', format: 'TEXT', text: f.cabecalho.trim() })
  if (ACEITA[f.cabTipo] && handle) c.push({ type: 'HEADER', format: f.cabTipo, example: { header_handle: [handle] } })
  const v = varsDe(f.corpo)
  c.push({ type: 'BODY', text: f.corpo.trim(), ...(v.length ? { example: { body_text: [v.map((n) => String(f.exemplos[n - 1]).trim())] } } : {}) })
  if (f.rodape.trim()) c.push({ type: 'FOOTER', text: f.rodape.trim() })
  if (f.botoes.length) {
    const ordem = [...f.botoes.filter((b) => b.tipo === 'QUICK_REPLY'), ...f.botoes.filter((b) => b.tipo !== 'QUICK_REPLY')]
    c.push({ type: 'BUTTONS', buttons: ordem.map((b) => b.tipo === 'URL' ? { type: 'URL', text: b.texto.trim(), url: b.url.trim() }
      : b.tipo === 'PHONE_NUMBER' ? { type: 'PHONE_NUMBER', text: b.texto.trim(), phone_number: String(b.telefone).replace(/[^\d+]/g, '') }
      : { type: 'QUICK_REPLY', text: b.texto.trim() }) })
  }
  return c
}

function Bolha({ cabecalho, corpo, exemplos = [], rodape, botoes = [], titulo, midia }) {
  const texto = String(corpo || '').replace(/\{\{(\d+)\}\}/g, (m, n) => exemplos[Number(n) - 1] || m)
  return (
    <div className="tpl-zap">
      {titulo && <div className="tpl-zap-topo">{titulo}</div>}
      <div className="tpl-bolha">
        {midia && (midia.url && midia.tipo === 'IMAGE' ? <img className="tpl-bolha-midia" src={midia.url} alt="" />
          : <div className="tpl-bolha-midia vazio">{midia.tipo === 'VIDEO' ? '▶ vídeo' : midia.tipo === 'DOCUMENT' ? `📄 ${midia.nome || 'documento'}` : '🖼 imagem'}</div>)}
        {cabecalho && <b className="tpl-bolha-cab">{cabecalho}</b>}
        <p>{texto || <em className="iac-miudo">A mensagem aparece aqui.</em>}</p>
        {rodape && <small>{rodape}</small>}
      </div>
      {botoes.map((b, i) => (
        <div key={i} className="tpl-bolha-botao">{b.tipo === 'URL' || b.type === 'URL' ? '↗ ' : b.tipo === 'PHONE_NUMBER' || b.type === 'PHONE_NUMBER' ? '✆ ' : '↩ '}{b.texto || b.text}</div>
      ))}
    </div>
  )
}

function Taxas({ u }) {
  if (!u) return <small className="iac-miudo" style={{ margin: 0 }}>Sem envios nossos com este nome no período.</small>
  return (
    <div className="tpl-taxas">
      <span><b>{num(u.leads)}</b> clientes</span>
      <span><b>{fmtPct(pct(u.interagiram, u.leads))}</b> interagiram</span>
      <span><b>{fmtPct(pct(u.propostas, u.leads))}</b> proposta</span>
      <span className={u.pagas ? 'tpl-pago' : ''}><b>{fmtPct(pct(u.pagas, u.leads))}</b> pagaram</span>
    </div>
  )
}

// ---------------------------------------------------------------- criar (com sugestões da IA)
const deInicial = (inicial, bm) => inicial ? { ...inicial, contas: inicial.waba ? [{ id: inicial.waba, bm }] : (inicial.contas || []) } : null

// Criação em lote (dono, 02/10): o mesmo template em várias contas, de qualquer BM; um envio por conta, com o resultado de cada uma
function Criar({ contas, grupos, carregarBm, uso, inicial, chamar, dialogo, mostrar, onCriado, bm }) {
  const [f, setF] = useState(() => ({ ...vazio(), contas: contas[0] ? [{ id: contas[0].id, bm }] : [], ...deInicial(inicial, bm) }))
  const [resultados, setResultados] = useState(null)
  const [caso, setCaso] = useState(null)
  const [ideia, setIdeia] = useState('')
  const [produto, setProduto] = useState('clt')
  const [sug, setSug] = useState(null)
  const [pedindo, setPedindo] = useState(false)
  const [enviando, setEnviando] = useState(false)
  useEffect(() => { if (inicial) setF((x) => ({ ...x, ...deInicial(inicial, bm) })) }, [inicial]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }))
  const erros = conferir(f)
  const vars = varsDe(f.corpo)
  const todasContas = grupos.flatMap((g) => (g.contas || []).map((c) => ({ ...c, bm: g.id, bmNome: g.nome })))
  const conta = todasContas.find((c) => c.id === f.contas[0]?.id) || contas.find((c) => c.id === f.contas[0]?.id)
  const marcada = (id) => f.contas.some((x) => x.id === id)
  const alternar = (c) => set('contas', marcada(c.id) ? f.contas.filter((x) => x.id !== c.id) : [...f.contas, { id: c.id, bm: c.bm }])
  const marcarGrupo = (g, sim) => set('contas', sim
    ? [...f.contas.filter((x) => x.bm !== g.id), ...(g.contas || []).map((c) => ({ id: c.id, bm: g.id }))]
    : f.contas.filter((x) => x.bm !== g.id))

  async function pedirSugestoes() {
    setPedindo(true); setSug(null)
    const desempenho = (uso?.disparos || []).filter((u) => u.leads >= 100).slice(0, 12).map((u) => ({
      nome: u.nome, clientes: u.leads, interacao_pct: pct(u.interagiram, u.leads), proposta_pct: pct(u.propostas, u.leads), pagas_pct: pct(u.pagas, u.leads),
      texto: contas.flatMap((c) => c.templates).find((t) => t.name === u.nome) ? partes(contas.flatMap((c) => c.templates).find((t) => t.name === u.nome)).corpo : undefined,
    }))
    const existentes = (conta?.templates || []).filter((t) => t.status === 'APPROVED').slice(0, 10).map((t) => ({ nome: t.name, categoria: t.category, texto: partes(t).corpo }))
    const r = await chamar({ acao: 'sugerir', pedido: {
      objetivo: caso ? `${caso[0]}: ${caso[1]}` : ideia || 'Template de uso geral', ideia_do_usuario: ideia || undefined,
      produto: produto === 'clt' ? 'crédito do trabalhador CLT' : 'antecipação do saque-aniversário do FGTS',
      categoria_desejada: caso ? caso[2] : undefined, numero: conta ? `${conta.nome} (${conta.numero})` : undefined,
      desempenho_dos_nossos_templates: desempenho, templates_ja_aprovados_nesta_conta: existentes,
      retomadas_da_ia: (uso?.retomadas || []).slice(0, 5),
    } })
    setPedindo(false)
    if (r.ok) setSug(r)
    else mostrar(r.motivo || 'Não foi possível sugerir agora.', 'erro')
  }
  function usar(s) {
    setF((x) => ({ ...x, nome: s.nome, categoria: s.categoria, cabTipo: s.cabecalho?.tipo === 'TEXTO' && s.cabecalho.texto ? 'TEXT' : 'NENHUM', midia: null,
      cabecalho: s.cabecalho?.tipo === 'TEXTO' ? s.cabecalho.texto || '' : '',
      corpo: s.corpo, exemplos: s.exemplos || [], rodape: s.rodape || '',
      botoes: (s.botoes || []).map((b) => ({ tipo: ['URL', 'PHONE_NUMBER'].includes(b.tipo) ? b.tipo : 'QUICK_REPLY', texto: b.texto || '', url: b.url || '', telefone: b.telefone || '' })) }))
    window.scrollTo({ top: document.getElementById('tpl-form')?.offsetTop - 80 || 0, behavior: 'smooth' })
  }
  async function enviar() {
    if (erros.length) return
    const nomes = f.contas.map((x) => todasContas.find((c) => c.id === x.id)?.nome || x.id)
    if (!await dialogo.confirmar({ titulo: `Enviar "${f.nome}" para ${f.contas.length} conta${f.contas.length > 1 ? 's' : ''}?`, rotuloOk: 'Enviar para análise',
      texto: `${nomes.join(', ')}. Depois de aprovado, o template não pode ser editado.` })) return
    setEnviando(true)
    const res = f.contas.map((x) => ({ ...x, nome: todasContas.find((c) => c.id === x.id)?.nome || x.id, estado: 'esperando' }))
    setResultados([...res])
    const handles = {}
    for (const r of res) {
      r.estado = 'enviando'; setResultados([...res])
      let handle = null
      if (ACEITA[f.cabTipo]) {
        // o arquivo de exemplo vale para o app da BM: sobe uma vez por BM
        if (!handles[r.bm]) {
          const m = await chamar({ acao: 'midia', bm: r.bm, midia: { tipo: f.midia.arquivo.tipo, nome: f.midia.nome, base64: f.midia.arquivo.base64 } })
          handles[r.bm] = m.ok ? m.handle : { erro: m.motivo || 'A Meta não aceitou o arquivo.' }
        }
        if (typeof handles[r.bm] !== 'string') { r.estado = 'erro'; r.motivo = handles[r.bm].erro; setResultados([...res]); continue }
        handle = handles[r.bm]
      }
      const x = await chamar({ acao: 'criar', waba: r.id, template: { name: f.nome, category: f.categoria, language: f.idioma, components: componentes(f, handle) } })
      r.estado = x.ok ? 'ok' : 'erro'; r.motivo = x.ok ? (NOME_STATUS[x.status] || x.status || 'em análise') : (x.motivo || 'A Meta recusou.')
      r.categoria = x.categoria
      setResultados([...res])
    }
    setEnviando(false)
    const ok = res.filter((r) => r.estado === 'ok').length
    mostrar(`${ok} de ${res.length} enviados para análise`, ok === res.length ? 'ok' : 'erro')
    if (ok) onCriado(false)
  }
  const [subindo, setSubindo] = useState(false)
  async function subirMidia(arq) {
    if (!arq) return
    if (arq.size > 3 * 1024 * 1024) return mostrar('Arquivo de até 3 MB.', 'erro')
    setSubindo(true)
    const base64 = await new Promise((ok, falhou) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = falhou; r.readAsDataURL(arq) })
    setSubindo(false)
    set('midia', { arquivo: { tipo: arq.type, base64 }, nome: arq.name, tipo: f.cabTipo, url: arq.type.startsWith('image/') ? URL.createObjectURL(arq) : null })
  }
  const inserirVar = () => {
    const n = (vars[vars.length - 1] || 0) + 1
    set('corpo', `${f.corpo}${f.corpo && !/\s$/.test(f.corpo) ? ' ' : ''}{{${n}}} `)
  }
  const setBotao = (i, k, v) => set('botoes', f.botoes.map((b, j) => (j === i ? { ...b, [k]: v } : b)))

  return (
    <>
      <section className="iac-bloco">
        <p className="section-label">Sugestões da IA</p>
        <div className="panel">
          <p className="iac-miudo" style={{ marginTop: 0 }}>A IA lê o desempenho dos nossos templates (quem interagiu, recebeu proposta e pagou) e os
            já aprovados na conta, e propõe 3 versões com ângulos diferentes, dentro das regras da Meta.</p>
          <div className="chip-opcoes" style={{ marginBottom: 10 }}>
            {CASOS.map((c) => (
              <button key={c[0]} className={`chip-opcao ${caso?.[0] === c[0] ? 'on' : ''}`} title={c[1]}
                      onClick={() => setCaso(caso?.[0] === c[0] ? null : c)}>{c[0]}</button>
            ))}
          </div>
          <div className="iac-filtros">
            <div className="chip-opcoes">
              {[['clt', 'CLT'], ['fgts', 'FGTS']].map(([k, t]) => (
                <button key={k} className={`chip-opcao ${produto === k ? 'on' : ''}`} onClick={() => setProduto(k)}>{t}</button>
              ))}
            </div>
            <input className="chip-input" style={{ flex: 1, minWidth: 220 }} value={ideia} onChange={(e) => setIdeia(e.target.value)}
                   placeholder="Ideia ou detalhe (opcional): ex. mencionar que é sem consulta ao SPC" />
            <button className="chip-salvar iac-btn-p" onClick={pedirSugestoes} disabled={pedindo || (!caso && !ideia.trim())}>
              {pedindo ? 'Pensando… (até 1 min)' : '✨ Sugerir'}</button>
          </div>
          {sug && (
            <>
              {sug.leitura && <p className="tpl-leitura">{sug.leitura}</p>}
              <div className="tpl-sugestoes">
                {sug.sugestoes.map((s, i) => (
                  <div key={i} className="tpl-sug">
                    <div className="iac-banco-topo"><b>{s.nome}</b><span className="iac-tag">{NOME_CAT[s.categoria]}</span></div>
                    <Bolha cabecalho={s.cabecalho?.tipo === 'TEXTO' ? s.cabecalho.texto : ''} corpo={s.corpo} exemplos={s.exemplos} rodape={s.rodape}
                           botoes={s.botoes || []} />
                    {s.por_que && <small><b>Por quê:</b> {s.por_que}</small>}
                    {s.atencao && <small className="tpl-atencao"><b>Atenção:</b> {s.atencao}</small>}
                    <button className="chip-salvar iac-btn-p" onClick={() => usar(s)}>Usar esta</button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </section>

      <section className="iac-bloco" id="tpl-form">
        <p className="section-label">Novo template</p>
        <div className="tpl-criar">
          <div className="panel iac-texto-ed" style={{ marginTop: 0 }}>
            <div>
              <span className="iac-rot">Contas ({f.contas.length} marcada{f.contas.length === 1 ? '' : 's'})</span>
              <div className="tpl-lote">
                {grupos.map((g) => {
                  const todas = (g.contas || []).length > 0 && (g.contas || []).every((c) => marcada(c.id))
                  return (
                    <div key={g.id} className="tpl-lote-bm">
                      <div className="tpl-lote-topo"><b>{g.nome}</b>
                        {g.contas ? <button className="iac-link" onClick={() => marcarGrupo(g, !todas)}>{todas ? 'desmarcar todas' : 'marcar todas'}</button>
                          : <button className="iac-link" onClick={() => carregarBm(g.id)}>carregar contas</button>}</div>
                      {(g.contas || []).map((c) => (
                        <label key={c.id} className="tpl-lote-conta">
                          <input type="checkbox" checked={marcada(c.id)} onChange={() => alternar({ ...c, bm: g.id })} />
                          <span>{c.nome} <small className="iac-miudo">{c.numero}</small></span>
                        </label>
                      ))}
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="tpl-grade3">
              <label><span className="iac-rot">Nome</span>
                <input className="chip-input" value={f.nome} onChange={(e) => set('nome', slug(e.target.value))} placeholder="clt_oferta_sem_resposta_v1" /></label>
              <label><span className="iac-rot">Categoria</span>
                <select className="chip-input" value={f.categoria} onChange={(e) => set('categoria', e.target.value)}>
                  <option value="MARKETING">Marketing</option><option value="UTILITY">Utilidade</option>
                </select></label>
            </div>
            <p className="iac-miudo" style={{ margin: 0 }}>Utilidade só para algo ligado a um pedido do cliente, sem oferta. A Meta reclassifica: oferta enviada como Utilidade vira Marketing.</p>
            <div>
              <span className="iac-rot">Cabeçalho</span>
              <div className="chip-opcoes" style={{ margin: '4px 0 6px' }}>
                {TIPOS_CAB.map(([k, t]) => (
                  <button key={k} className={`chip-opcao ${f.cabTipo === k ? 'on' : ''}`}
                          onClick={() => setF((x) => ({ ...x, cabTipo: k, midia: k === x.cabTipo ? x.midia : null }))}>{t}</button>
                ))}
              </div>
              {f.cabTipo === 'TEXT' && <input className="chip-input" value={f.cabecalho} maxLength={60} onChange={(e) => set('cabecalho', e.target.value)} placeholder="Até 60 caracteres" />}
              {ACEITA[f.cabTipo] && (
                <div className="iac-filtros" style={{ margin: 0 }}>
                  <label className="reset-btn tpl-arquivo">{subindo ? 'Lendo o arquivo…' : f.midia?.arquivo ? `Trocar ${NOME_MIDIA[f.cabTipo]}` : `Escolher ${NOME_MIDIA[f.cabTipo]} de exemplo`}
                    <input type="file" accept={ACEITA[f.cabTipo]} disabled={subindo} onChange={(e) => subirMidia(e.target.files?.[0])} /></label>
                  {f.midia?.arquivo && <small className="iac-miudo" style={{ margin: 0 }}>✓ {f.midia.nome} (vai junto com o template)</small>}
                  <small className="iac-miudo" style={{ margin: 0 }}>Exemplo para a Meta aprovar (até 3 MB). No envio, cada disparo pode usar outra {NOME_MIDIA[f.cabTipo]}.</small>
                </div>
              )}
            </div>
            <label><span className="iac-rot">Mensagem ({f.corpo.length}/1024)</span>
              <textarea className="chip-input" rows={6} value={f.corpo} onChange={(e) => set('corpo', e.target.value)}
                        placeholder="Olá {{1}}! Aqui é da Hotline. ..." /></label>
            <div className="iac-filtros" style={{ margin: 0 }}>
              <button className="reset-btn" onClick={inserirVar}>{'{ }'} Inserir variável</button>
              {vars.map((n) => (
                <label key={n} className="tpl-var"><span className="iac-rot">{`{{${n}}}`}</span>
                  <input className="chip-input" value={f.exemplos[n - 1] || ''} placeholder={n === 1 ? 'Maria' : 'exemplo'}
                         onChange={(e) => { const ex = [...f.exemplos]; ex[n - 1] = e.target.value; set('exemplos', ex) }} /></label>
              ))}
            </div>
            <label><span className="iac-rot">Rodapé (opcional, até 60)</span>
              <input className="chip-input" value={f.rodape} onChange={(e) => set('rodape', e.target.value)} placeholder="Ex.: Equipe Hotline" /></label>
            <div>
              <span className="iac-rot">Botões</span>
              {f.botoes.map((b, i) => (
                <div key={i} className="iac-filtros" style={{ margin: '6px 0' }}>
                  <span className="iac-tag">{b.tipo === 'URL' ? 'Link' : b.tipo === 'PHONE_NUMBER' ? 'Telefone' : 'Resposta'}</span>
                  <input className="chip-input" style={{ flex: 1, minWidth: 140 }} value={b.texto} maxLength={25} placeholder="Texto do botão"
                         onChange={(e) => setBotao(i, 'texto', e.target.value)} />
                  {b.tipo === 'URL' && <input className="chip-input" style={{ flex: 2, minWidth: 180 }} value={b.url} placeholder="https://..."
                                              onChange={(e) => setBotao(i, 'url', e.target.value)} />}
                  {b.tipo === 'PHONE_NUMBER' && <input className="chip-input" style={{ flex: 1, minWidth: 150 }} value={b.telefone} placeholder="+5517..."
                                                       onChange={(e) => setBotao(i, 'telefone', e.target.value)} />}
                  <button className="iac-link" onClick={() => set('botoes', f.botoes.filter((_, j) => j !== i))}>remover</button>
                </div>
              ))}
              <div className="iac-filtros" style={{ margin: '6px 0 0' }}>
                <button className="reset-btn" onClick={() => set('botoes', [...f.botoes, { tipo: 'QUICK_REPLY', texto: '' }])}>+ Resposta rápida</button>
                <button className="reset-btn" onClick={() => set('botoes', [...f.botoes, { tipo: 'URL', texto: '', url: '' }])}>+ Link</button>
                <button className="reset-btn" onClick={() => set('botoes', [...f.botoes, { tipo: 'PHONE_NUMBER', texto: '', telefone: '' }])}>+ Telefone</button>
              </div>
            </div>
            {erros.length > 0 && (f.corpo || f.nome) && <ul className="tpl-erros">{erros.map((e) => <li key={e}>{e}</li>)}</ul>}
            <span className="iac-rascunho">
              <button className="chip-salvar iac-btn-p" onClick={enviar} disabled={enviando || erros.length > 0}>
                {enviando ? 'Enviando…' : 'Enviar para análise da Meta'}</button>
              <button className="reset-btn" onClick={() => { setF({ ...vazio(), contas: f.contas }); setResultados(null) }} disabled={enviando}>Limpar</button>
            </span>
            {resultados && (
              <ul className="tpl-lote-res">
                {resultados.map((r) => (
                  <li key={r.id} className={`st-${r.estado}`}>
                    <b>{r.estado === 'ok' ? '✓' : r.estado === 'erro' ? '✗' : r.estado === 'enviando' ? '…' : '·'}</b> {r.nome}
                    <small className="iac-miudo"> {r.estado === 'esperando' ? 'na fila' : r.estado === 'enviando' ? 'enviando' : r.motivo}{r.categoria ? ` · ${NOME_CAT[r.categoria] || r.categoria}` : ''}</small>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="tpl-previa">
            <Bolha titulo={conta ? `${conta.nome} · como o cliente vai receber` : 'Como o cliente vai receber'} cabecalho={f.cabTipo === 'TEXT' ? f.cabecalho : ''}
                   midia={ACEITA[f.cabTipo] ? (f.midia || { tipo: f.cabTipo }) : null} corpo={f.corpo} exemplos={f.exemplos} rodape={f.rodape} botoes={f.botoes} />
          </div>
        </div>
      </section>
    </>
  )
}

// ---------------------------------------------------------------- desempenho
function Desempenho({ uso, contas }) {
  const ds = (uso?.disparos || []).filter((u) => u.leads >= 50)
  const base = ds.filter((u) => u.leads >= 300)
  const melhor = (k) => [...base].sort((a, b) => pct(b[k], b.leads) - pct(a[k], a.leads))[0]
  const mi = melhor('interagiram'), mp = melhor('pagas')
  const pior = [...base].sort((a, b) => pct(a.interagiram, a.leads) - pct(b.interagiram, b.leads))[0]
  const existe = (nome) => contas.some((c) => c.templates.some((t) => t.name === nome))
  const max = Math.max(1, ...ds.map((u) => pct(u.interagiram, u.leads)))
  return (
    <>
      {base.length > 0 && (
        <div className="panel iac-bloco tpl-leitura-box">
          <b>O que os números dizem</b>
          <ul>
            {mi && <li><b>{mi.nome}</b> é o que mais faz o cliente responder: {fmtPct(pct(mi.interagiram, mi.leads))} de {num(mi.leads)} clientes.</li>}
            {mp && <li>Em pagamento, o melhor é <b>{mp.nome}</b>: {fmtPct(pct(mp.pagas, mp.leads))} dos clientes pagaram.</li>}
            {pior && pior !== mi && <li><b>{pior.nome}</b> tem a menor resposta ({fmtPct(pct(pior.interagiram, pior.leads))}): vale testar um texto novo no lugar.</li>}
            <li>Conta só o último template que cada cliente recebeu (tabela de disparos), nos últimos {uso.dias} dias.</li>
          </ul>
        </div>
      )}
      <section className="iac-bloco">
        <p className="section-label">Disparos por template · últimos {uso?.dias} dias</p>
        <div className="panel tpl-tabela">
          <div className="tpl-linha tpl-cab"><span>Template</span><span>Clientes</span><span>Interagiram</span><span>Proposta</span><span>Pagaram</span><span>Erros Meta</span></div>
          {ds.map((u) => (
            <div key={u.nome} className="tpl-linha">
              <span><b>{u.nome}</b>{!existe(u.nome) && <small className="iac-miudo" title="Não está nas contas listadas (ou é de SMS/e-mail)"> · fora das contas</small>}
                <small className="iac-miudo"> · {(u.canais || []).join(', ')}</small></span>
              <span>{num(u.leads)}</span>
              <span className="tpl-barra-c"><i style={{ width: `${(100 * pct(u.interagiram, u.leads)) / max}%` }} />{fmtPct(pct(u.interagiram, u.leads))}</span>
              <span>{fmtPct(pct(u.propostas, u.leads))}</span>
              <span className={u.pagas ? 'tpl-pago' : ''}>{fmtPct(pct(u.pagas, u.leads))} <small className="iac-miudo">({num(u.pagas)})</small></span>
              <span>{fmtPct(pct(u.erros, u.leads))}</span>
            </div>
          ))}
          {!ds.length && <p className="iac-miudo">Sem disparos com template no período.</p>}
        </div>
      </section>
      {(uso?.retomadas || []).length > 0 && (
        <section className="iac-bloco">
          <p className="section-label">Retomadas da IA</p>
          <div className="panel tpl-tabela">
            <div className="tpl-linha tpl-cab tpl-3"><span>Template</span><span>Enviados</span><span>Responderam</span></div>
            {uso.retomadas.map((r) => (
              <div key={r.nome} className="tpl-linha tpl-3"><span><b>{r.nome}</b></span><span>{num(r.enviados)}</span>
                <span>{num(r.responderam)} ({fmtPct(pct(r.responderam, r.enviados))})</span></div>
            ))}
          </div>
        </section>
      )}
      {(uso?.criados || []).length > 0 && (
        <section className="iac-bloco">
          <p className="section-label">Criados pelo Painel</p>
          <div className="panel">
            {uso.criados.map((c, i) => (
              <div key={i} className="iac-linha"><div className="iac-linha-txt"><b>{c.nome}</b>
                <small>{new Date(c.quando).toLocaleString('pt-BR')} · {c.usuario} · {contas.find((x) => x.id === c.waba)?.nome || c.waba}</small></div>
                <div className="iac-linha-ctl">{c.ok ? <span className="iac-tag">enviado</span> : <span className="tpl-erro">{c.erro || 'recusado'}</span>}</div></div>
            ))}
          </div>
        </section>
      )}
    </>
  )
}

// ---------------------------------------------------------------- tela
export default function SecaoTemplates({ token, api, dialogo, mostrar }) {
  const [aba, setAba] = useState('templates')
  const [dias, setDias] = useState(30)
  const [contasRaw, setContasRaw] = useState(null)
  const [uso, setUso] = useState(null)
  const [erro, setErro] = useState('')
  const [carregando, setCarregando] = useState(false)
  const [filtro, setFiltro] = useState({ conta: '', status: '', busca: '' })
  const [base, setBase] = useState(null)
  const [metricas, setMetricas] = useState({})

  const chamar = useCallback((meta) => api({ acao: 'meta', token, meta }), [api, token])
  // Dono, 01/10: voltar à tela não pode ficar carregando. Os dados ficam guardados (memória + localStorage) e só são
  // buscados de novo no ↻, ao criar um template ou quando um período ainda não foi buscado.
  const [quando, setQuando] = useState(null)
  const buscarUso = useCallback(async (d, forcar) => {
    const c = lerCache()
    if (!forcar && c.uso?.[d]) { setUso(c.uso[d]); return }
    const u = await api({ acao: 'meta_uso', token, dias: d })
    if (u.ok) { setUso(u); gravarCache({ uso: { ...(lerCache().uso || {}), [d]: u } }) }
  }, [api, token])
  // uma aba por BM (dono, 01/10): cada BM tem o seu token no n8n; contas guardadas por BM
  const [bms, setBms] = useState(() => lerCache().bms || null)
  const [bm, setBm] = useState(() => lerCache().bmAtual || 'hotline')
  const carregar = useCallback(async (forcar = true, qual = bm) => {
    const c = lerCache(), guardado = (c.porBm || {})[qual]
    if (!forcar && guardado) { setContasRaw(guardado.contas); setQuando(guardado.quando); return buscarUso(dias, false) }
    setCarregando(true); setErro(''); setContasRaw(guardado ? guardado.contas : null)
    const [l, lb] = await Promise.all([chamar({ acao: 'listar', bm: qual }), (forcar || !c.bms) ? chamar({ acao: 'bms' }) : null,
      forcar && gravarCache({ uso: {} }), buscarUso(dias, forcar)])
    setCarregando(false)
    if (lb && lb.ok) { setBms(lb.bms); gravarCache({ bms: lb.bms }) }
    if (l.ok) {
      setContasRaw(l.contas || []); const q = new Date().toISOString(); setQuando(q)
      gravarCache({ porBm: { ...(lerCache().porBm || {}), [qual]: { contas: l.contas || [], quando: q } } })
    } else setErro(l.motivo === 'sessao' ? 'Sessão expirada: entre de novo no Painel.' : l.motivo || 'Não foi possível falar com a Meta.')
  }, [chamar, buscarUso, dias, bm])
  useEffect(() => { carregar(false) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const trocarBm = (b) => {
    if (b === bm) return
    setBm(b); gravarCache({ bmAtual: b }); setFiltro({ conta: '', status: '', busca: '' }); setBase(null); setMetricas({}); setErro('')
    carregar(false, b)
  }
  useEffect(() => { if (contasRaw) buscarUso(dias, false) }, [dias]) // eslint-disable-line react-hooks/exhaustive-deps

  const contas = useMemo(() => (contasRaw || []).filter((c) => !c.erro).map((c) => {
    const n = c.phone_numbers?.data?.[0] || {}
    return { id: c.id, nome: c.name, numero: n.display_phone_number || '—', verificado: n.verified_name, qualidade: n.quality_rating,
      limite: n.messaging_limit_tier, templates: (c.message_templates?.data || []).map((t) => ({ ...t, waba: c.id })) }
  }), [contasRaw])
  const usoPorNome = useMemo(() => Object.fromEntries((uso?.disparos || []).map((u) => [u.nome, u])), [uso])
  const retPorNome = useMemo(() => Object.fromEntries((uso?.retomadas || []).map((u) => [u.nome, u])), [uso])

  const lista = useMemo(() => {
    const b = filtro.busca.toLowerCase()
    return contas.filter((c) => !filtro.conta || c.id === filtro.conta).flatMap((c) => c.templates.map((t) => ({ ...t, conta: c })))
      .filter((t) => !filtro.status || t.status === filtro.status)
      .filter((t) => !b || t.name.includes(b) || partes(t).corpo.toLowerCase().includes(b))
      .sort((a, b2) => (usoPorNome[b2.name]?.leads || 0) - (usoPorNome[a.name]?.leads || 0) || a.name.localeCompare(b2.name))
  }, [contas, filtro, usoPorNome])

  async function verMetricas(conta) {
    setMetricas((m) => ({ ...m, [conta.id]: 'carregando' }))
    const r = await chamar({ acao: 'metricas', waba: conta.id, dias, ids: conta.templates.filter((t) => t.status === 'APPROVED').map((t) => t.id) })
    if (!r.ok) { setMetricas((m) => ({ ...m, [conta.id]: null })); return mostrar(r.erro || r.motivo || 'A Meta não devolveu as métricas.', 'erro') }
    const soma = {}
    for (const p of r.dados) {
      const s = soma[p.template_id] || (soma[p.template_id] = { sent: 0, delivered: 0, read: 0, clicked: 0 })
      s.sent += p.sent || 0; s.delivered += p.delivered || 0; s.read += p.read || 0
      for (const c of p.clicked || []) s.clicked += c.count || 0
    }
    setMetricas((m) => ({ ...m, [conta.id]: soma }))
  }
  const [, setVersaoCache] = useState(0)
  const grupos = (bms || [{ id: bm, nome: 'Contas' }]).map((x) => {
    const lista = x.id === bm ? contasRaw : (lerCache().porBm || {})[x.id]?.contas
    return { id: x.id, nome: x.nome, contas: lista ? lista.filter((c) => !c.erro).map((c) => ({ id: c.id, nome: c.name, numero: c.phone_numbers?.data?.[0]?.display_phone_number || '—' })) : null }
  })
  async function carregarBm(qual) {
    const l = await chamar({ acao: 'listar', bm: qual })
    if (!l.ok) return mostrar(l.motivo || 'Não foi possível carregar as contas.', 'erro')
    gravarCache({ porBm: { ...(lerCache().porBm || {}), [qual]: { contas: l.contas || [], quando: new Date().toISOString() } } })
    setVersaoCache((v) => v + 1)
  }
  const usarComoBase = (t) => {
    const p = partes(t)
    setBase({ waba: t.waba, nome: `${t.name.replace(/_v\d+$/, '')}_v2`.slice(0, 60), categoria: t.category === 'UTILITY' ? 'UTILITY' : 'MARKETING',
      cabTipo: p.formato || (p.cabecalho ? 'TEXT' : 'NENHUM'), midia: null,
      cabecalho: p.cabecalho.startsWith('[') ? '' : p.cabecalho, corpo: p.corpo, exemplos: p.exemplos, rodape: p.rodape,
      botoes: p.botoes.map((b) => ({ tipo: b.type === 'URL' ? 'URL' : b.type === 'PHONE_NUMBER' ? 'PHONE_NUMBER' : 'QUICK_REPLY', texto: b.text || '', url: b.url || '', telefone: b.phone_number || '' })) })
    setAba('criar')
  }

  const totais = contas.reduce((s, c) => { for (const t of c.templates) s[t.status] = (s[t.status] || 0) + 1; return s }, {})
  return (
    <>
      <p className="iac-intro">
        Os templates de WhatsApp das contas da Meta, com o resultado de cada um nos nossos disparos e retomadas. Para criar,
        a IA sugere textos com base no que mais converte.
      </p>
      {bms && bms.length > 1 && (
        <div className="tpl-bms" role="tablist" aria-label="BMs da Meta">
          {bms.map((x) => (
            <button key={x.id} role="tab" aria-selected={bm === x.id} className={`tpl-bm ${bm === x.id ? 'on' : ''}`} onClick={() => trocarBm(x.id)}>
              {x.nome}<small>{x.contas} conta{x.contas === 1 ? '' : 's'}</small></button>
          ))}
        </div>
      )}
      <div className="iac-filtros">
        <div className="chip-opcoes">
          {[['templates', `Templates (${lista.length})`], ['desempenho', 'Desempenho'], ['criar', '+ Criar']].map(([k, t]) => (
            <button key={k} className={`chip-opcao ${aba === k ? 'on' : ''}`} onClick={() => setAba(k)}>{t}</button>
          ))}
        </div>
        <div className="chip-opcoes" style={{ marginLeft: 'auto' }}>
          {[7, 30, 90].map((d) => <button key={d} className={`chip-opcao ${dias === d ? 'on' : ''}`} onClick={() => setDias(d)}>{d} dias</button>)}
        </div>
        {quando && !carregando && <small className="iac-miudo" style={{ margin: 0 }}>atualizado às {new Date(quando).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</small>}
        <button className="refresh-btn" onClick={() => carregar(true)} disabled={carregando} title="Buscar de novo na Meta">{carregando ? 'atualizando…' : '↻ Atualizar'}</button>
      </div>
      {erro && <div className="state-msg error">{erro}</div>}
      {!contasRaw && !erro && <div className="state-msg">Buscando as contas na Meta…</div>}
      {(contasRaw || []).filter((c) => c.erro).map((c) => <p key={c.id} className="chip-erro">Conta {c.id}: {c.erro}</p>)}

      {contasRaw && aba === 'templates' && (
        <>
          <div className="tpl-contas">
            <button className={`tpl-conta ${!filtro.conta ? 'on' : ''}`} onClick={() => setFiltro({ ...filtro, conta: '' })}>
              <b>Todas</b><small>{contas.length} contas · {num(totais.APPROVED || 0)} aprovados{totais.REJECTED ? ` · ${totais.REJECTED} reprovados` : ''}</small></button>
            {contas.map((c) => (
              <button key={c.id} className={`tpl-conta ${filtro.conta === c.id ? 'on' : ''}`} onClick={() => setFiltro({ ...filtro, conta: c.id })}>
                <b><i className={`iac-dot ${COR_QUAL[c.qualidade] || ''}`} /> {c.nome}</b>
                <small>{c.numero} · qualidade {NOME_QUAL[c.qualidade] || '—'} · {c.templates.length} templates</small>
              </button>
            ))}
          </div>
          <div className="iac-filtros">
            <input className="chip-input iac-busca-local" value={filtro.busca} onChange={(e) => setFiltro({ ...filtro, busca: e.target.value })}
                   placeholder="Procurar pelo nome ou texto" />
            <div className="chip-opcoes">
              {[['', 'Todos'], ['APPROVED', 'Aprovados'], ['PENDING', 'Em análise'], ['REJECTED', 'Reprovados'], ['PAUSED', 'Pausados']].map(([k, t]) => (
                <button key={k} className={`chip-opcao ${filtro.status === k ? 'on' : ''}`} onClick={() => setFiltro({ ...filtro, status: k })}>{t}</button>
              ))}
            </div>
            {filtro.conta && (
              <button className="reset-btn" onClick={() => verMetricas(contas.find((c) => c.id === filtro.conta))}
                      disabled={metricas[filtro.conta] === 'carregando'}>
                {metricas[filtro.conta] === 'carregando' ? 'Buscando…' : 'Entregas e leituras (Meta)'}</button>
            )}
          </div>
          <div className="tpl-lista">
            {lista.map((t) => {
              const p = partes(t), u = usoPorNome[t.name], ret = retPorNome[t.name]
              const m = metricas[t.waba] && metricas[t.waba] !== 'carregando' ? metricas[t.waba][t.id] : null
              return (
                <div key={`${t.waba}-${t.id}`} className={`tpl-card st-${t.status}`}>
                  <div className="iac-banco-topo">
                    <b>{t.name}</b>
                    <span className="iac-tags">
                      <span className={`iac-tag tpl-st-${t.status}`}>{NOME_STATUS[t.status] || t.status}</span>
                      <span className="iac-tag">{NOME_CAT[t.category] || t.category}</span>
                      {t.quality_score?.score && t.quality_score.score !== 'UNKNOWN' && <span className="iac-tag">qualidade {NOME_QUAL[t.quality_score.score]}</span>}
                    </span>
                  </div>
                  <small className="iac-miudo" style={{ margin: 0 }}>{t.conta.nome} · {t.conta.numero} · {t.language}</small>
                  <Bolha cabecalho={p.cabecalho} corpo={p.corpo} exemplos={p.exemplos} rodape={p.rodape} botoes={p.botoes}
                         midia={p.formato ? { tipo: p.formato, url: p.formato === 'IMAGE' ? p.midiaUrl : null } : null} />
                  {t.status === 'REJECTED' && t.rejected_reason && t.rejected_reason !== 'NONE' && <small className="tpl-erro">Motivo da Meta: {t.rejected_reason}</small>}
                  <Taxas u={u} />
                  {ret && <small className="iac-miudo" style={{ margin: 0 }}>Retomadas da IA: {num(ret.enviados)} enviadas · {num(ret.responderam)} responderam</small>}
                  {m && (
                    <div className="tpl-taxas">
                      <span><b>{num(m.sent)}</b> enviadas</span><span><b>{fmtPct(pct(m.delivered, m.sent))}</b> entregues</span>
                      <span><b>{fmtPct(pct(m.read, m.delivered))}</b> lidas</span>{m.clicked > 0 && <span><b>{num(m.clicked)}</b> cliques</span>}
                    </div>
                  )}
                  <div className="iac-banco-acoes"><button className="iac-link" onClick={() => usarComoBase(t)}>Usar como base</button></div>
                </div>
              )
            })}
            {!lista.length && <p className="iac-miudo">Nenhum template com esses filtros.</p>}
          </div>
        </>
      )}
      {contasRaw && aba === 'desempenho' && (uso ? <Desempenho uso={uso} contas={contas} /> : <div className="state-msg">Carregando…</div>)}
      {contasRaw && aba === 'criar' && (contas.length
        ? <Criar key={bm} bm={bm} contas={contas} grupos={grupos} carregarBm={carregarBm} uso={uso} inicial={base} chamar={chamar} dialogo={dialogo} mostrar={mostrar} onCriado={() => { setBase(null); carregar() }} />
        : <p className="iac-miudo">Nenhuma conta da Meta disponível.</p>)}
    </>
  )
}
