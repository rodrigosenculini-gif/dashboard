import { useCallback, useEffect, useMemo, useState } from 'react'

// Leads de REFIN da Facta.
// - modo "vendedora": só os leads dela, pra trabalhar
// - modo "gestao" (view geral): todas as vendedoras, distribuição e acompanhamento

const STATUS_LABEL = {
  novo: 'Novo',
  em_abordagem: 'Em abordagem',
  sem_retorno: 'Sem retorno',
  nao_interagiu: 'Não interagiu',
  simulacao_enviada: 'Simulação enviada',
  aguardando_cliente: 'Aguardando cliente',
  recusou: 'Recusou',
  nao_elegivel: 'Não elegível',
  pago: 'Pago',
  cancelado_banco: 'Cancelado no banco',
}

// status que a vendedora pode escolher (pago tem fluxo próprio;
// cancelado_banco só vem da sincronização com a Facta)
const STATUS_VENDEDORA = [
  'em_abordagem',
  'simulacao_enviada',
  'aguardando_cliente',
  'sem_retorno',
  'nao_interagiu',
  'recusou',
  'nao_elegivel',
]

const TOM = {
  pago: 'ok',
  novo: 'warn',
  cancelado_banco: 'off',
  recusou: 'off',
  nao_elegivel: 'off',
}

