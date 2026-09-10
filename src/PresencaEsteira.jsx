import { useCallback, useEffect, useMemo, useState } from 'react'

// Esteira do Presenca. Fica junto dos outros bancos (Novo Saque, PAN, C6, Soma),
// nao junto do Refin: e a tela unica do banco, e a simulacao entra aqui dentro.
//
// Duas coisas diferentes convivem numa linha e nao podem ser confundidas:
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

// tempo na situacao: minutos ate 1h, depois horas, depois dias
export function tempoNaSituacao(min) {
  const m = Number(min || 0)
  if (m < 60) return `${m} min`
  if (m < 60 * 24) return `${Math.floor(m / 60)}h ${m % 60}min`
  const d = Math.floor(m / (60 * 24))
  return `${d}d ${Math.floor((m % (60 * 24)) / 60)}h`
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

function BotaoCopiar({ texto, rotulo = 'copiar link' }) {
  const [ok, setOk] = useState(false)
  if (!texto) return null
  return (
    <button className='reset-btn' onClick={async () => {
      try { await navigator.clipboard.writeText(texto) } catch { /* sem permissao */ }
      setOk(true); setTimeout(() => setOk(false), 1800)
    }}>{ok ? 'copiado ✓' : rotulo}</button>
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

  function abrirEm(item, aba) { setAbaInicial(aba); setSel(item) }

  return (
    <div className='ai-chat-overlay' onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className='ai-chat-sheet nuvem-sheet refin-sheet'>
        <div className='ai-chat-gradient' />

        <div className='ai-chat-header'>
          <div>
            <div className='ai-chat-title'>
              Presença — {geral ? 'esteira' : vendedor || 'minhas pendências'}
            </div>
            <div className='ai-chat-subtitle'>
              {geral
                ? 'Operações que ainda não pagaram. Atribua uma responsável para que apareça no portal dela.'
                : 'Operações atribuídas a você que precisam de tratamento.'}
            </div>
          </div>
          <button className='ai-chat-close' onClick={onClose}>×</button>
        </div>

        <div className='refin-body'>
          <div className='refin-kpis'>
            <div className='ia-kpi'><span>Na esteira</span><strong>{kpis.total}</strong></div>
            <div className='ia-kpi'><span>Tratáveis</span><strong>{kpis.trataveis}</strong></div>
            {geral && <div className='ia-kpi'><span>Sem responsável</span><strong>{kpis.semDono}</strong></div>}
            <div className='ia-kpi'><span>Valor tratável</span><strong>{brlP(kpis.valor)}</strong></div>
          </div>

          <div className='refin-toolbar'>
            <input className='nuvem-busca' placeholder='nome, CPF ou adesão' value={busca}
              onChange={(e) => setBusca(e.target.value)} />
            <select className='nuvem-busca' style={{ maxWidth: 210 }} value={faixa}
              onChange={(e) => setFaixa(e.target.value)}>
              <option value='todas'>Todas as situações</option>
              {Object.entries(FAIXAS_P).map(([k, v]) => (
                <option key={k} value={k}>{v.rotulo}</option>
              ))}
            </select>
            <label className='refin-toggle'>
              <input type='checkbox' checked={soTrat} onChange={(e) => setSoTrat(e.target.checked)} />
              <span>só tratáveis</span>
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
                    <th>Cliente</th><th>Adesão</th><th>Situação</th><th>Pendência</th>
                    <th>Valor</th><th>Parada há</th><th>Data</th>
                    {geral && <th>Responsável</th>}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {lista.map((i) => {
                    const f = FAIXAS_P[i.faixa] || FAIXAS_P.outro
                    return (
                      <tr key={i.operacao_id}>
                        <td>
                          <div>{i.nome || '—'}</div>
                          <div className='refin-dim refin-mono'>{i.cpf || ''}</div>
                        </td>
                        <td className='refin-mono'>{i.operacao_id}</td>
                        <td><span className='ia-tag' style={{ borderColor: f.cor, color: f.cor }}>{f.rotulo}</span></td>
                        <td>
                          {i.pendencia_nome
                            ? <span className='ia-tag' style={{ borderColor: '#ba7517', color: '#ba7517' }}>{i.pendencia_nome}</span>
                            : <span className='refin-dim'>—</span>}
                        </td>
                        <td>{brlP(i.valor_liberado)}</td>
                        <td className='refin-mono'>{tempoNaSituacao(i.minutos_na_situacao)}</td>
                        <td>{dataBr(i.data_operacao)}</td>
                        {geral && (
                          <td>
                            <select className='nuvem-busca' style={{ minWidth: 150 }}
                              value={i.vendedor || ''}
                              onChange={(e) => atribuir(i.operacao_id, e.target.value)}>
                              <option value=''>— ninguém —</option>
                              {vends.map((v) => <option key={v} value={v}>{v}</option>)}
                              {i.vendedor && !vends.includes(i.vendedor) && (
                                <option value={i.vendedor}>{i.vendedor}</option>
                              )}
                            </select>
                          </td>
                        )}
                        <td className='ia-td-acao'>
                          <div className='refin-acoes'>
                            {i.pode_reapresentar && (
                              <button className='reset-btn' title='corrigir dados bancários e reapresentar'
                                onClick={() => abrirEm(i, 'conta')}>ajustar conta</button>
                            )}
                            {!i.pode_reapresentar && i.tratavel && (
                              <button className='reset-btn' title='enviar documento para resolver a pendência'
                                onClick={() => abrirEm(i, 'documento')}>enviar doc</button>
                            )}
                            <button className='reset-btn' onClick={() => abrirEm(i, null)}>abrir</button>
                          </div>
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
            abaInicial={abaInicial}
            onClose={() => setSel(null)}
            onFeito={(t) => { setMsg(t); setSel(null); carregar() }} />
        )}
      </div>
    </div>
  )
}

function PresencaDetalhe({ item, cat, geral, vendedor, modo, abaInicial, onClose, onFeito }) {
  const inicial = abaInicial || (item.pode_reapresentar ? 'conta' : 'documento')
  const [aba, setAba] = useState(inicial)
  const [erro, setErro] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const [conta, setConta] = useState({ banco: '', agencia: '', conta: '', digitoConta: '', tipoConta: '' })
  const [docTipo, setDocTipo] = useState('')
  const [arquivo, setArquivo] = useState(null)
  const [motivo, setMotivo] = useState('')

  const f = FAIXAS_P[item.faixa] || FAIXAS_P.outro

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
    <div className='ai-chat-overlay' onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className='ai-chat-sheet nuvem-sheet' style={{ maxWidth: 680 }}>
        <div className='ai-chat-gradient' />
        <div className='ai-chat-header'>
          <div>
            <div className='ai-chat-title'>{item.nome || 'adesão ' + item.operacao_id}</div>
            <div className='ai-chat-subtitle'>
              adesão {item.operacao_id} · {brlP(item.valor_liberado)} · parada há {tempoNaSituacao(item.minutos_na_situacao)}
            </div>
          </div>
          <button className='ai-chat-close' onClick={onClose}>×</button>
        </div>

        <div className='refin-body'>
          <div className='refin-linha'>
            <span className='ia-tag' style={{ borderColor: f.cor, color: f.cor }}>{item.status_nome}</span>
            {item.pendencia_nome && (
              <span className='ia-tag' style={{ borderColor: '#ba7517', color: '#ba7517', marginLeft: 8 }}>
                pendência: {item.pendencia_nome}
              </span>
            )}
          </div>

          {item.link_formalizacao && (
            <div className='refin-linha'>
              <span className='refin-dim'>link de formalização</span>
              <BotaoCopiar texto={item.link_formalizacao} />
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
              <div className='refin-campo'><label>Tipo de conta</label>
                <input value={conta.tipoConta} onChange={(e) => setConta({ ...conta, tipoConta: e.target.value })}
                  placeholder='corrente / poupança' /></div>
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
      </div>
    </div>
  )
}
