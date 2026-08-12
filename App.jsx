import { useEffect, useMemo, useState, useCallback } from 'react'
import { BarChart, Bar, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { supabase } from './supabaseClient'

const REFRESH_MS = 60_000 // atualiza sozinho a cada 60s

function fmtInt(n) {
  return new Intl.NumberFormat('pt-BR').format(n ?? 0)
}
function fmtMoney(n) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n ?? 0)
}
function fmtPct(n) {
  return `${(n ?? 0).toString().replace('.', ',')}%`
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)

  const rpcArgsBase = useMemo(() => ({
    p_campanha: campanha || null,
    p_origem: origem || null,
    p_meta: meta || null,
    p_date_from: dataInicio ? new Date(dataInicio).toISOString() : null,
    p_date_to: dataFim ? new Date(dataFim + 'T23:59:59').toISOString() : null,
  }), [campanha, origem, meta, dataInicio, dataFim])

  const loadFiltros = useCallback(async () => {
    const { data, error } = await supabase.rpc('dashboard_filtros')
    if (!error && data && data[0]) {
      setFiltros({
        campanhas: data[0].campanhas || [],
        origens: data[0].origens || [],
        metas: data[0].metas || [],
      })
    }
  }, [])

  const loadDados = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [kpiRes, enviosRes, campanhasRes] = await Promise.all([
        supabase.rpc('dashboard_kpis', rpcArgsBase),
        supabase.rpc('dashboard_envios_por_dia', rpcArgsBase),
        supabase.rpc('dashboard_campanhas', {
          p_origem: rpcArgsBase.p_origem,
          p_meta: rpcArgsBase.p_meta,
          p_date_from: rpcArgsBase.p_date_from,
          p_date_to: rpcArgsBase.p_date_to,
        }),
      ])
      if (kpiRes.error) throw kpiRes.error
      if (enviosRes.error) throw enviosRes.error
      if (campanhasRes.error) throw campanhasRes.error

      setKpis(kpiRes.data?.[0] ?? null)
      setEnvios(enviosRes.data ?? [])
      setCampanhas(campanhasRes.data ?? [])
      setLastUpdate(new Date())
    } catch (e) {
      setError(e.message || 'Erro ao carregar dados do Supabase.')
    } finally {
      setLoading(false)
    }
  }, [rpcArgsBase])

  useEffect(() => { loadFiltros() }, [loadFiltros])
  useEffect(() => { loadDados() }, [loadDados])

  useEffect(() => {
    const id = setInterval(loadDados, REFRESH_MS)
    return () => clearInterval(id)
  }, [loadDados])

  const maxLeads = Math.max(1, ...campanhas.map((c) => Number(c.leads) || 0))
  const maxReenvios = Math.max(1, ...campanhas.map((c) => Number(c.reenvios) || 0))

  return (
    <div className="app">
      <div className="topbar">
        <h1><span className="pulse" /> Disparos — Dashboard</h1>
        <span className="status-line">
          {loading ? 'atualizando…' : lastUpdate ? `atualizado às ${lastUpdate.toLocaleTimeString('pt-BR')}` : ''}
        </span>
      </div>

      <div className="filters">
        <select value={campanha} onChange={(e) => setCampanha(e.target.value)}>
          <option value="">campanha — todas</option>
          {filtros.campanhas.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={origem} onChange={(e) => setOrigem(e.target.value)}>
          <option value="">origem — todas</option>
          {filtros.origens.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <select value={meta} onChange={(e) => setMeta(e.target.value)}>
          <option value="">meta — todos</option>
          {filtros.metas.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input type="date" value={dataInicio} onChange={(e) => setDataInicio(e.target.value)} />
        <input type="date" value={dataFim} onChange={(e) => setDataFim(e.target.value)} />
      </div>

      {error && <div className="state-msg error">Erro: {error}</div>}

      <div className="panel chart-panel">
        <p className="section-label">Envios</p>
        <ResponsiveContainer width="100%" height="80%">
          <BarChart data={envios}>
            <XAxis dataKey="dia" hide />
            <Tooltip
              contentStyle={{ background: '#1b2620', border: '1px solid #263029', borderRadius: 8, fontFamily: 'IBM Plex Mono', fontSize: 12 }}
              labelStyle={{ color: '#8a978f' }}
            />
            <Bar dataKey="envios" fill="#d99089" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="kpi-grid">
        <div className="kpi"><p className="kpi-label">Total Leads</p><p className="kpi-value">{fmtInt(kpis?.total_leads)}</p></div>
        <div className="kpi"><p className="kpi-label">Gastado</p><p className="kpi-value">{fmtMoney(kpis?.gastado)}</p></div>
        <div className="kpi"><p className="kpi-label">Interação %</p><p className="kpi-value">{fmtPct(kpis?.interacao_pct)}</p></div>
        <div className="kpi"><p className="kpi-label">Pagas</p><p className="kpi-value">{fmtInt(kpis?.pagas)}</p></div>
      </div>
      <div className="kpi-grid">
        <div className="kpi"><p className="kpi-label">Faturado</p><p className="kpi-value">{fmtMoney(kpis?.faturado)}</p></div>
        <div className="kpi"><p className="kpi-label">ROI</p><p className="kpi-value accent">{(kpis?.roi ?? 0).toString().replace('.', ',')}</p></div>
        <div className="kpi"><p className="kpi-label">Conversão</p><p className="kpi-value">{fmtPct(kpis?.conversao_pct)}</p></div>
        <div className="kpi"><p className="kpi-label">Valor</p><p className="kpi-value">{fmtMoney(kpis?.valor)}</p></div>
      </div>

      <div className="panel table-panel">
        <p className="section-label">Campanhas Únicas</p>
        <div className="campanha-row head">
          <span>Campanha</span><span>Leads</span><span>Reenvios</span>
        </div>
        {campanhas.length === 0 && !loading && (
          <div className="state-msg">Nenhum dado para os filtros selecionados.</div>
        )}
        {campanhas.map((c) => (
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
      </div>
    </div>
  )
}