async function api(type, body, params = '') {
  const res = await fetch(`/api/refin?type=${type}${params}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.error) throw new Error(data?.error || `Erro em ${type}`)
  return data
}

const brl = (v) =>
  v === null || v === undefined || v === ''
    ? '—'
    : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

const dataBr = (d) => (d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—')

function IconeRefin({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  )
}

export default function RefinButton({ vendedor = null, modo = 'vendedora' }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="reset-btn nuvem-trigger" title="Leads de refin" onClick={() => setOpen(true)}>
        <IconeRefin />
        <span>Refin</span>
      </button>
      {open && <RefinModal vendedor={vendedor} modo={modo} onClose={() => setOpen(false)} />}
    </>
  )
}

function RefinModal({ vendedor, modo, onClose }) {
  const gestao = modo === 'gestao'
  const [leads, setLeads] = useState([])
  const [resumo, setResumo] = useState(null)
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState('')
  const [msg, setMsg] = useState('')
  const [busca, setBusca] = useState('')
  const [filtroStatus, setFiltroStatus] = useState('todos')
  const [soNovos, setSoNovos] = useState(false)
  const [sel, setSel] = useState(null) // lead aberto
  const [salvando, setSalvando] = useState(false)

  const carregar = useCallback(async () => {
    setLoading(true); setErro('')
    try {
      const p = new URLSearchParams()
      if (!gestao && vendedor) p.set('vendedor', vendedor)
      if (soNovos) p.set('novos', '1')
      const r = await api('listar', null, `&${p.toString()}`)
      setLeads(r.data || [])
      if (gestao) {
        const s = await api('resumo')
        setResumo(s.data)
      }
    } catch (e) {
      setErro(e.message)
    } finally {
      setLoading(false)
    }
  }, [gestao, vendedor, soNovos])

  useEffect(() => { carregar() }, [carregar])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') (sel ? setSel(null) : onClose()) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sel, onClose])

  const visiveis = useMemo(() => {
    let l = leads
    if (filtroStatus !== 'todos') l = l.filter((x) => x.status_trabalho === filtroStatus)
    const b = busca.trim().toLowerCase()
    if (b) {
      l = l.filter(
        (x) =>
          (x.cliente || '').toLowerCase().includes(b) ||
          (x.cpf || '').includes(b.replace(/\D/g, '')) ||
          (x.codigo_af || '').includes(b)
      )
    }
    return l
  }, [leads, filtroStatus, busca])

  const contagem = useMemo(() => {
    const m = {}
    for (const l of leads) m[l.status_trabalho] = (m[l.status_trabalho] || 0) + 1
    return m
  }, [leads])

  async function mudarStatus(lead, status) {
    setSalvando(true); setErro(''); setMsg('')
    try {
      await api('status', { codigo_af: lead.codigo_af, status, por: vendedor || 'gestao' })
      setLeads((ls) => ls.map((x) => (x.id === lead.id ? { ...x, status_trabalho: status } : x)))
      setSel((s) => (s && s.id === lead.id ? { ...s, status_trabalho: status } : s))
      setMsg(`Status atualizado para "${STATUS_LABEL[status]}".`)
    } catch (e) { setErro(e.message) } finally { setSalvando(false) }
  }

  async function marcarPago(lead, valor, parcelas) {
    setSalvando(true); setErro(''); setMsg('')
    try {
      const r = await api('pago', {
        codigo_af: lead.codigo_af,
        por: vendedor || 'gestao',
        valor: valor === '' ? null : valor,
        parcelas: parcelas === '' ? null : parcelas,
      })
      setLeads((ls) =>
        ls.map((x) =>
          x.id === lead.id
            ? { ...x, status_trabalho: 'pago', valor_fechado: r.valor, parcelas_fechado: r.parcelas }
            : x
        )
      )
      setSel(null)
      setMsg(
        r.lancado_em_vendas
          ? 'Marcado como pago e lançado em Vendas.'
          : 'Marcado como pago (a venda já constava em Vendas).'
      )
    } catch (e) { setErro(e.message) } finally { setSalvando(false) }
  }

  return (
    <div className="ai-chat-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ai-chat-sheet nuvem-sheet refin-sheet">
        <div className="ai-chat-gradient" />

        <div className="ai-chat-header">
          <div>
            <div className="ai-chat-title">
              Refin — {gestao ? 'gestão de leads' : vendedor || 'meus leads'}
            </div>
            <div className="ai-chat-subtitle">
              {gestao
                ? 'Distribua os leads, acompanhe o andamento de cada vendedora e o status na Facta.'
                : 'Propostas aguardando assinatura. Clique num cliente para ver os dados e registrar o andamento.'}
            </div>
          </div>
          <button className="ai-chat-close" onClick={onClose}>✕ Fechar</button>
        </div>

        <div className="refin-body">
          {gestao && resumo && <PainelGestao resumo={resumo} onRecarregar={carregar} setErro={setErro} setMsg={setMsg} />}

          <div className="refin-toolbar">
            <input
              className="nuvem-busca"
              placeholder="Buscar nome, CPF ou AF…"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
            <select className="reset-btn" value={filtroStatus} onChange={(e) => setFiltroStatus(e.target.value)}>
              <option value="todos">Todos os status ({leads.length})</option>
              {Object.keys(STATUS_LABEL).map((s) =>
                contagem[s] ? (
                  <option key={s} value={s}>{STATUS_LABEL[s]} ({contagem[s]})</option>
                ) : null
              )}
            </select>
            <button
              className={soNovos ? 'refin-chip on' : 'refin-chip'}
              onClick={() => setSoNovos((v) => !v)}
              title="Mostrar só os que ainda não foram trabalhados"
            >
              {soNovos ? '● Só não trabalhados' : '○ Só não trabalhados'}
            </button>
            <button className="reset-btn" onClick={carregar}>↻ Atualizar</button>
          </div>

          {erro && <div className="state-msg error">Erro: {erro}</div>}
          {msg && <div className="state-msg" style={{ color: 'var(--lime)' }}>{msg}</div>}

          <div className="refin-tabela-wrap">
            <table className="ia-tabela refin-tabela">
              <thead>
                <tr>
                  <th>Cliente</th><th>CPF</th>
                  {gestao && <th>Vendedora</th>}
                  <th>Parcela</th><th>Valor AF</th><th>Digitação</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={gestao ? 8 : 7} className="ia-vazio">Carregando…</td></tr>}
                {!loading && visiveis.length === 0 && (
                  <tr><td colSpan={gestao ? 8 : 7} className="ia-vazio">
                    Nenhum lead para esse filtro.
                  </td></tr>
                )}
                {!loading && visiveis.map((l) => (
                  <tr
                    key={l.id}
                    onClick={() => setSel(l)}
                    className={sel?.id === l.id ? 'ia-linha-ativa' : undefined}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>{l.cliente || '—'}</td>
                    <td className="refin-mono">{l.cpf || '—'}</td>
                    {gestao && <td>{l.vendedor || <span className="refin-dim">sem dono</span>}</td>}
                    <td className="refin-mono">{brl(l.vlrprestacao)}{l.numeroprestacao ? ` × ${l.numeroprestacao}` : ''}</td>
                    <td className="refin-mono">{brl(l.valor_af)}</td>
                    <td className="refin-mono">{dataBr(l.data_digitacao)}</td>
                    <td>
                      <span className={`ia-tag ${TOM[l.status_trabalho] || ''}`}>
                        {STATUS_LABEL[l.status_trabalho] || l.status_trabalho}
                      </span>
                    </td>
                    <td className="ia-td-acao">abrir ›</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {sel && (
          <DetalheLead
            lead={sel}
            gestao={gestao}
            salvando={salvando}
            onFechar={() => setSel(null)}
            onStatus={(s) => mudarStatus(sel, s)}
            onPago={(v, p) => marcarPago(sel, v, p)}
          />
        )}
      </div>
    </div>
  )
}

// ---------- painel de gestão (view geral) ----------

function PainelGestao({ resumo, onRecarregar, setErro, setMsg }) {
  const [aberto, setAberto] = useState(false)
  const [vendedoras, setVendedoras] = useState([])
  const [escolhidas, setEscolhidas] = useState([])
  const [dataIni, setDataIni] = useState('')
  const [dataFim, setDataFim] = useState('')
  const [ocupado, setOcupado] = useState('')

  useEffect(() => {
    fetch('/api/ia?type=vendedores')
      .then((r) => r.json())
      .then((r) => {
        const nomes = (r.data || []).map((v) => v.nome_vendas || v.vendedor).filter(Boolean)
        setVendedoras([...new Set(nomes)])
      })
      .catch(() => {})
  }, [])

  const t = resumo.totais || {}

  async function importar() {
    if (!dataIni || !dataFim) { setErro('Informe as duas datas.'); return }
    setOcupado('importar'); setErro(''); setMsg('')
    try {
      const r = await api('importar', { data_ini: dataIni, data_fim: dataFim })
      setMsg(`Importação: ${r.inseridos} novos, ${r.atualizados} atualizados (${r.recebidas_da_facta} recebidos da Facta).`)
      onRecarregar()
    } catch (e) { setErro(e.message) } finally { setOcupado('') }
  }

  async function sincronizar() {
    setOcupado('sinc'); setErro(''); setMsg('')
    try {
      const r = await api('sincronizar', {})
      setMsg(`Sincronizado: ${r.atualizados} atualizados · ${r.viraram_pago} pagos · ${r.viraram_cancelado} cancelados.`)
      onRecarregar()
    } catch (e) { setErro(e.message) } finally { setOcupado('') }
  }

  async function distribuir() {
    if (!escolhidas.length) { setErro('Selecione as vendedoras que vão receber.'); return }
    setOcupado('dist'); setErro(''); setMsg('')
    try {
      const r = await api('distribuir', { vendedoras: escolhidas })
      setMsg(`Distribuído entre ${escolhidas.length} vendedora(s).`)
      onRecarregar()
    } catch (e) { setErro(e.message) } finally { setOcupado('') }
  }

  return (
    <div className="refin-gestao">
      <div className="refin-kpis">
        <div className="ia-kpi"><span>Total de leads</span><strong>{t.total ?? 0}</strong></div>
        <div className="ia-kpi"><span>Não trabalhados</span><strong>{t.novos ?? 0}</strong></div>
        <div className={`ia-kpi ${Number(t.sem_dono) > 0 ? 'ia-kpi-alerta' : ''}`}>
          <span>Sem dono</span><strong>{t.sem_dono ?? 0}</strong>
        </div>
        <div className="ia-kpi">
          <span>Última importação</span>
          <strong style={{ fontSize: 13 }}>
            {t.ultima_importacao ? new Date(t.ultima_importacao).toLocaleDateString('pt-BR') : '—'}
          </strong>
        </div>
      </div>

      <button className="refin-toggle" onClick={() => setAberto((v) => !v)}>
        {aberto ? '▾' : '▸'} Importar, sincronizar e distribuir
      </button>

      {aberto && (
        <div className="refin-acoes">
          <div className="refin-linha">
            <label>Importar período</label>
            <input placeholder="DD/MM/AAAA" value={dataIni} onChange={(e) => setDataIni(e.target.value)} />
            <span className="refin-dim">até</span>
            <input placeholder="DD/MM/AAAA" value={dataFim} onChange={(e) => setDataFim(e.target.value)} />
            <button className="refresh-btn" onClick={importar} disabled={!!ocupado}>
              {ocupado === 'importar' ? 'Importando…' : '↓ Importar da Facta'}
            </button>
            <span className="refin-dim">janela máxima de 30 dias</span>
          </div>

          <div className="refin-linha">
            <label>Status na Facta</label>
            <button className="refresh-btn" onClick={sincronizar} disabled={!!ocupado}>
              {ocupado === 'sinc' ? 'Sincronizando…' : '↻ Sincronizar status'}
            </button>
            <span className="refin-dim">marca pago (16) e cancelado (28) automaticamente</span>
          </div>

          <div className="refin-linha refin-linha-dist">
            <label>Dividir entre</label>
            <div className="refin-chips">
              {vendedoras.map((v) => (
                <button
                  key={v}
                  className={escolhidas.includes(v) ? 'refin-chip on' : 'refin-chip'}
                  onClick={() =>
                    setEscolhidas((e) => (e.includes(v) ? e.filter((x) => x !== v) : [...e, v]))
                  }
                >{v}</button>
              ))}
            </div>
            <button className="refresh-btn" onClick={distribuir} disabled={!!ocupado}>
              {ocupado === 'dist' ? 'Dividindo…' : '⇄ Dividir igualmente'}
            </button>
          </div>
          <p className="refin-dim" style={{ margin: 0 }}>
            A divisão só mexe nos leads ainda não trabalhados — quem já está em andamento continua com a mesma vendedora.
          </p>
        </div>
      )}

      {resumo.porVendedora?.length > 0 && (
        <div className="refin-tabela-wrap" style={{ maxHeight: 190 }}>
          <table className="ia-tabela">
            <thead>
              <tr><th>Vendedora</th><th>Total</th><th>Não trabalhados</th><th>Em andamento</th><th>Pagos</th><th>Cancelados</th><th>Valor pago</th></tr>
            </thead>
            <tbody>
              {resumo.porVendedora.map((v) => (
                <tr key={v.vendedor}>
                  <td>{v.vendedor}</td>
                  <td>{v.total}</td>
                  <td>{v.novos}</td>
                  <td>{v.em_andamento}</td>
                  <td><span className="ia-tag ok">{v.pagos}</span></td>
                  <td>{v.cancelados}</td>
                  <td className="refin-mono">{brl(v.valor_pago)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---------- detalhe do lead ----------

function DetalheLead({ lead, gestao, salvando, onFechar, onStatus, onPago }) {
  const [valor, setValor] = useState('')
  const [parcelas, setParcelas] = useState('')
  const [confirmandoPago, setConfirmandoPago] = useState(false)

  const campos = [
    ['Código AF', lead.codigo_af],
    ['CPF', lead.cpf],
    ['Telefone', lead.telefone],
    ['Tabela', lead.tabela],
    ['Operação', lead.tipo_operacao],
    ['Averbador', lead.averbador],
    ['Valor AF', brl(lead.valor_af)],
    ['Valor bruto', brl(lead.valor_bruto)],
    ['Parcela', brl(lead.vlrprestacao)],
    ['Nº parcelas', lead.numeroprestacao],
    ['Taxa', lead.taxa ? `${lead.taxa}%` : null],
    ['IOF', brl(lead.valor_iof)],
    ['Seguro', brl(lead.valor_seguro)],
    ['Saldo devedor', brl(lead.saldo_devedor)],
    ['Matrícula', lead.matricula],
    ['Contrato', lead.numero_contrato],
    ['Chave PIX', lead.chave_pix],
    ['Assinatura', lead.assinatura_digital],
    ['Digitação', dataBr(lead.data_digitacao)],
    ['Status na Facta', lead.status_proposta],
    ['Última ocorrência', lead.observacao_ocorrencia],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== '—')

  return (
    <div className="nuvem-preview" onMouseDown={(e) => { if (e.target === e.currentTarget) onFechar() }}>
      <div className="nuvem-preview-box">
        <div className="nuvem-preview-head">
          <div>
            <div className="ai-chat-title" style={{ fontSize: 17 }}>{lead.cliente}</div>
            <div className="ai-chat-subtitle">
              AF {lead.codigo_af} · <span className={`ia-tag ${TOM[lead.status_trabalho] || ''}`}>
                {STATUS_LABEL[lead.status_trabalho] || lead.status_trabalho}
              </span>
              {gestao && lead.vendedor ? ` · ${lead.vendedor}` : ''}
            </div>
          </div>
          <button className="ai-chat-close" onClick={onFechar}>Voltar</button>
        </div>

        <div className="refin-detalhe">
          <div className="refin-grid">
            {campos.map(([k, v]) => (
              <div className="refin-campo" key={k}>
                <span>{k}</span>
                <strong>{String(v)}</strong>
              </div>
            ))}
          </div>

          <div className="refin-acoes-lead">
            <div className="refin-status-btns">
              {STATUS_VENDEDORA.map((s) => (
                <button
                  key={s}
                  className={lead.status_trabalho === s ? 'refin-chip on' : 'refin-chip'}
                  disabled={salvando}
                  onClick={() => onStatus(s)}
                >{STATUS_LABEL[s]}</button>
              ))}
            </div>

            {lead.status_trabalho !== 'pago' && (
              <div className="refin-pago">
                {!confirmandoPago ? (
                  <button className="leilao-btn-on" onClick={() => setConfirmandoPago(true)}>
                    ✓ Marcar como pago
                  </button>
                ) : (
                  <>
                    <span className="refin-dim">
                      Valor e parcelas só se o fechamento saiu diferente da proposta:
                    </span>
                    <div className="refin-linha">
                      <input
                        placeholder={`Valor (${brl(lead.valor_af)})`}
                        value={valor}
                        onChange={(e) => setValor(e.target.value)}
                      />
                      <input
                        placeholder={`Parcelas (${lead.numeroprestacao ?? '—'})`}
                        value={parcelas}
                        onChange={(e) => setParcelas(e.target.value)}
                      />
                      <button
                        className="leilao-btn-on"
                        disabled={salvando}
                        onClick={() => onPago(valor, parcelas)}
                      >
                        {salvando ? 'Salvando…' : 'Confirmar pago'}
                      </button>
                      <button className="reset-btn" onClick={() => setConfirmandoPago(false)}>Cancelar</button>
                    </div>
                  </>
                )}
              </div>
            )}

            {lead.status_trabalho === 'pago' && (
              <div className="state-msg" style={{ color: 'var(--lime)' }}>
                Pago · {brl(lead.valor_fechado ?? lead.valor_af)}
                {lead.parcelas_fechado ? ` em ${lead.parcelas_fechado}x` : ''} — já lançado em Vendas.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
