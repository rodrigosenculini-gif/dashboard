import { useCallback, useEffect, useMemo, useState } from 'react'

// Esteira do Presenca. Fica junto dos outros bancos e usa a MESMA casca deles
// (funil-overlay / funil-panel / funil-header, add-venda-form, template-row),
// nao a do Refin.
//
// Duas coisas distintas convivem numa linha:
//   status_nome    = situacao da operacao (ex.: 'Analise mesa')
//   pendencia_nome = pendencia aberta dentro dela (ex.: 'REANALISE MESA')
// Existe operacao em 'Analise mesa' sem pendencia nenhuma, por isso sao separados.

export async function apiPresenca(type, body, params = '') {
  const url = `/api/presenca?type=${type}${params}`
  const res = await fetch(url, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.erro || `falha (${res.status})`)
  return data
}

export const brlP = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }))
const dataBr = (d) => (d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—')

export function tempoNaSituacao(min) {
  const m = Number(min || 0)
  if (m < 60) return `${m} min`
  if (m < 60 * 24) return `${Math.floor(m / 60)}h ${m % 60}min`
  const d = Math.floor(m / (60 * 24))
  return `${d}d ${Math.floor((m % (60 * 24)) / 60)}h`
}

// mesmo criterio da tela de vendedoras: sem conversa_sistema, cai no CRM VendeAI
export function linkConversa(item) {
  if (!item || !item.covnersation_id) return null
  return item.conversa_sistema === 'chatwoot'
    ? `https://chatwoot.querosacarfgts.com.br/app/accounts/1/conversations/${item.covnersation_id}`
    : `https://crm.vendeaitecnologia.com.br/app/accounts/75/conversations/${item.covnersation_id}`
}

export const FAIXAS_P = {
  conta:           { rotulo: 'Dados bancários', cor: '#e24b4a' },
  pagamento:       { rotulo: 'Revisão de pagamento', cor: '#e24b4a' },
  averbacao_falha: { rotulo: 'Falha na averbação', cor: '#ba7517' },
  pendencia:       { rotulo: 'Pendência', cor: '#ba7517' },
  analise:         { rotulo: 'Em análise', cor: '#378add' },
  assinatura:      { rotulo: 'Aguardando assinatura', cor: '#378add' },
  averbacao:       { rotulo: 'Aguardando averbação', cor: '#888780' },
  outro:           { rotulo: 'Outro', cor: '#888780' },
}

export function LinkConversa({ item }) {
  const href = linkConversa(item)
  if (!href) return <span className='kpi-sub'>—</span>
  return <a href={href} target='_blank' rel='noopener noreferrer' className='conversa-link'>Abrir &#8599;</a>
}

function BotaoCopiar({ texto }) {
  const [ok, setOk] = useState(false)
  if (!texto) return null
  return (
    <button type='button' className='reset-btn' onClick={async () => {
      try { await navigator.clipboard.writeText(texto) } catch { /* sem permissao */ }
      setOk(true); setTimeout(() => setOk(false), 1800)
    }}>{ok ? 'copiado' : 'copiar link'}</button>
  )
}

export default function PresencaEsteiraModal({ vendedor = null, modo = 'vendedora', onClose }) {
  const geral = modo === 'geral'
  const [itens, setItens] = useState([])
  const [cat, setCat] = useState({ motivos: [], tipos: [] })
  const [vends, setVends] = useState([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState('')
  const [msg, setMsg] = useState('')
  const [busca, setBusca] = useState('')
  const [faixa, setFaixa] = useState('todas')
  const [soTrat, setSoTrat] = useState(false)
  const [sel, setSel] = useState(null)
  const [abaInicial, setAbaInicial] = useState(null)

  const carregar = useCallback(async () => {
    setLoading(true); setErro('')
    try {
      let p = ''
      if (!geral && vendedor) p += `&vendedor=${encodeURIComponent(vendedor)}`
      if (faixa !== 'todas') p += `&faixa=${encodeURIComponent(faixa)}`
      if (soTrat) p += '&tratavel=1'
      const d = await apiPresenca('esteira', null, p)
      setItens(d.itens || [])
    } catch (e) { setErro(e.message) } finally { setLoading(false) }
  }, [geral, vendedor, faixa, soTrat])

  useEffect(() => { carregar() }, [carregar])
  useEffect(() => { apiPresenca('catalogos').then(setCat).catch(() => {}) }, [])
  useEffect(() => {
    if (!geral) return
    apiPresenca('vendedores').then((d) => setVends(d.vendedores || [])).catch(() => {})
  }, [geral])

  const lista = useMemo(() => {
    const b = busca.trim().toLowerCase()
    if (!b) return itens
    return itens.filter((i) =>
      String(i.nome || '').toLowerCase().includes(b) ||
      String(i.cpf || '').includes(b.replace(/\D/g, '')) ||
      String(i.operacao_id).includes(b))
  }, [itens, busca])

  const kpis = useMemo(() => {
    const trat = itens.filter((i) => i.tratavel)
    return {
      total: itens.length,
      trataveis: trat.length,
      semDono: itens.filter((i) => i.tratavel && !i.vendedor).length,
      valor: trat.reduce((s, i) => s + Number(i.valor_liberado || 0), 0),
    }
  }, [itens])

  async function atribuir(op, quem) {
    setMsg(''); setErro('')
    try {
      await apiPresenca('atribuir', { operacao: op, vendedor: quem, modo, solicitante: vendedor || 'geral' })
      setMsg(quem ? `Atribuída a ${quem}.` : 'Atribuição removida.')
      carregar()
    } catch (e) { setErro(e.message) }
  }

  const COLS = geral
    ? '1.5fr 0.7fr 1fr 0.9fr 0.8fr 0.6fr 0.7fr 1fr 0.8fr'
    : '1.5fr 0.7fr 1fr 0.9fr 0.8fr 0.6fr 0.7fr 0.8fr'

  return (
    <div className='funil-overlay' onClick={onClose}>
      <div className='funil-panel' onClick={(e) => e.stopPropagation()} style={{ maxWidth: 1120 }}>
        <div className='funil-header'>
          <div>
            <h2>Presença — {geral ? 'esteira' : 'minhas pendências'}</h2>
            <span className='kpi-sub'>
              {geral
                ? 'Operações que ainda não pagaram. Atribua uma responsável para aparecer no portal dela.'
                : 'Operações atribuídas a você que precisam de tratamento.'}
            </span>
          </div>
          <button className='funil-close' onClick={onClose}>&times;</button>
        </div>

        <div className='template-row' style={{ gridTemplateColumns: 'repeat(4, 1fr)', border: 0 }}>
          <span><span className='kpi-label'>Na esteira</span><span className='kpi-value'>{kpis.total}</span></span>
          <span><span className='kpi-label'>Tratáveis</span><span className='kpi-value'>{kpis.trataveis}</span></span>
          <span><span className='kpi-label'>Sem responsável</span><span className='kpi-value'>{kpis.semDono}</span></span>
          <span><span className='kpi-label'>Valor tratável</span><span className='kpi-value'>{brlP(kpis.valor)}</span></span>
        </div>

        <div className='add-venda-form' style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input placeholder='nome, CPF ou adesão' value={busca} style={{ maxWidth: 220 }}
            onChange={(e) => setBusca(e.target.value)} />
          <select value={faixa} onChange={(e) => setFaixa(e.target.value)} style={{ maxWidth: 200 }}>
            <option value='todas'>Todas as situações</option>
            {Object.entries(FAIXAS_P).map(([k, v]) => <option key={k} value={k}>{v.rotulo}</option>)}
          </select>
          <label className='kpi-sub' style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type='checkbox' checked={soTrat} onChange={(e) => setSoTrat(e.target.checked)} />
            só tratáveis
          </label>
          <button type='button' className='refresh-btn' onClick={carregar}>Atualizar</button>
        </div>

        {erro && <div className='state-msg'>{erro}</div>}
        {msg && <div className='state-msg'>{msg}</div>}
        {loading && <div className='state-msg'>Carregando…</div>}
        {!loading && !lista.length && <div className='state-msg'>Nada na esteira agora.</div>}

        {!loading && !!lista.length && (
          <div className='panel table-panel'>
            <div className='template-row head' style={{ gridTemplateColumns: COLS }}>
              <span>Cliente</span><span>Adesão</span><span>Situação</span><span>Pendência</span>
              <span>Valor</span><span>Parada há</span><span>Conversa</span>
              {geral && <span>Responsável</span>}
              <span></span>
            </div>
            {lista.map((i) => {
              const f = FAIXAS_P[i.faixa] || FAIXAS_P.outro
              return (
                <div className='template-row' key={i.operacao_id} style={{ gridTemplateColumns: COLS }}>
                  <span className='campanha-nome' title={i.cpf || ''}>{i.nome || '—'}</span>
                  <span>{i.operacao_id}</span>
                  <span style={{ color: f.cor }}>{f.rotulo}</span>
                  <span className='kpi-sub'>{i.pendencia_nome || '—'}</span>
                  <span>{brlP(i.valor_liberado)}</span>
                  <span>{tempoNaSituacao(i.minutos_na_situacao)}</span>
                  <span><LinkConversa item={i} /></span>
                  {geral && (
                    <span>
                      <select value={i.vendedor || ''} onChange={(e) => atribuir(i.operacao_id, e.target.value)}>
                        <option value=''>ninguém</option>
                        {vends.map((v) => <option key={v} value={v}>{v}</option>)}
                        {i.vendedor && !vends.includes(i.vendedor) && <option value={i.vendedor}>{i.vendedor}</option>}
                      </select>
                    </span>
                  )}
                  <span>
                    {i.tratavel && (
                      <button type='button' className='reset-btn'
                        onClick={() => { setAbaInicial(i.pode_reapresentar ? 'conta' : 'documento'); setSel(i) }}>
                        {i.pode_reapresentar ? 'ajustar conta' : 'enviar doc'}
                      </button>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {sel && (
          <PresencaDetalhe item={sel} cat={cat} geral={geral} vendedor={vendedor} modo={modo}
            abaInicial={abaInicial} onClose={() => setSel(null)}
            onFeito={(t) => { setMsg(t); setSel(null); carregar() }} />
        )}
      </div>
    </div>
  )
}

function PresencaDetalhe({ item, cat, geral, vendedor, modo, abaInicial, onClose, onFeito }) {
  const [aba, setAba] = useState(abaInicial || (item.pode_reapresentar ? 'conta' : 'documento'))
  const [erro, setErro] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const [conta, setConta] = useState({ banco: '', agencia: '', conta: '', digitoConta: '', tipoConta: '' })
  const [docTipo, setDocTipo] = useState('')
  const [arquivo, setArquivo] = useState(null)
  const [motivo, setMotivo] = useState('')

  async function enviar(corpo, confirmacao) {
    if (confirmacao && !window.confirm(confirmacao)) return
    setErro(''); setOcupado(true)
    try {
      const r = await apiPresenca('acao', Object.assign({ modo, solicitante: vendedor || 'geral' }, corpo))
      if (r.ok === false) throw new Error(r.erro || 'o banco recusou a operação')
      onFeito('Enviado ao Presença.')
    } catch (e) { setErro(e.message) } finally { setOcupado(false) }
  }

  function lerArquivo(fl) {
    return new Promise((ok, nok) => {
      const r = new FileReader()
      r.onload = () => ok(String(r.result).split(',')[1])
      r.onerror = () => nok(new Error('não consegui ler o arquivo'))
      r.readAsDataURL(fl)
    })
  }

  async function enviarDoc() {
    if (!docTipo) return setErro('escolha o tipo do documento')
    if (!arquivo) return setErro('escolha um arquivo')
    try {
      const base64 = await lerArquivo(arquivo)
      await enviar({ acao: 'upload', operacaoId: item.operacao_id,
        documentos: [{ base64, name: arquivo.name, tipoDocumentoId: Number(docTipo) }] })
    } catch (e) { setErro(e.message) }
  }

  return (
    <div className='funil-overlay' onClick={onClose}>
      <div className='funil-panel' onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className='funil-header'>
          <div>
            <h2>{item.nome || 'adesão ' + item.operacao_id}</h2>
            <span className='kpi-sub'>
              adesão {item.operacao_id} · {brlP(item.valor_liberado)} · {item.status_nome}
              {item.pendencia_nome ? ` · pendência: ${item.pendencia_nome}` : ''}
              {' · parada há '}{tempoNaSituacao(item.minutos_na_situacao)}
            </span>
          </div>
          <button className='funil-close' onClick={onClose}>&times;</button>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '0 4px 8px' }}>
          <button type='button' className={aba === 'conta' ? 'refresh-btn' : 'reset-btn'} onClick={() => setAba('conta')}>Conta</button>
          <button type='button' className={aba === 'documento' ? 'refresh-btn' : 'reset-btn'} onClick={() => setAba('documento')}>Documento</button>
          {geral && <button type='button' className={aba === 'cancelar' ? 'refresh-btn' : 'reset-btn'} onClick={() => setAba('cancelar')}>Cancelar</button>}
          <LinkConversa item={item} />
          <BotaoCopiar texto={item.link_formalizacao} />
        </div>

        {erro && <div className='state-msg'>{erro}</div>}

        {aba === 'conta' && (
          <form className='add-venda-form' onSubmit={(e) => { e.preventDefault()
            enviar({ acao: 'reapresentar', operacaoId: item.operacao_id, ...conta },
              'Reapresentar o pagamento com esta conta? Isso reenvia o desembolso no banco.') }}>
            <label>Banco<input required value={conta.banco} placeholder='104'
              onChange={(e) => setConta({ ...conta, banco: e.target.value })} /></label>
            <label>Agência<input required value={conta.agencia} placeholder='0809'
              onChange={(e) => setConta({ ...conta, agencia: e.target.value })} /></label>
            <label>Conta<input required value={conta.conta}
              onChange={(e) => setConta({ ...conta, conta: e.target.value })} /></label>
            <label>Dígito<input required value={conta.digitoConta}
              onChange={(e) => setConta({ ...conta, digitoConta: e.target.value })} /></label>
            <label>Tipo de conta<input required value={conta.tipoConta} placeholder='corrente / poupança'
              onChange={(e) => setConta({ ...conta, tipoConta: e.target.value })} /></label>
            <button type='submit' className='refresh-btn' disabled={ocupado}>
              {ocupado ? 'enviando…' : 'reapresentar pagamento'}</button>
          </form>
        )}

        {aba === 'documento' && (
          <form className='add-venda-form' onSubmit={(e) => { e.preventDefault(); enviarDoc() }}>
            <label>Tipo do documento
              <select value={docTipo} onChange={(e) => setDocTipo(e.target.value)}>
                <option value=''>escolha…</option>
                {(cat.tipos || []).map((t) => <option key={t.tipo_id} value={t.tipo_id}>{t.nome}</option>)}
              </select>
            </label>
            <label>Arquivo
              <input type='file' onChange={(e) => setArquivo(e.target.files ? e.target.files[0] : null)} /></label>
            <button type='submit' className='refresh-btn' disabled={ocupado}>
              {ocupado ? 'enviando…' : 'enviar documento'}</button>
          </form>
        )}

        {aba === 'cancelar' && geral && (
          <form className='add-venda-form' onSubmit={(e) => { e.preventDefault()
            enviar({ acao: 'cancelar', operacaoId: item.operacao_id, motivoId: Number(motivo) },
              'Cancelar esta operação no Presença? Não tem volta.') }}>
            <label>Motivo
              <select required value={motivo} onChange={(e) => setMotivo(e.target.value)}>
                <option value=''>escolha…</option>
                {(cat.motivos || []).map((m) => <option key={m.motivo_id} value={m.motivo_id}>{m.nome}</option>)}
              </select>
            </label>
            <button type='submit' className='refresh-btn' disabled={ocupado || !motivo}>
              {ocupado ? 'enviando…' : 'cancelar operação'}</button>
          </form>
        )}
      </div>
    </div>
  )
}
