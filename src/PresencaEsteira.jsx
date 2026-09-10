import { useCallback, useEffect, useMemo, useState } from 'react'

// Esteira do Presenca. Mostra as operacoes que nao estao pagas nem canceladas,
// com destaque para as tratáveis (conta bancaria, documento, pagamento).
// Na visao geral da para atribuir um responsavel; atribuida, a operacao aparece
// para a vendedora no portal restrito, que so age no que e dela.

async function api(type, body, params = '') {
  const url = `/api/presenca?type=${type}${params}`
  const res = await fetch(url, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.erro || `falha (${res.status})`)
  return data
}

const brl = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }))
const dataBr = (d) => (d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—')

const FAIXAS = {
  conta:           { rotulo: 'Dados bancários', cor: '#e24b4a' },
  pagamento:       { rotulo: 'Revisão de pagamento', cor: '#e24b4a' },
  averbacao_falha: { rotulo: 'Falha na averbação', cor: '#ba7517' },
  pendencia:       { rotulo: 'Pendência', cor: '#ba7517' },
  analise:         { rotulo: 'Em análise', cor: '#378add' },
  assinatura:      { rotulo: 'Aguardando assinatura', cor: '#378add' },
  averbacao:       { rotulo: 'Aguardando averbação', cor: '#888780' },
  outro:           { rotulo: 'Outro', cor: '#888780' },
}

function IconePresenca({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8'>
      <path d='M3 7h18M3 12h18M3 17h10' strokeLinecap='round' />
      <circle cx='18.5' cy='17' r='3.2' />
    </svg>
  )
}

export default function PresencaButton({ vendedor = null, modo = 'vendedora' }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className='reset-btn nuvem-trigger' onClick={() => setOpen(true)} title='Esteira do Presença'>
        <IconePresenca />
        <span>Presença</span>
      </button>
      {open && <PresencaModal vendedor={vendedor} modo={modo} onClose={() => setOpen(false)} />}
    </>
  )
}

