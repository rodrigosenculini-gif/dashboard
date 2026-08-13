import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { BarChart, Bar, AreaChart, Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts'

const REFRESH_MS = 60_000 // atualiza sozinho a cada 60s
const VISIBLE_DEFAULT = 6

const VIEWS = [
  { id: 'geral', label: 'Disparos' },
  { id: 'leilao', label: 'Meta \u2014 Detalhado' },
  { id: 'produtos', label: 'Entradas LP' },
]

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
function fmtHora(d) {
  return d.toLocaleTimeString('pt-BR')
}
function todayISO() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function CampanhaSearch({ value, onChange, options }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const filtered = options.filter((o) => o.toLowerCase().includes(query.toLowerCase())).slice(0, 50)

  return (
    <div className="campanha-search" ref={ref}>
      <input
        type="text"
        className="campanha-search-input"
        placeholder="campanha \u2014 todas"
        value={open ? query : (value || '')}
        onFocus={() => { setOpen(true); setQuery('') }}
        onChange={(e) => setQuery(e.target.value)}
      />
      {open && (
        <div className="campanha-search-menu">
          <button
            className="campanha-search-item"
            onMouseDown={() => { onChange(''); setOpen(false) }}
          >
            campanha &mdash; todas
          </button>
          {filtered.map((o) => (
            <button
              key={o}
              className="campanha-search-item"
              onMouseDown={() => { onChange(o); setOpen(false) }}
            >
              {o}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="campanha-search-empty">Nenhuma campanha encontrada</div>
          )}
        </div>
      )}
    </div>
  )
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

function ViewSwitcher({ view, setView }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const current = VIEWS.find((v) => v.id === view)

  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  return (
    <div className="view-switcher" ref={ref}>
      <button className="view-switcher-btn" onClick={() => setOpen((v) => !v)}>
        {current?.label}
        <span className={`chevron ${open ? 'open' : ''}`}>&#9662;</span>
      </button>
      {open && (
        <div className="view-menu">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={`view-menu-item ${v.id === view ? 'active' : ''}`}
              onClick={() => { setView(v.id); setOpen(false) }}
            >
              {v.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function KpiCardWithSub({ label, value, sub, accent }) {
  return (
    <div className="kpi">
      <p className="kpi-label">{label}</p>
      <p className={`kpi-value ${accent ? 'accent' : ''}`}>{value}</p>
      {sub && <p className="kpi-sub">{sub}</p>}
    </div>
  )
}

function LeilaoDetalhado() {
  const [kpis, setKpis] = useState(null)
  const [falhaMin, setFalhaMin] = useState([])
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [campanhas, setCampanhas] = useState([])
  const [data, setData] = useState(todayISO())
  const [campanha, setCampanha] = useState('')

  useEffect(() => {
    callApi('filtros', {})
      .then((d) => setCampanhas(d?.[0]?.campanhas || []))
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [kpiData, falhaData, templateData] = await Promise.all([
        callApi('hoje_kpis', { data, campanha }),
        callApi('falha_por_minuto', { minutos: '60', campanha }),
        callApi('por_template_hoje', { data, campanha }),
      ])
      setKpis(kpiData?.[0] ?? null)
      setFalhaMin(
        (falhaData ?? []).map((d) => ({
          ...d,
          horaLabel: new Date(d.minuto).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        }))
      )
      setTemplates(templateData ?? [])
      setLastUpdate(new Date())
    } catch (e) {
      setError(e.message || 'Erro ao carregar dados.')
    } finally {
      setLoading(false)
    }
  }, [data, campanha])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  return (
    <>
      <div className="topbar">
        <div>
          <h1><span className="pulse" /> Meta &middot; Painel de Disparos</h1>
          <p className="subtitle">Envio de leads e disparo de WhatsApp via API Meta &mdash; Hotline</p>
        </div>
        <span className="status-line">
          {loading ? 'atualizando...' : lastUpdate ? `atualizado \u00e0s ${fmtHora(lastUpdate)}` : ''}
        </span>
      </div>

      <div className="filters">
        <input type="date" value={data} onChange={(e) => setData(e.target.value)} />
        <CampanhaSearch value={campanha} onChange={setCampanha} options={campanhas} />
      </div>

      {error && <div className="state-msg error">Erro: {error}</div>}

      <div className="kpi-grid">
        <KpiCardWithSub
          label="Mensagens hoje"
          value={fmtInt(kpis?.mensagens_hoje)}
          sub="sent + delivered + read + failed"
        />
        <KpiCardWithSub
          label="Entregues / lidas"
          value={fmtPct(kpis?.entregues_lidas_pct)}
          sub={`${fmtInt(kpis?.entregues_lidas_qtd)} mensagens`}
          accent
        />
        <KpiCardWithSub
          label="Falhas"
          value={fmtPct(kpis?.falhas_pct)}
          sub={`${fmtInt(kpis?.falhas_qtd)} mensagens`}
        />
        <KpiCardWithSub
          label="Templates ativos"
          value={fmtInt(kpis?.templates_ativos)}
          sub="com disparo hoje"
        />
      </div>

      <div className="panel chart-panel tall">
        <p className="section-label">Taxa de falha por minuto</p>
        <p className="section-sub">&uacute;ltimos 60 minutos</p>
        <ResponsiveContainer width="100%" height="78%">
          <AreaChart data={falhaMin}>
            <XAxis dataKey="horaLabel" tick={{ fontSize: 10, fill: '#8a978f' }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 10, fill: '#8a978f' }} width={34} unit="%" />
            <Tooltip
              contentStyle={{ background: '#1b2620', border: '1px solid #263029', borderRadius: 8, fontFamily: 'IBM Plex Mono', fontSize: 12 }}
              labelStyle={{ color: '#8a978f' }}
              formatter={(value, name) => [name === 'falha_pct' ? `${value}%` : value, name === 'falha_pct' ? 'falha' : name]}
            />
            <Area type="monotone" dataKey="falha_pct" stroke="#d99089" fill="#d99089" fillOpacity={0.25} strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="panel table-panel">
        <p className="section-label">Por template &mdash; hoje</p>
        <p className="section-sub">enviados, entregues, lidas e falhas desde 00:00</p>
        <div className="template-row head">
          <span>Template</span><span>Enviados</span><span>Entregues</span><span>Lidas</span><span>Falhas</span><span>Falha %</span><span>Composi&ccedil;&atilde;o</span>
        </div>
        {templates.length === 0 && !loading && (
          <div className="state-msg">Sem disparos hoje ainda.</div>
        )}
        {templates.map((t) => (
          <div className="template-row" key={t.template}>
            <span className="campanha-nome">{t.template}</span>
            <span>{fmtInt(t.enviados)}</span>
            <span>{fmtInt(t.entregues)}</span>
            <span>{fmtInt(t.lidas)}</span>
            <span>{fmtInt(t.falhas)}</span>
            <span className={Number(t.falha_pct) > 15 ? 'falha-alta' : 'falha-ok'}>{fmtPct(t.falha_pct)}</span>
            <span className="comp-bar">
              <span className="comp-fill-ok" style={{ width: `${100 - Number(t.falha_pct)}%` }} />
              <span className="comp-fill-fail" style={{ width: `${Number(t.falha_pct)}%` }} />
            </span>
          </div>
        ))}
        <p className="section-sub small">Falha % = falhas &divide; total de mensagens naquele status hoje. Atualizado a cada minuto.</p>
      </div>
    </>
  )
}

const PRODUTO_CORES = ['#d9b877', '#7fa8d9', '#d99089', '#8fd97f', '#c17fd9', '#d9d17f']

function ProdutosCampanhasList({ items, loading }) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? items : items.slice(0, VISIBLE_DEFAULT)
  return (
    <div className="panel table-panel">
      <p className="section-label">Campanha &times; Produto</p>
      <div className="produtos-row head">
        <span>Campanha</span><span>Produto</span><span>Leads</span><span>Intera&ccedil;&atilde;o %</span>
        <span>Aprovadas</span><span>Conv. Aprov.</span><span>Pagas</span><span>Valor Liberado</span>
      </div>
      {items.length === 0 && !loading && (
        <div className="state-msg">Nenhum dado para os filtros selecionados.</div>
      )}
      {visible.map((c, i) => (
        <div className="produtos-row" key={`${c.campanha}-${c.produto}-${i}`}>
          <span className="campanha-nome">{c.campanha}</span>
          <span className="campanha-nome">{c.produto}</span>
          <span>{fmtInt(c.leads)}</span>
          <span>{fmtPct(c.interacao_pct)}</span>
          <span>{fmtInt(c.aprovadas)}</span>
          <span>{fmtPct(c.conversao_aprovados_pct)}</span>
          <span>{fmtInt(c.pagas)}</span>
          <span>{fmtMoney(c.valor_liberado)}</span>
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

function EntradasLP() {
  const [kpis, setKpis] = useState(null)
  const [entradas, setEntradas] = useState([])
  const [campanhasProdutos, setCampanhasProdutos] = useState([])
  const [filtros, setFiltros] = useState({ campanhas: [], produtos: [], origens: [] })
  const [campanha, setCampanha] = useState('')
  const [produto, setProduto] = useState('')
  const [origem, setOrigem] = useState('')
  const [dataInicio, setDataInicio] = useState('')
  const [dataFim, setDataFim] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [showFunil, setShowFunil] = useState(false)

  const args = useMemo(() => ({
    campanha: campanha || '',
    produto: produto || '',
    origem: origem || '',
    date_from: dataInicio ? new Date(dataInicio).toISOString() : '',
    date_to: dataFim ? new Date(dataFim + 'T23:59:59').toISOString() : '',
  }), [campanha, produto, origem, dataInicio, dataFim])

  useEffect(() => {
    callApi('produtos_filtros', {})
      .then((d) => setFiltros({
        campanhas: d?.[0]?.campanhas || [],
        produtos: d?.[0]?.produtos || [],
        origens: d?.[0]?.origens || [],
      }))
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [kpiData, entradasData, aprovadasData, campanhasData] = await Promise.all([
        callApi('produtos_kpis', args),
        callApi('produtos_entradas_por_dia', args),
        callApi('produtos_aprovadas_por_dia', args),
        callApi('produtos_campanhas', { produto: args.produto, origem: args.origem, date_from: args.date_from, date_to: args.date_to }),
      ])
      setKpis(kpiData?.[0] ?? null)

      // pivota o formato longo (dia, produto, entradas) em linhas por dia com uma coluna por produto
      const porDia = {}
      const produtosVistos = new Set()
      for (const row of entradasData ?? []) {
        produtosVistos.add(row.produto)
        if (!porDia[row.dia]) porDia[row.dia] = { dia: row.dia }
        porDia[row.dia][row.produto] = Number(row.entradas)
      }
      for (const row of aprovadasData ?? []) {
        if (!porDia[row.dia]) porDia[row.dia] = { dia: row.dia }
        porDia[row.dia].aprovadas = Number(row.aprovadas)
      }
      const pivotado = Object.values(porDia).sort((a, b) => (a.dia > b.dia ? 1 : -1))
      setEntradas({ rows: pivotado, produtos: Array.from(produtosVistos) })

      setCampanhasProdutos(campanhasData ?? [])
      setLastUpdate(new Date())
    } catch (e) {
      setError(e.message || 'Erro ao carregar dados.')
    } finally {
      setLoading(false)
    }
  }, [args])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  const chartRows = entradas.rows || []
  const chartProdutos = entradas.produtos || []

  return (
    <>
      <div className="topbar">
        <h1><span className="pulse" /> Entradas LP</h1>
        <div className="topbar-right">
          <span className="status-line">
            {loading ? 'atualizando...' : lastUpdate ? `atualizado \u00e0s ${fmtHora(lastUpdate)}` : ''}
          </span>
          <button className="dots-btn" onClick={() => setShowFunil(true)} title="Funil de Entradas LP">
            &#8942;
          </button>
        </div>
      </div>

      <div className="filters">
        <CampanhaSearch value={campanha} onChange={setCampanha} options={filtros.campanhas} />
        <select value={produto} onChange={(e) => setProduto(e.target.value)}>
          <option value="">produto &mdash; todos</option>
          {filtros.produtos.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={origem} onChange={(e) => setOrigem(e.target.value)}>
          <option value="">origem &mdash; todas</option>
          {filtros.origens.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <input type="date" value={dataInicio} onChange={(e) => setDataInicio(e.target.value)} />
        <input type="date" value={dataFim} onChange={(e) => setDataFim(e.target.value)} />
      </div>

      {error && <div className="state-msg error">Erro: {error}</div>}

      <div className="panel chart-panel tall">
        <p className="section-label">Entradas</p>
        <ResponsiveContainer width="100%" height="82%">
          <ComposedChart data={chartRows}>
            <XAxis dataKey="dia" tick={{ fontSize: 10, fill: '#8a978f' }} interval="preserveStartEnd" />
            <YAxis yAxisId="left" tick={{ fontSize: 10, fill: '#8a978f' }} width={34} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: '#8a978f' }} width={34} />
            <Tooltip
              contentStyle={{ background: '#1b2620', border: '1px solid #263029', borderRadius: 8, fontFamily: 'IBM Plex Mono', fontSize: 12 }}
              labelStyle={{ color: '#8a978f' }}
            />
            <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'IBM Plex Mono' }} />
            {chartProdutos.map((p, i) => (
              <Bar key={p} yAxisId="left" dataKey={p} stackId="a" fill={PRODUTO_CORES[i % PRODUTO_CORES.length]} />
            ))}
            <Line yAxisId="right" type="monotone" dataKey="aprovadas" stroke="#a9d97f" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="kpi-grid">
        <div className="kpi"><p className="kpi-label">Total</p><p className="kpi-value">{fmtInt(kpis?.total)}</p></div>
        <div className="kpi"><p className="kpi-label">Intera&ccedil;&atilde;o</p><p className="kpi-value">{fmtInt(kpis?.interacao_qtd)}</p></div>
        <div className="kpi"><p className="kpi-label">Aprovados</p><p className="kpi-value">{fmtInt(kpis?.aprovados_qtd)}</p></div>
        <div className="kpi"><p className="kpi-label">Reprovado</p><p className="kpi-value">{fmtInt(kpis?.reprovados_qtd)}</p></div>
      </div>
      <div className="kpi-grid">
        <div className="kpi"><p className="kpi-label">Pagas</p><p className="kpi-value">{fmtInt(kpis?.pagas_qtd)}</p></div>
        <div className="kpi"><p className="kpi-label">Valor</p><p className="kpi-value">{fmtMoney(kpis?.valor)}</p></div>
        <div className="kpi"><p className="kpi-label">Intera&ccedil;&atilde;o %</p><p className="kpi-value">{fmtPct(kpis?.interacao_pct)}</p></div>
        <div className="kpi"><p className="kpi-label">Aprovados %</p><p className="kpi-value">{fmtPct(kpis?.aprovados_pct)}</p></div>
      </div>
      <div className="kpi-grid">
        <div className="kpi"><p className="kpi-label">Convers&atilde;o Total</p><p className="kpi-value accent">{fmtPct(kpis?.conversao_total_pct)}</p></div>
        <div className="kpi"><p className="kpi-label">Convers&atilde;o Aprovados</p><p className="kpi-value accent">{fmtPct(kpis?.conversao_aprovados_pct)}</p></div>
      </div>

      <ProdutosCampanhasList items={campanhasProdutos} loading={loading} />

      {showFunil && <FunilProdutos onClose={() => setShowFunil(false)} />}
    </>
  )
}

const FUNIL_DISPAROS_ETAPAS = [
  { key: 'leads', label: 'Disparado' },
  { key: 'entregues', label: 'Entregue' },
  { key: 'interagidos', label: 'Interagido' },
  { key: 'simulacoes_saldo', label: 'Simula\u00e7\u00f5es com saldo' },
  { key: 'pagas', label: 'Pagas' },
]

const FUNIL_PRODUTOS_ETAPAS = [
  { key: 'leads', label: 'Leads' },
  { key: 'interagidos', label: 'Interagidos' },
  { key: 'aprovados', label: 'Aprovados' },
  { key: 'pagos', label: 'Pagos' },
]

function FunilOverlay({ titulo, subtitulo, apiType, campanhaFiltroType, etapas, onClose }) {
  const [dados, setDados] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [campanhas, setCampanhas] = useState([])
  const [data, setData] = useState(todayISO())
  const [campanha, setCampanha] = useState('')

  useEffect(() => {
    callApi(campanhaFiltroType, {})
      .then((d) => setCampanhas(d?.[0]?.campanhas || []))
      .catch(() => {})
  }, [campanhaFiltroType])

  useEffect(() => {
    setLoading(true)
    setError(null)
    callApi(apiType, { data, campanha })
      .then((d) => setDados(d?.[0] ?? null))
      .catch((e) => setError(e.message || 'Erro ao carregar funil.'))
      .finally(() => setLoading(false))
  }, [apiType, data, campanha])

  const top = dados ? Number(dados[etapas[0].key]) || 1 : 1

  return (
    <div className="funil-overlay" onClick={onClose}>
      <div className="funil-panel" onClick={(e) => e.stopPropagation()}>
        <div className="funil-header">
          <div>
            <h2>{titulo}</h2>
            <p className="subtitle">{subtitulo}</p>
          </div>
          <button className="funil-close" onClick={onClose}>&times;</button>
        </div>

        <div className="filters">
          <input type="date" value={data} onChange={(e) => setData(e.target.value)} />
          <CampanhaSearch value={campanha} onChange={setCampanha} options={campanhas} />
        </div>

        {error && <div className="state-msg error">Erro: {error}</div>}
        {loading && !dados && <div className="state-msg">Carregando...</div>}

        {dados && (
          <div className="funil-body">
            {etapas.map((etapa, i) => {
              const valor = Number(dados[etapa.key]) || 0
              const pctTopo = top > 0 ? (valor / top) * 100 : 0
              const anterior = i > 0 ? Number(dados[etapas[i - 1].key]) || 0 : null
              const pctEtapa = anterior && anterior > 0 ? (valor / anterior) * 100 : null
              return (
                <div className="funil-etapa" key={etapa.key}>
                  <div className="funil-etapa-top">
                    <span className="funil-etapa-label">{etapa.label}</span>
                    <span className="funil-etapa-valor">{fmtInt(valor)}</span>
                    <span className="funil-etapa-pct-topo">{pctTopo.toFixed(0)}% do topo</span>
                  </div>
                  <div className="funil-bar-track">
                    <div className="funil-bar-fill" style={{ width: `${Math.max(pctTopo, 2)}%` }} />
                  </div>
                  {pctEtapa !== null && (
                    <div className="funil-conv">
                      Conv. etapa: <strong>{pctEtapa.toFixed(1)}%</strong>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function FunilDisparos({ onClose }) {
  return (
    <FunilOverlay
      titulo="Funil — Disparos"
      subtitulo="Do disparochat · somente leitura"
      apiType="funil"
      campanhaFiltroType="filtros"
      etapas={FUNIL_DISPAROS_ETAPAS}
      onClose={onClose}
    />
  )
}

function FunilProdutos({ onClose }) {
  return (
    <FunilOverlay
      titulo="Funil — Entradas LP"
      subtitulo="Do total_produtos · somente leitura"
      apiType="funil_produtos"
      campanhaFiltroType="produtos_filtros"
      etapas={FUNIL_PRODUTOS_ETAPAS}
      onClose={onClose}
    />
  )
}

function VisaoGeral() {
  const [filtros, setFiltros] = useState({ campanhas: [], origens: [], metas: [] })
  const [campanha, setCampanha] = useState('')
  const [origem, setOrigem] = useState('')
  const [meta, setMeta] = useState('')
  const [dataInicio, setDataInicio] = useState('')
  const [dataFim, setDataFim] = useState('')
  const [showFunil, setShowFunil] = useState(false)

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
    <>
      <div className="topbar">
        <h1><span className="pulse" /> Disparos &mdash; Dashboard</h1>
        <div className="topbar-right">
          <span className="status-line">
            {loading ? 'atualizando...' : lastUpdate ? `atualizado \u00e0s ${fmtHora(lastUpdate)}` : ''}
          </span>
          <button className="dots-btn" onClick={() => setShowFunil(true)} title="Funil de Disparos">
            &#8942;
          </button>
        </div>
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

      {showFunil && <FunilDisparos onClose={() => setShowFunil(false)} />}
    </>
  )
}

export default function App() {
  const [view, setView] = useState('geral')

  return (
    <div className="app">
      <ViewSwitcher view={view} setView={setView} />
      {view === 'geral' && <VisaoGeral />}
      {view === 'leilao' && <LeilaoDetalhado />}
      {view === 'produtos' && <EntradasLP />}
    </div>
  )
}
