import { useEffect, useMemo, useState, useCallback } from 'react'
import { BarChart, Bar, ResponsiveContainer, Tooltip, XAxis, Legend } from 'recharts'

const REFRESH_MS = 60_000 // atualiza sozinho a cada 60s
const VISIBLE_DEFAULT = 6

async function callApi(type, params) {
  const qs = new URLSearchParams({ type, ...params })
  const res = await fetch(`/api/dashboard?${qs.toString()}`)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Erro ao buscar ${type}`)
  return data
}

function fmtInt(n) {
  return new Intl.NumberFormat('pt-BR').format(n ?? 0)
}
function fmtMoney(n) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n ?? 0)
}
function fmtPct(n) {
  return `${(n ?? 0).toString().replace('.', ',')}%`
}
function fmtMin(n) {
  return `${(n ?? 0).toString().replace('.', ',')} min`
}

function ExpandToggle({ expanded, onToggle, hiddenCount }) {
  if (hiddenCount <= 0 && !expanded) return null
  return (
    <button className="expand-btn" onClick={onToggle}>
      {expanded ? 'Mostrar menos' : `Mostrar mais (+${hiddenCount})`}
    </button>
  )
}

function BreakdownList({ title, items, loading }) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? items : items.slice(0, VISIBLE_DEFAULT)
  const max = Math.max(1, ...items.map((i) => Number(i.leads) || 0))
  return (
    <div className="panel table-panel breakdown">
      <p className="section-label">{title}</p>
      <div className="breakdown-row head">
        <span>Valor</span><span>Leads</span>
      </div>
      {items.length === 0 && !loading && (
        <div className="state-msg">Sem dados para os filtros selecionados.</div>
      )}
      {visible.map((i) => (
        <div className="breakdown-row" key={i.valor}>
          <span className="campanha-nome">{i.valor}</span>
          <span className="bar-cell">
            <span className="bar-track">
              <span className="bar-fill" style={{ width: `${(Number(i.leads) / max) * 100}%` }} />
            </span>
            <span className="bar-value">{fmtInt(i.leads)}</span>
          </span>
        </div>
      ))}
      <ExpandToggle
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        hiddenCount={items.length - VISIBLE_DEFAULT}
      />
    </div>
  )
}

function CampanhasList({ items, loading }) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? items : items.slice(0, VISIBLE_DEFAULT)
  const maxLeads = Math.max(1, ...items.map((c) => Number(c.leads) || 0))
  const maxReenvios = Math.max(1, ...items.map((c) => Number(c.reenvios) || 0))
  return (
    <div className="panel table-panel">
      <p className="section-label">Campanhas &Uacute;nicas</p>
      <div className="campanha-row head">
        <span>Campanha</span><span>Leads</span><span>Reenvios</span>
      </div>
      {items.length === 0 && !loading && (
        <div className="state-msg">Nenhum dado para os filtros selecionados.</div>
      )}
      {visible.map((c) => (
        <div className="campanha-row" key={c.campanha}>
          <span className="campanha-nome">{c.campanha}</span>
          <span className="bar-cell">
            <span className="bar-track">
              <span className="bar-fill" style={{ width: `${(Number(c.leads) / maxLeads) * 100}%` }} />
            </span>
            <span className="bar-value">{fmtInt(c.leads)}</span>
          </span>
          <span className="bar-cell">
            <span className="bar-track">
              <span className="bar-fill reenvio" style={{ width: `${(Number(c.reenvios) / maxReenvios) * 100}%` }} />
            </span>
            <span className="bar-value">{fmtInt(c.reenvios)}</span>
          </span>
        </div>
      ))}
      <ExpandToggle
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        hiddenCount={items.length - VISIBLE_DEFAULT}
      />
    </div>
  )
}

export default function App() {
  const [filtros, setFiltros] = useState({ campanhas: [], origens: [], metas: [] })
  const [campanha, setCampanha] = useState('')
  const [origem, setOrigem] = useState('')
  const [meta, setMeta] = useState('')
  const [dataInicio, setDataInicio] = useState('')
  const [dataFim, setDataFim] = useState('')

  const [kpis, setKpis] = useState(null)
  const [envios, setEnvios] = useState([])
  const [campanhas, setCampanhas] = useState([])
  const [porConversa, setPorConversa] = useState([])
  const [porMeta, setPorMeta] = useState([])
  const [porMensagem, setPorMensagem] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)

  const apiArgsBase = useMemo(() => ({
    campanha: campanha || '',
    origem: origem || '',
    meta: meta || '',
    date_from: dataInicio ? new Date(dataInicio).toISOString() : '',
    date_to: dataFim ? new Date(dataFim + 'T23:59:59').toISOString() : '',
  }), [campanha, origem, meta, dataInicio, dataFim])

  const loadFiltros = useCallback(async () => {
    try {
      const data = await callApi('filtros', {})
      if (data && data[0]) {
        setFiltros({
          campanhas: data[0].campanhas || [],
          origens: data[0].origens || [],
          metas: data[0].metas || [],
        })
      }
    } catch {
      // silencioso: erro aqui nao e critico para os KPIs aparecerem
    }
  }, [])

  const loadDados = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [kpiData, enviosData, campanhasData, conversaData, metaData, mensagemData] = await Promise.all([
        callApi('kpis', apiArgsBase),
        callApi('envios', apiArgsBase),
        callApi('campanhas', {
          origem: apiArgsBase.origem,
          meta: apiArgsBase.meta,
          date_from: apiArgsBase.date_from,
          date_to: apiArgsBase.date_to,
        }),
        callApi('por_conversa', apiArgsBase),
        callApi('por_meta', apiArgsBase),
        callApi('por_mensagem', apiArgsBase),
      ])

      setKpis(kpiData?.[0] ?? null)
      setEnvios(enviosData ?? [])
      setCampanhas(campanhasData ?? [])
      setPorConversa(conversaData ?? [])
      setPorMeta(metaData ?? [])
      setPorMensagem(mensagemData ?? [])
      setLastUpdate(new Date())
    } catch (e) {
      setError(e.message || 'Erro ao carregar dados.')
    } finally {
      setLoading(false)
    }
  }, [apiArgsBase])

  useEffect(() => { loadFiltros() }, [loadFiltros])
  useEffect(() => { loadDados() }, [loadDados])

  useEffect(() => {
    const id = setInterval(loadDados, REFRESH_MS)
    return () => clearInterval(id)
  }, [loadDados])

  return (
    <div className="app">
      <div className="topbar">
        <h1><span className="pulse" /> Disparos &mdash; Dashboard</h1>
        <span className="status-line">
          {loading ? 'atualizando...' : lastUpdate ? `atualizado \u00e0s ${lastUpdate.toLocaleTimeString('pt-BR')}` : ''}
        </span>
      </div>

      <div className="filters">
        <select value={campanha} onChange={(e) => setCampanha(e.target.value)}>
          <option value="">campanha &mdash; todas</option>
          {filtros.campanhas.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={origem} onChange={(e) => setOrigem(e.target.value)}>
          <option value="">origem &mdash; todas</option>
          {filtros.origens.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <select value={meta} onChange={(e) => setMeta(e.target.value)}>
          <option value="">meta &mdash; todos</option>
          {filtros.metas.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input type="date" value={dataInicio} onChange={(e) => setDataInicio(e.target.value)} />
        <input type="date" value={dataFim} onChange={(e) => setDataFim(e.target.value)} />
      </div>

      {error && <div className="state-msg error">Erro: {error}</div>}

      <div className="panel chart-panel">
        <p className="section-label">Envios &amp; Reenvios</p>
        <ResponsiveContainer width="100%" height="80%">
          <BarChart data={envios}>
            <XAxis dataKey="dia" hide />
            <Tooltip
              contentStyle={{ background: '#1b2620', border: '1px solid #263029', borderRadius: 8, fontFamily: 'IBM Plex Mono', fontSize: 12 }}
              labelStyle={{ color: '#8a978f' }}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, fontFamily: 'IBM Plex Mono' }}
              formatter={(value) => (value === 'envios' ? 'Envios' : 'Reenvios')}
            />
            <Bar dataKey="envios" stackId="a" fill="#d99089" radius={[0, 0, 0, 0]} />
            <Bar dataKey="reenvios" stackId="a" fill="#d9b877" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="kpi-grid">
        <div className="kpi"><p className="kpi-label">Total Leads</p><p className="kpi-value">{fmtInt(kpis?.total_leads)}</p></div>
        <div className="kpi"><p className="kpi-label">Gastado</p><p className="kpi-value">{fmtMoney(kpis?.gastado)}</p></div>
        <div className="kpi"><p className="kpi-label">Intera&ccedil;&atilde;o %</p><p className="kpi-value">{fmtPct(kpis?.interacao_pct)}</p></div>
        <div className="kpi"><p className="kpi-label">Intera&ccedil;&atilde;o (qtd)</p><p className="kpi-value">{fmtInt(kpis?.interacao_qtd)}</p></div>
      </div>
      <div className="kpi-grid">
        <div className="kpi"><p className="kpi-label">Pagas</p><p className="kpi-value">{fmtInt(kpis?.pagas)}</p></div>
        <div className="kpi"><p className="kpi-label">Faturado</p><p className="kpi-value">{fmtMoney(kpis?.faturado)}</p></div>
        <div className="kpi"><p className="kpi-label">ROI</p><p className="kpi-value accent">{(kpis?.roi ?? 0).toString().replace('.', ',')}</p></div>
        <div className="kpi"><p className="kpi-label">Convers&atilde;o</p><p className="kpi-value">{fmtPct(kpis?.conversao_pct)}</p></div>
      </div>
      <div className="kpi-grid">
        <div className="kpi"><p className="kpi-label">Valor</p><p className="kpi-value">{fmtMoney(kpis?.valor)}</p></div>
        <div className="kpi"><p className="kpi-label">Tempo m&eacute;dio resposta</p><p className="kpi-value">{fmtMin(kpis?.tempo_resposta_min)}</p></div>
      </div>

      <CampanhasList items={campanhas} loading={loading} />

      <div className="breakdown-grid">
        <BreakdownList title="Por Conversa" items={porConversa} loading={loading} />
        <BreakdownList title="Por Meta" items={porMeta} loading={loading} />
        <BreakdownList title="Por Mensagem" items={porMensagem} loading={loading} />
      </div>
    </div>
  )
}