function PresencaModal({ vendedor, modo, onClose }) {
  const geral = modo === 'geral'
  const [itens, setItens] = useState([])
  const [cat, setCat] = useState({ motivos: [], tipos: [] })
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState('')
  const [msg, setMsg] = useState('')
  const [busca, setBusca] = useState('')
  const [faixa, setFaixa] = useState('todas')
  const [soPend, setSoPend] = useState(false)
  const [sel, setSel] = useState(null)

  const carregar = useCallback(async () => {
    setLoading(true); setErro('')
    try {
      let p = ''
      if (!geral && vendedor) p += `&vendedor=${encodeURIComponent(vendedor)}`
      if (faixa !== 'todas') p += `&faixa=${encodeURIComponent(faixa)}`
      if (soPend) p += '&pendencia=1'
      const d = await api('esteira', null, p)
      setItens(d.itens || [])
    } catch (e) { setErro(e.message) } finally { setLoading(false) }
  }, [geral, vendedor, faixa, soPend])

  useEffect(() => { carregar() }, [carregar])
  useEffect(() => { api('catalogos').then(setCat).catch(() => {}) }, [])

  const lista = useMemo(() => {
    const b = busca.trim().toLowerCase()
    if (!b) return itens
    return itens.filter((i) =>
      String(i.nome || '').toLowerCase().includes(b) ||
      String(i.cpf || '').includes(b.replace(/\D/g, '')) ||
      String(i.operacao_id).includes(b))
  }, [itens, busca])

  const kpis = useMemo(() => {
    const t = itens.length
    const pend = itens.filter((i) => i.tem_pendencia).length
    const trat = itens.filter((i) => i.pode_reapresentar || i.pode_documento).length
    const val = itens.reduce((s, i) => s + Number(i.valor_liberado || 0), 0)
    return { t, pend, trat, val }
  }, [itens])

  async function atribuir(op, quem) {
    setMsg('')
    try {
      await api('atribuir', { operacao: op, vendedor: quem, modo, solicitante: vendedor || 'geral' })
      setMsg(quem ? `Atribuída a ${quem}.` : 'Atribuição removida.')
      carregar()
    } catch (e) { setErro(e.message) }
  }

  return (
    <div className='ai-chat-overlay' onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className='ai-chat-sheet nuvem-sheet refin-sheet'>
        <div className='ai-chat-gradient' />

        <div className='ai-chat-header'>
          <div>
            <div className='ai-chat-title'>
              Presença — {geral ? 'esteira geral' : vendedor || 'minhas pendências'}
            </div>
            <div className='ai-chat-subtitle'>
              {geral
                ? 'Operações que ainda não pagaram. Atribua um responsável para que apareça no portal dela.'
                : 'Operações atribuídas a você que precisam de tratamento.'}
            </div>
          </div>
          <button className='ai-chat-close' onClick={onClose}>×</button>
        </div>

        <div className='refin-body'>
          <div className='refin-kpis'>
            <div className='ia-kpi'><span>Na esteira</span><strong>{kpis.t}</strong></div>
            <div className='ia-kpi'><span>Com pendência</span><strong>{kpis.pend}</strong></div>
            <div className='ia-kpi'><span>Tratáveis</span><strong>{kpis.trat}</strong></div>
            <div className='ia-kpi'><span>Valor</span><strong>{brl(kpis.val)}</strong></div>
          </div>

          <div className='refin-toolbar'>
            <input className='nuvem-busca' placeholder='nome, CPF ou operação' value={busca}
              onChange={(e) => setBusca(e.target.value)} />
            <select value={faixa} onChange={(e) => setFaixa(e.target.value)}>
              <option value='todas'>Todas as situações</option>
              {Object.entries(FAIXAS).map(([k, v]) => (
                <option key={k} value={k}>{v.rotulo}</option>
              ))}
            </select>
            <label className='refin-toggle'>
              <input type='checkbox' checked={soPend} onChange={(e) => setSoPend(e.target.checked)} />
              <span>só com pendência</span>
            </label>
            <button className='refresh-btn' onClick={carregar}>Atualizar</button>
          </div>

          {erro && <div className='state-msg error'>{erro}</div>}
          {msg && <div className='state-msg'>{msg}</div>}
          {loading && <div className='state-msg'>Carregando…</div>}

          {!loading && !lista.length && <div className='ia-vazio'>Nada na esteira agora.</div>}

          {!loading && !!lista.length && (
            <div className='refin-tabela-wrap'>
              <table className='ia-tabela refin-tabela'>
                <thead>
                  <tr>
                    <th>Cliente</th><th>Operação</th><th>Situação</th>
                    <th>Valor</th><th>Data</th>
                    {geral && <th>Responsável</th>}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {lista.map((i) => {
                    const f = FAIXAS[i.faixa] || FAIXAS.outro
                    return (
                      <tr key={i.operacao_id}>
                        <td>
                          <div>{i.nome || '—'}</div>
                          <div className='refin-dim refin-mono'>{i.cpf || ''}</div>
                        </td>
                        <td className='refin-mono'>{i.operacao_id}</td>
                        <td>
                          <span className='ia-tag' style={{ borderColor: f.cor, color: f.cor }}>{f.rotulo}</span>
                          {i.pendencia_nome && <div className='refin-dim'>{i.pendencia_nome}</div>}
                        </td>
                        <td>{brl(i.valor_liberado)}</td>
                        <td>{dataBr(i.data_operacao)}</td>
                        {geral && (
                          <td>
                            <input defaultValue={i.vendedor || ''} placeholder='ninguém'
                              style={{ width: 130 }}
                              onBlur={(e) => {
                                const v = e.target.value.trim()
                                if (v !== (i.vendedor || '')) atribuir(i.operacao_id, v)
                              }} />
                          </td>
                        )}
                        <td className='ia-td-acao'>
                          <button className='reset-btn' onClick={() => setSel(i)}>abrir</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {sel && (
          <PresencaDetalhe item={sel} cat={cat} geral={geral} vendedor={vendedor} modo={modo}
            onClose={() => setSel(null)}
            onFeito={(t) => { setMsg(t); setSel(null); carregar() }} />
        )}
      </div>
    </div>
  )
}

function PresencaDetalhe({ item, cat, geral, vendedor, modo, onClose, onFeito }) {
  const [aba, setAba] = useState(item.pode_reapresentar ? 'conta' : 'documento')
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
      const r = await api('acao', Object.assign({ modo, solicitante: vendedor || 'geral' }, corpo))
      if (r.ok === false) throw new Error(r.erro || 'o banco recusou a operação')
      onFeito('Enviado ao Presença.')
    } catch (e) { setErro(e.message) } finally { setOcupado(false) }
  }

  function lerArquivo(f) {
    return new Promise((ok, nok) => {
      const r = new FileReader()
      r.onload = () => ok(String(r.result).split(',')[1])
      r.onerror = () => nok(new Error('não consegui ler o arquivo'))
      r.readAsDataURL(f)
    })
  }

  async function enviarDoc() {
    if (!arquivo) return setErro('escolha um arquivo')
    if (!docTipo) return setErro('escolha o tipo do documento')
    try {
      const base64 = await lerArquivo(arquivo)
      await enviar({ acao: 'upload', operacaoId: item.operacao_id,
        documentos: [{ base64, name: arquivo.name, tipoDocumentoId: Number(docTipo) }] })
    } catch (e) { setErro(e.message) }
  }

  return (
    <div className='refin-detalhe'>
      <div className='ai-chat-header'>
        <div>
          <div className='ai-chat-title'>{item.nome || 'operação ' + item.operacao_id}</div>
          <div className='ai-chat-subtitle'>
            {item.status_nome} · {brl(item.valor_liberado)} · operação {item.operacao_id}
          </div>
        </div>
        <button className='ai-chat-close' onClick={onClose}>×</button>
      </div>

      {item.link_formalizacao && (
        <div className='refin-linha'>
          <a href={item.link_formalizacao} target='_blank' rel='noreferrer'>abrir link de formalização</a>
        </div>
      )}

      <div className='refin-status-btns'>
        <button className={aba === 'conta' ? 'refin-pago' : 'reset-btn'} onClick={() => setAba('conta')}>Conta</button>
        <button className={aba === 'documento' ? 'refin-pago' : 'reset-btn'} onClick={() => setAba('documento')}>Documento</button>
        {geral && <button className={aba === 'cancelar' ? 'refin-pago' : 'reset-btn'} onClick={() => setAba('cancelar')}>Cancelar</button>}
      </div>

      {erro && <div className='state-msg error'>{erro}</div>}

      {aba === 'conta' && (
        <div className='refin-grid'>
          <div className='refin-campo'><label>Banco</label>
            <input value={conta.banco} onChange={(e) => setConta({ ...conta, banco: e.target.value })} placeholder='104' /></div>
          <div className='refin-campo'><label>Agência</label>
            <input value={conta.agencia} onChange={(e) => setConta({ ...conta, agencia: e.target.value })} placeholder='0809' /></div>
          <div className='refin-campo'><label>Conta</label>
            <input value={conta.conta} onChange={(e) => setConta({ ...conta, conta: e.target.value })} /></div>
          <div className='refin-campo'><label>Dígito</label>
            <input value={conta.digitoConta} onChange={(e) => setConta({ ...conta, digitoConta: e.target.value })} /></div>
          <div className='refin-campo'><label>Tipo</label>
            <input value={conta.tipoConta} onChange={(e) => setConta({ ...conta, tipoConta: e.target.value })} placeholder='corrente / poupança' /></div>
          <div className='refin-acoes-lead'>
            <button className='reset-btn' disabled={ocupado}
              onClick={() => enviar({ acao: 'reapresentar', operacaoId: item.operacao_id, ...conta },
                'Reapresentar o pagamento com esta conta? Isso reenvia o desembolso no banco.')}>
              {ocupado ? 'enviando…' : 'reapresentar pagamento'}
            </button>
          </div>
        </div>
      )}

      {aba === 'documento' && (
        <div className='refin-grid'>
          <div className='refin-campo'><label>Tipo do documento</label>
            <select value={docTipo} onChange={(e) => setDocTipo(e.target.value)}>
              <option value=''>escolha…</option>
              {(cat.tipos || []).map((t) => <option key={t.tipo_id} value={t.tipo_id}>{t.nome}</option>)}
            </select>
          </div>
          <div className='refin-campo'><label>Arquivo</label>
            <input type='file' onChange={(e) => setArquivo(e.target.files ? e.target.files[0] : null)} /></div>
          <div className='refin-acoes-lead'>
            <button className='reset-btn' disabled={ocupado} onClick={enviarDoc}>
              {ocupado ? 'enviando…' : 'enviar documento'}
            </button>
          </div>
        </div>
      )}

      {aba === 'cancelar' && geral && (
        <div className='refin-grid'>
          <div className='refin-campo'><label>Motivo</label>
            <select value={motivo} onChange={(e) => setMotivo(e.target.value)}>
              <option value=''>escolha…</option>
              {(cat.motivos || []).map((m) => <option key={m.motivo_id} value={m.motivo_id}>{m.nome}</option>)}
            </select>
          </div>
          <div className='refin-acoes-lead'>
            <button className='reset-btn' disabled={ocupado || !motivo}
              onClick={() => enviar({ acao: 'cancelar', operacaoId: item.operacao_id, motivoId: Number(motivo) },
                'Cancelar esta operação no Presença? Não tem volta.')}>
              {ocupado ? 'enviando…' : 'cancelar operação'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
