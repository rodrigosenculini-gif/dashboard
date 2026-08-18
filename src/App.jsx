import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { BarChart, Bar, AreaChart, Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts'

const REFRESH_MS = 60_000 // atualiza sozinho a cada 60s
const VISIBLE_DEFAULT = 6

const VIEWS = [
  { id: 'geral', label: 'Disparos' },
  { id: 'leilao', label: 'Meta \u2014 Detalhado' },
  { id: 'produtos', label: 'Entradas LP' },
  { id: 'n8n', label: 'n8n \u2014 Execu\u00e7\u00f5es' },
  { id: 'vendedoras', label: 'Vendedoras' },
  { id: 'vendas', label: 'Vendas' },
]

async function callApi(type, params) {
  const qs = new URLSearchParams({ type, ...params })
  const res = await fetch(`/api/dashboard?${qs.toString()}`)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Erro ao buscar ${type}`)
  return data
}

async function postApi(type, body) {
  const res = await fetch(`/api/dashboard?type=${type}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Erro ao enviar ${type}`)
  return data
}

// L\u00ea o CSV de vendedoras (arquivo exportado em Latin-1, separado por ";"),
// corta s\u00f3 as colunas necess\u00e1rias e normaliza cpf/data/valor.
async function parseVendedorasCsv(file) {
  const buf = await file.arrayBuffer()
  const text = new TextDecoder('iso-8859-1').decode(buf)
  const lines = text.split(/\r\n|\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []

  const header = lines[0].split(';').map((h) => h.trim())
  const idx = (name) => header.indexOf(name)
  const iData = idx('Data Status')
  const iBanco = idx('Banco')
  const iAde = idx('ADE')
  const iCpf = idx('Cpf')
  const iNome = idx('Nome')
  const iVendedor = idx('Vendedor')
  const iTabela = idx('Tabela')
  const iValor = idx('Valor')

  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(';')
    if (cols.length < header.length) continue

    const cpfDigits = (cols[iCpf] || '').replace(/\D/g, '')
    if (!cpfDigits) continue
    const cpf = cpfDigits.padStart(11, '0')

    const dataRaw = (cols[iData] || '').trim() // vem como DD/MM/AAAA
    const [dd, mm, yyyy] = dataRaw.split('/')
    const dataIso = dd && mm && yyyy ? `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}` : ''

    const valorRaw = (cols[iValor] || '').trim().replace(/\./g, '').replace(',', '.')
    const valor = valorRaw && !isNaN(Number(valorRaw)) ? valorRaw : ''

    rows.push({
      data_status: dataIso,
      banco: (cols[iBanco] || '').trim(),
      adesao: (cols[iAde] || '').trim(),
      cpf,
      nome: (cols[iNome] || '').trim(),
      vendedor: (cols[iVendedor] || '').trim(),
      tabela: (cols[iTabela] || '').trim(),
      valor,
    })
  }
  return rows
}

// Le\u00ea o CSV da visão Vendas. Aceita variações de nome de coluna e não
// exige todas — o gatilho no banco calcula produto/peso/ponto sozinho a
// partir do que vier (tabela OU parcelas+seguro).
async function parseVendasCsv(file) {
  const buf = await file.arrayBuffer()
  const text = new TextDecoder('iso-8859-1').decode(buf)
  const lines = text.split(/\r\n|\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []

  const delim = lines[0].includes(';') ? ';' : ','
  const header = lines[0].split(delim).map((h) => h.trim().toLowerCase())
  const idx = (...aliases) => {
    for (const a of aliases) {
      const i = header.indexOf(a.toLowerCase())
      if (i !== -1) return i
    }
    return -1
  }
  const iAdesao = idx('ade', 'adesão', 'adesao')
  const iCpf = idx('cpf')
  const iTabela = idx('tabela')
  const iNome = idx('nome')
  const iValor = idx('valor')
  const iData = idx('data status', 'data')
  const iBanco = idx('banco')
  const iParcelas = idx('parcelas')
  const iSeguro = idx('seguro')

  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delim)
    if (cols.length < 2) continue

    const cpfDigits = (iCpf !== -1 ? cols[iCpf] : '').replace(/\D/g, '')
    if (!cpfDigits) continue
    const cpf = cpfDigits.padStart(11, '0')

    let dataIso = ''
    if (iData !== -1) {
      const dataRaw = (cols[iData] || '').trim()
      if (dataRaw.includes('/')) {
        const [dd, mm, yyyy] = dataRaw.split('/')
        dataIso = dd && mm && yyyy ? `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}` : ''
      } else {
        dataIso = dataRaw
      }
    }

    const valorRaw = iValor !== -1 ? (cols[iValor] || '').trim().replace(/\./g, '').replace(',', '.') : ''
    const valor = valorRaw && !isNaN(Number(valorRaw)) ? valorRaw : ''

    rows.push({
      adesao: iAdesao !== -1 ? (cols[iAdesao] || '').trim() : '',
      cpf,
      tabela: iTabela !== -1 ? (cols[iTabela] || '').trim() : '',
      nome: iNome !== -1 ? (cols[iNome] || '').trim() : '',
      valor,
      data: dataIso,
      banco: iBanco !== -1 ? (cols[iBanco] || '').trim() : '',
      parcelas: iParcelas !== -1 ? (cols[iParcelas] || '').trim() : '',
      seguro: iSeguro !== -1 ? (cols[iSeguro] || '').trim() : '',
    })
  }
  return rows
}

async function callN8nApi(type, params) {
  const qs = new URLSearchParams({ type, ...params })
  const res = await fetch(`/api/n8n?${qs.toString()}`)
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

function fmtDateISO(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function weekRange() {
  const now = new Date()
  const dow = now.getDay() // 0=domingo, 1=segunda, ... 6=s\u00e1bado
  const diffToMonday = (dow + 6) % 7 // 0 se hoje j\u00e1 \u00e9 segunda
  const monday = new Date(now)
  monday.setDate(now.getDate() - diffToMonday)
  const friday = new Date(monday)
  friday.setDate(monday.getDate() + 4)
  const hojeStr = fmtDateISO(now)
  const sextaStr = fmtDateISO(friday)
  // nunca passa da sexta-feira dessa semana, mesmo se hoje for s\u00e1bado/domingo
  const to = hojeStr < sextaStr ? hojeStr : sextaStr
  return { from: fmtDateISO(monday), to }
}

function presetRange(preset) {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()
  if (preset === 'hoje') {
    const t = fmtDateISO(now)
    return { from: t, to: t }
  }
  if (preset === 'ontem') {
    const t = fmtDateISO(new Date(y, m, d - 1))
    return { from: t, to: t }
  }
  if (preset === 'este_mes') {
    return { from: fmtDateISO(new Date(y, m, 1)), to: fmtDateISO(now) }
  }
  if (preset === 'mes_passado') {
    return { from: fmtDateISO(new Date(y, m - 1, 1)), to: fmtDateISO(new Date(y, m, 0)) }
  }
  return { from: '', to: '' }
}

function DateRangeFilter({ dataInicio, setDataInicio, dataFim, setDataFim }) {
  const applyPreset = (preset) => {
    const { from, to } = presetRange(preset)
    setDataInicio(from)
    setDataFim(to)
  }
  return (
    <div className="date-range-filter">
      <div className="date-presets">
        <button type="button" onClick={() => applyPreset('hoje')}>Hoje</button>
        <button type="button" onClick={() => applyPreset('ontem')}>Ontem</button>
        <button type="button" onClick={() => applyPreset('este_mes')}>Este m&ecirc;s</button>
        <button type="button" onClick={() => applyPreset('mes_passado')}>M&ecirc;s passado</button>
      </div>
      <input type="date" value={dataInicio} onChange={(e) => setDataInicio(e.target.value)} />
      <input type="date" value={dataFim} onChange={(e) => setDataFim(e.target.value)} />
    </div>
  )
}

const HORAS = Array.from({ length: 24 }, (_, i) => i)

function HourFilter({ horaInicio, setHoraInicio, horaFim, setHoraFim }) {
  return (
    <div className="hour-filter">
      <span className="hour-filter-label">Hor&aacute;rio</span>
      <select value={horaInicio} onChange={(e) => setHoraInicio(e.target.value)}>
        <option value="">--</option>
        {HORAS.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}h</option>)}
      </select>
      <span className="hour-filter-sep">at&eacute;</span>
      <select value={horaFim} onChange={(e) => setHoraFim(e.target.value)}>
        <option value="">--</option>
        {HORAS.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}h</option>)}
      </select>
    </div>
  )
}

function SearchSelect({ value, onChange, options, label, allLabel }) {
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
        placeholder={`${label} \u2014 todas`}
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
            {allLabel || `${label} \u2014 todas`}
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
            <div className="campanha-search-empty">Nenhum valor encontrado</div>
          )}
        </div>
      )}
    </div>
  )
}

function CampanhaSearch({ value, onChange, options }) {
  return <SearchSelect value={value} onChange={onChange} options={options} label="campanha" />
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
  const [dataInicio, setDataInicio] = useState(todayISO())
  const [dataFim, setDataFim] = useState(todayISO())
  const [horaInicio, setHoraInicio] = useState('')
  const [horaFim, setHoraFim] = useState('')
  const [campanha, setCampanha] = useState('')

  useEffect(() => {
    callApi('filtros', {})
      .then((d) => setCampanhas(d?.[0]?.campanhas || []))
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const date_from = dataInicio ? new Date(dataInicio + 'T00:00:00').toISOString() : ''
    const date_to = dataFim ? new Date(dataFim + 'T23:59:59').toISOString() : ''
    try {
      const [kpiData, falhaData, templateData] = await Promise.all([
        callApi('hoje_kpis', { date_from, date_to, campanha, hora_inicio: horaInicio, hora_fim: horaFim }),
        callApi('falha_por_minuto', { minutos: '60', campanha }),
        callApi('por_template_hoje', { date_from, date_to, campanha }),
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
  }, [dataInicio, dataFim, campanha, horaInicio, horaFim])

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
        <div className="topbar-right">
          <span className="status-line">
            {loading ? 'atualizando...' : lastUpdate ? `atualizado \u00e0s ${fmtHora(lastUpdate)}` : ''}
          </span>
          <button className="reset-btn" onClick={() => { setCampanha(''); setDataInicio(todayISO()); setDataFim(todayISO()); setHoraInicio(''); setHoraFim('') }} title="Redefinir filtros">
            &#10226; Redefinir filtros
          </button>
          <button className="refresh-btn" onClick={load} disabled={loading} title="Atualizar agora">
            &#8635; Atualizar
          </button>
        </div>
      </div>

      <div className="filters">
        <CampanhaSearch value={campanha} onChange={setCampanha} options={campanhas} />
      </div>
      <DateRangeFilter dataInicio={dataInicio} setDataInicio={setDataInicio} dataFim={dataFim} setDataFim={setDataFim} />
      <HourFilter horaInicio={horaInicio} setHoraInicio={setHoraInicio} horaFim={horaFim} setHoraFim={setHoraFim} />

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
  const [horaInicio, setHoraInicio] = useState('')
  const [horaFim, setHoraFim] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [showFunil, setShowFunil] = useState(false)

  const args = useMemo(() => ({
    campanha: campanha || '',
    produto: produto || '',
    origem: origem || '',
    date_from: dataInicio ? new Date(dataInicio + 'T00:00:00').toISOString() : '',
    date_to: dataFim ? new Date(dataFim + 'T23:59:59').toISOString() : '',
    hora_inicio: horaInicio,
    hora_fim: horaFim,
  }), [campanha, produto, origem, dataInicio, dataFim, horaInicio, horaFim])

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
          <button className="reset-btn" onClick={() => { setCampanha(''); setProduto(''); setOrigem(''); setDataInicio(''); setDataFim(''); setHoraInicio(''); setHoraFim('') }} title="Redefinir filtros">
            &#10226; Redefinir filtros
          </button>
          <button className="refresh-btn" onClick={load} disabled={loading} title="Atualizar agora">
            &#8635; Atualizar
          </button>
          <button className="dots-btn" onClick={() => setShowFunil(true)} title="Funil de Entradas LP">
            &#8942;
          </button>
        </div>
      </div>

      <div className="filters">
        <CampanhaSearch value={campanha} onChange={setCampanha} options={filtros.campanhas} />
        <SearchSelect value={produto} onChange={setProduto} options={filtros.produtos} label="produto" allLabel="produto — todos" />
        <SearchSelect value={origem} onChange={setOrigem} options={filtros.origens} label="origem" allLabel="origem — todas" />
      </div>
      <DateRangeFilter dataInicio={dataInicio} setDataInicio={setDataInicio} dataFim={dataFim} setDataFim={setDataFim} />
      <HourFilter horaInicio={horaInicio} setHoraInicio={setHoraInicio} horaFim={horaFim} setHoraFim={setHoraFim} />

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

function FunilOverlay({ titulo, subtitulo, apiType, campanhaFiltroType, etapas, showProduto, onClose }) {
  const [dados, setDados] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filtros, setFiltros] = useState({ campanhas: [], origens: [], produtos: [] })
  const [dataInicio, setDataInicio] = useState(todayISO())
  const [dataFim, setDataFim] = useState(todayISO())
  const [campanha, setCampanha] = useState('')
  const [origem, setOrigem] = useState('')
  const [produto, setProduto] = useState('')

  useEffect(() => {
    callApi(campanhaFiltroType, {})
      .then((d) => setFiltros({
        campanhas: d?.[0]?.campanhas || [],
        origens: d?.[0]?.origens || [],
        produtos: d?.[0]?.produtos || [],
      }))
      .catch(() => {})
  }, [campanhaFiltroType])

  useEffect(() => {
    setLoading(true)
    setError(null)
    const date_from = dataInicio ? new Date(dataInicio + 'T00:00:00').toISOString() : ''
    const date_to = dataFim ? new Date(dataFim + 'T23:59:59').toISOString() : ''
    callApi(apiType, { date_from, date_to, campanha, origem, ...(showProduto ? { produto } : {}) })
      .then((d) => setDados(d?.[0] ?? null))
      .catch((e) => setError(e.message || 'Erro ao carregar funil.'))
      .finally(() => setLoading(false))
  }, [apiType, dataInicio, dataFim, campanha, origem, produto, showProduto])

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
          <CampanhaSearch value={campanha} onChange={setCampanha} options={filtros.campanhas} />
          <SearchSelect value={origem} onChange={setOrigem} options={filtros.origens} label="origem" allLabel="origem — todas" />
          {showProduto && (
            <SearchSelect value={produto} onChange={setProduto} options={filtros.produtos} label="produto" allLabel="produto — todos" />
          )}
        </div>
        <DateRangeFilter dataInicio={dataInicio} setDataInicio={setDataInicio} dataFim={dataFim} setDataFim={setDataFim} />

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
      showProduto
      onClose={onClose}
    />
  )
}

function fmtDuracao(seg) {
  const s = Number(seg) || 0
  if (s < 60) return `${s.toFixed(0)}s`
  if (s < 3600) return `${(s / 60).toFixed(1)} min`
  return `${(s / 3600).toFixed(1)} h`
}

function N8nExecucoes() {
  const [stats, setStats] = useState(null)
  const [workflows, setWorkflows] = useState([])
  const [workflowId, setWorkflowId] = useState('')
  const [dataInicio, setDataInicio] = useState(todayISO())
  const [dataFim, setDataFim] = useState(todayISO())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)

  useEffect(() => {
    callN8nApi('workflows', {})
      .then((list) => setWorkflows((list || []).map((w) => w.name)))
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const wfList = await callN8nApi('workflows', {})
      const found = wfList.find((w) => w.name === workflowId)
      const date_from = dataInicio ? new Date(dataInicio + 'T00:00:00').toISOString() : ''
      const date_to = dataFim ? new Date(dataFim + 'T23:59:59').toISOString() : ''
      const data = await callN8nApi('stats', {
        date_from,
        date_to,
        ...(found ? { workflowId: found.id } : {}),
      })
      setStats(data)
      setLastUpdate(new Date())
    } catch (e) {
      setError(e.message || 'Erro ao carregar dados do n8n.')
    } finally {
      setLoading(false)
    }
  }, [dataInicio, dataFim, workflowId])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  return (
    <>
      <div className="topbar">
        <h1><span className="pulse" /> n8n &mdash; Execu&ccedil;&otilde;es</h1>
        <div className="topbar-right">
          <span className="status-line">
            {loading ? 'atualizando...' : lastUpdate ? `atualizado \u00e0s ${fmtHora(lastUpdate)}` : ''}
          </span>
          <button className="reset-btn" onClick={() => { setWorkflowId(''); setDataInicio(todayISO()); setDataFim(todayISO()) }} title="Redefinir filtros">
            &#10226; Redefinir filtros
          </button>
          <button className="refresh-btn" onClick={load} disabled={loading} title="Atualizar agora">
            &#8635; Atualizar
          </button>
        </div>
      </div>

      <div className="filters">
        <SearchSelect value={workflowId} onChange={setWorkflowId} options={workflows} label="workflow" allLabel="workflow — todos" />
      </div>
      <DateRangeFilter dataInicio={dataInicio} setDataInicio={setDataInicio} dataFim={dataFim} setDataFim={setDataFim} />

      {error && <div className="state-msg error">Erro: {error}</div>}

      <div className="kpi-grid">
        <div className="kpi">
          <p className="kpi-label">Total{stats?.total_capped ? ' (parcial)' : ''}</p>
          <p className="kpi-value">{fmtInt(stats?.total)}{stats?.total_capped ? '+' : ''}</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Sucesso{stats?.success_capped ? ' (parcial)' : ''}</p>
          <p className="kpi-value accent">{fmtInt(stats?.success)}{stats?.success_capped ? '+' : ''}</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Erro{stats?.error_capped ? ' (parcial)' : ''}</p>
          <p className="kpi-value" style={{ color: '#d99089' }}>{fmtInt(stats?.error)}{stats?.error_capped ? '+' : ''}</p>
        </div>
        <div className="kpi"><p className="kpi-label">Pendentes</p><p className="kpi-value">{fmtInt(stats?.pending)}</p></div>
      </div>
      {(stats?.total_capped) && (
        <div className="state-msg" style={{ marginTop: -10, marginBottom: 14 }}>
          Volume muito alto pro per&iacute;odo escolhido &mdash; os n&uacute;meros com "+" s&atilde;o um piso (h&aacute; mais do que isso). Tente um intervalo menor pra ver o total exato.
        </div>
      )}
      <div className="kpi-grid">
        <div className="kpi"><p className="kpi-label">Tempo m&eacute;dio de execu&ccedil;&atilde;o</p><p className="kpi-value">{fmtDuracao(stats?.avg_duration_sec)}</p></div>
        <div className="kpi">
          <p className="kpi-label">Tempo m&eacute;dio pendente</p>
          <p className="kpi-value">{fmtDuracao(stats?.avg_pending_sec)}</p>
          <p className="kpi-sub" style={{ textAlign: 'left' }}>hist&oacute;rico acumulado &middot; {fmtInt(stats?.avg_pending_sample_size)} execu&ccedil;&otilde;es observadas</p>
        </div>
      </div>

      <div className="panel table-panel">
        <p className="section-label">Execu&ccedil;&otilde;es pendentes</p>
        <p className="section-sub">em espera ou rodando no momento &mdash; h&aacute; quanto tempo</p>
        <div className="template-row head" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          <span>ID</span><span>Status</span><span>Pendente h&aacute;</span>
        </div>
        {(!stats?.pending_list || stats.pending_list.length === 0) && !loading && (
          <div className="state-msg">Nenhuma execu&ccedil;&atilde;o pendente agora.</div>
        )}
        {(stats?.pending_list || []).map((p) => (
          <div className="template-row" key={p.id} style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
            <span>{p.id}</span>
            <span>{p.status}</span>
            <span className={p.elapsedSec > 600 ? 'falha-alta' : ''}>{fmtDuracao(p.elapsedSec)}</span>
          </div>
        ))}
      </div>
    </>
  )
}

const VENDEDOR_CORES = ['#d99089', '#d9b877', '#7fa8d9', '#8fd97f', '#c17fd9', '#d9d17f', '#7fd9c1', '#d97fa8']

function fmtMoeda(n) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n) || 0)
}

function fmtDataBR(d) {
  if (!d) return '-'
  const datePart = String(d).slice(0, 10) // sempre pega só "AAAA-MM-DD", mesmo se vier com hora
  const dt = new Date(datePart + 'T00:00:00')
  if (isNaN(dt.getTime())) return '-'
  return dt.toLocaleDateString('pt-BR')
}

function RankingOverlay({ onClose }) {
  const week = presetRange('este_mes') // padrão: mês corrente inteiro
  const [dataInicio, setDataInicio] = useState(week.from)
  const [dataFim, setDataFim] = useState(week.to)
  const [ranking, setRanking] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    // data_status é uma coluna "date" pura, sem hora/fuso — manda o texto
    // exatamente como está no campo (AAAA-MM-DD), sem converter pra ISO/UTC
    callApi('vendedoras_ranking', { date_from: dataInicio || '', date_to: dataFim || '' })
      .then((d) => setRanking(d ?? []))
      .catch((e) => setError(e.message || 'Erro ao carregar ranking.'))
      .finally(() => setLoading(false))
  }, [dataInicio, dataFim])

  return (
    <div className="funil-overlay" onClick={onClose}>
      <div className="funil-panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="funil-header">
          <div>
            <h2>Ranking de Vendedoras</h2>
            <p className="subtitle">Ordenado por valor total &middot; somente leitura</p>
          </div>
          <button className="funil-close" onClick={onClose}>&times;</button>
        </div>

        <DateRangeFilter dataInicio={dataInicio} setDataInicio={setDataInicio} dataFim={dataFim} setDataFim={setDataFim} />

        {error && <div className="state-msg error">Erro: {error}</div>}
        {loading && ranking.length === 0 && <div className="state-msg">Carregando...</div>}
        {!loading && ranking.length === 0 && !error && (
          <div className="state-msg">Nenhuma venda no per&iacute;odo selecionado.</div>
        )}

        <div className="ranking-list">
          {ranking.map((r, i) => (
            <div className="ranking-card" key={r.vendedor}>
              <span className="ranking-pos">{i + 1}&ordm;</span>
              <div className="ranking-info">
                <p className="ranking-nome">{r.vendedor}</p>
                <div className="ranking-stats">
                  <span><strong>{fmtMoeda(r.valor_total)}</strong> total</span>
                  <span>{fmtInt(r.qtd_total)} propostas</span>
                  <span>{r.banco_top || '-'} (banco mais usado)</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const AUTH_STORAGE_KEY = 'disparos_dashboard_auth'
const META_SEMANA = 100000

function LoginGate({ onLogin }) {
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState('')
  const [enviando, setEnviando] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (!senha.trim()) return
    setEnviando(true)
    setErro('')
    try {
      const data = await postApi('auth_login', { senha: senha.trim() })
      try { localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(data)) } catch { /* ignora */ }
      onLogin(data)
    } catch (e2) {
      setErro(e2.message || 'Senha incorreta.')
    } finally {
      setEnviando(false)
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <img src="/tiger-icon.png" alt="" className="login-logo" />
        <h2>Entrar</h2>
        <input
          type="password"
          value={senha}
          onChange={(e) => setSenha(e.target.value)}
          placeholder="Senha"
          autoFocus
        />
        {erro && <p className="login-error">{erro}</p>}
        <button type="submit" disabled={enviando}>{enviando ? 'Entrando...' : 'Entrar'}</button>
      </form>
    </div>
  )
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload
  if (!row) return null
  return (
    <div style={{ background: '#1b2620', border: '1px solid #263029', borderRadius: 8, fontFamily: 'IBM Plex Mono', fontSize: 12, padding: '8px 10px' }}>
      <p style={{ color: '#8a978f', margin: '0 0 4px' }}>{label}</p>
      {row.realizado != null && (
        <p style={{ margin: '2px 0', color: '#a9d97f' }}>Realizado: {fmtMoeda(row.realizado)}</p>
      )}
      {row.ehSemanaAtual && (
        <p style={{ margin: '2px 0', color: '#d9b877' }}>Proje&ccedil;&atilde;o do m&ecirc;s: {fmtMoeda(row.projecaoMesTotal)}</p>
      )}
      {!row.ehSemanaAtual && row.realizado == null && row.projecao != null && (
        <p style={{ margin: '2px 0', color: '#d9b877' }}>Proje&ccedil;&atilde;o: {fmtMoeda(row.projecao)}</p>
      )}
    </div>
  )
}

function MilestoneDot(props) {
  const { cx, cy, payload } = props
  if (cx == null || cy == null) return null
  if (!payload?.nivel) {
    // ponto normal, sem marco
    return <circle cx={cx} cy={cy} r={4} fill="#a9d97f" stroke="none" />
  }
  const tamanhos = [13, 17, 21, 26]
  const nivel = payload.nivel
  return (
    <g>
      <circle className="milestone-burst-svg" cx={cx} cy={cy} r={4} fill="none" />
      <circle cx={cx} cy={cy} r={5} fill="#d9b877" stroke="#16211b" strokeWidth={1.5} />
      <text
        x={cx}
        y={cy - 14}
        textAnchor="middle"
        fontSize={tamanhos[Math.min(nivel, 4) - 1]}
        fontWeight={600}
        fill="#d9b877"
        fontFamily="IBM Plex Mono, monospace"
      >
        N&iacute;vel {nivel}
      </text>
    </g>
  )
}

function VendedoraPortal({ vendedor, onLogout }) {
  const week = presetRange('este_mes') // padrão: mês corrente inteiro
  const [kpis, setKpis] = useState(null)
  const [meta, setMeta] = useState(null)
  const [semanas, setSemanas] = useState([])
  const [tabela, setTabela] = useState({ rows: [], total: 0 })
  const [page, setPage] = useState(0)
  const [dataInicio, setDataInicio] = useState(week.from)
  const [dataFim, setDataFim] = useState(week.to)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)

  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ adesao: '', cpf: '', nome: '', valor: '', banco: '' })
  const [addMsg, setAddMsg] = useState('')
  const [adding, setAdding] = useState(false)

  const { limit, offset } = useMemo(() => {
    if (page === 0) return { limit: 10, offset: 0 }
    if (page === 1) return { limit: 40, offset: 0 }
    return { limit: 30, offset: 40 + (page - 2) * 30 }
  }, [page])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const date_from = dataInicio || ''
    const date_to = dataFim || ''
    try {
      const [kv, mt, sm, tab] = await Promise.all([
        callApi('vendedoras_kpis_vendedor', { vendedor, date_from, date_to }),
        callApi('vendedoras_meta', { vendedor }),
        callApi('vendedoras_semanas_mes', { vendedor }),
        callApi('vendedoras_tabela', { vendedor, date_from, date_to, limit: String(limit), offset: String(offset) }),
      ])
      setKpis(kv?.[0] ?? null)
      setMeta(mt?.[0] ?? null)
      setSemanas(sm ?? [])
      setTabela({ rows: tab ?? [], total: tab?.[0]?.total_count ? Number(tab[0].total_count) : 0 })
      setLastUpdate(new Date())
    } catch (e) {
      setError(e.message || 'Erro ao carregar dados.')
    } finally {
      setLoading(false)
    }
  }, [vendedor, dataInicio, dataFim, limit, offset])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  // monta os dois pontos do gráfico: realizado (acumulado, s\u00f3 semanas
  // passadas) e proje\u00e7\u00e3o (linha tracejada da \u00faltima semana real at\u00e9 o
  // total projetado, na \u00faltima semana do m\u00eas)
  const chartData = useMemo(() => {
    if (!semanas.length) return []
    const hoje = todayISO()
    let acumulado = 0
    let marcosBatidos = 0
    // "iniciada" = a semana j\u00e1 come\u00e7ou (mesmo que ainda n\u00e3o tenha terminado)
    // \u2014 o valor_semana dela j\u00e1 reflete s\u00f3 os dias que realmente aconteceram,
    // ent\u00e3o conta como realizado at\u00e9 agora, n\u00e3o como proje\u00e7\u00e3o
    const semanasIniciadas = semanas.filter((s) => s.inicio.slice(0, 10) <= hoje)
    const ultimaIniciada = semanasIniciadas[semanasIniciadas.length - 1]
    const projecaoFinal = meta ? Number(meta.projecao_mes) : 0

    return semanas.map((s) => {
      const valor = Number(s.valor_semana) || 0
      const iniciada = s.inicio.slice(0, 10) <= hoje
      if (iniciada) acumulado += valor
      const row = { semana: s.semana_label }
      let nivel = null
      if (valor >= META_SEMANA && s.passada && marcosBatidos < 4) {
        marcosBatidos += 1
        nivel = marcosBatidos
      }
      if (iniciada) {
        row.realizado = acumulado
        row.nivel = nivel
        // ponto de conex\u00e3o: a \u00faltima semana real tamb\u00e9m entra na s\u00e9rie de
        // proje\u00e7\u00e3o, pra linha ficar visualmente cont\u00ednua (sem quebra) \u2014 mas o
        // tooltip mostra a proje\u00e7\u00e3o de verdade (projecaoMesTotal), n\u00e3o esse valor
        if (s.semana === ultimaIniciada?.semana) {
          row.projecao = acumulado
          row.ehSemanaAtual = true
          row.projecaoMesTotal = projecaoFinal
        }
      } else if (ultimaIniciada) {
        // interpola linearmente da \u00faltima semana real at\u00e9 a proje\u00e7\u00e3o final
        // (valor absoluto, nunca somado por cima do realizado)
        const totalSemanas = semanas.length
        const semanasRestantes = totalSemanas - ultimaIniciada.semana
        const passo = semanasRestantes > 0 ? (projecaoFinal - acumuladoAteUltima(semanas, ultimaIniciada, hoje)) / semanasRestantes : 0
        row.projecao = acumuladoAteUltima(semanas, ultimaIniciada, hoje) + passo * (s.semana - ultimaIniciada.semana)
      }
      return row
    })
  }, [semanas, meta])

  function acumuladoAteUltima(lista, ultima, hoje) {
    let soma = 0
    for (const s of lista) {
      if (s.semana <= ultima.semana) soma += Number(s.valor_semana) || 0
    }
    return soma
  }

  const handleAdd = async (e) => {
    e.preventDefault()
    setAdding(true)
    setAddMsg('')
    try {
      const result = await postApi('vendedoras_add_venda', {
        vendedor,
        adesao: addForm.adesao,
        cpf: addForm.cpf,
        nome: addForm.nome,
        valor: addForm.valor.replace(',', '.'),
        banco: addForm.banco,
      })
      const r = result?.[0]
      if (r?.ok) {
        setAddMsg('Venda adicionada. Sincronizando...')
        setAddForm({ adesao: '', cpf: '', nome: '', valor: '', banco: '' })
        await callApi('vendedoras_sync', {})
        await load()
        setAddMsg('Conclu\u00eddo!')
        setTimeout(() => { setShowAdd(false); setAddMsg('') }, 1500)
      } else {
        setAddMsg(r?.mensagem || 'N\u00e3o foi poss\u00edvel adicionar.')
      }
    } catch (e2) {
      setAddMsg('Erro: ' + (e2.message || ''))
    } finally {
      setAdding(false)
    }
  }

  const semanasBatidas = semanas.filter((s) => Number(s.valor_semana) >= META_SEMANA && s.passada)
  const podeExpandir = page === 0 && tabela.total > 10
  const podeProximaPagina = page >= 1 && offset + limit < tabela.total
  const podePaginaAnterior = page >= 2

  return (
    <div className="app">
      <div className="app-header">
        <img src="/tiger-icon.png" alt="" className="app-logo" />
        <div className="view-switcher-btn" style={{ cursor: 'default' }}>{vendedor}</div>
        <button className="reset-btn" onClick={onLogout} title="Sair" style={{ marginLeft: 'auto' }}>Sair</button>
      </div>

      <div className="topbar">
        <h1><span className="pulse" /> Minhas Vendas</h1>
        <div className="topbar-right">
          <span className="status-line">
            {loading ? 'atualizando...' : lastUpdate ? `atualizado \u00e0s ${fmtHora(lastUpdate)}` : ''}
          </span>
          <button className="reset-btn" onClick={() => { setDataInicio(week.from); setDataFim(week.to) }} title="Redefinir filtros">
            &#10226; Redefinir filtros
          </button>
          <button className="refresh-btn" onClick={() => setShowAdd(true)} title="Adicionar adesão">
            + Adicionar adesão
          </button>
          <button className="refresh-btn" onClick={load} disabled={loading} title="Atualizar agora">
            &#8635; Atualizar
          </button>
        </div>
      </div>

      <DateRangeFilter dataInicio={dataInicio} setDataInicio={setDataInicio} dataFim={dataFim} setDataFim={setDataFim} />

      {error && <div className="state-msg error">Erro: {error}</div>}

      <div className="panel chart-panel tall">
        <p className="section-label">Vendas por semana &mdash; meta e proje&ccedil;&atilde;o</p>
        <p className="section-sub">meta de {fmtMoeda(META_SEMANA)}/semana &middot; linha tracejada = proje&ccedil;&atilde;o do m&ecirc;s</p>
        <ResponsiveContainer width="100%" height="65%">
          <ComposedChart data={chartData} margin={{ top: 26, right: 10, left: 0, bottom: 0 }}>
            <XAxis dataKey="semana" tick={{ fontSize: 10, fill: '#8a978f' }} />
            <YAxis tick={{ fontSize: 10, fill: '#8a978f' }} width={50} />
            <Tooltip content={<ChartTooltip />} />
            <Line type="monotone" dataKey="realizado" stroke="#a9d97f" strokeWidth={2.5} dot={<MilestoneDot />} connectNulls />
            <Line type="monotone" dataKey="projecao" stroke="#a9d97f" strokeOpacity={0.4} strokeDasharray="5 5" strokeWidth={2} dot={{ r: 3, fillOpacity: 0.4, fill: '#a9d97f' }} connectNulls legendType="none" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="kpi-grid kpi-grid-3">
        <div className="kpi"><p className="kpi-label">Maior venda</p><p className="kpi-value">{fmtMoeda(kpis?.maior_venda)}</p></div>
        <div className="kpi"><p className="kpi-label">Dia com mais vendas</p><p className="kpi-value" style={{ fontSize: 16 }}>{kpis?.dia_mais_vendas ? fmtDataBR(kpis.dia_mais_vendas) : '-'}</p><p className="kpi-sub">{fmtInt(kpis?.dia_mais_vendas_qtd)} vendas</p></div>
        <div className="kpi">
          <p className="kpi-label">Valor total vendido</p>
          <p className="kpi-value kpi-split"><span>{fmtMoeda(kpis?.valor_total)}</span><span className="kpi-split-bar">|</span><span className="kpi-split-proj">{fmtMoeda(meta?.projecao_mes)}</span></p>
          <p className="kpi-sub">realizado | proje&ccedil;&atilde;o do m&ecirc;s</p>
        </div>
        <div className="kpi"><p className="kpi-label">Quantidade total</p><p className="kpi-value">{fmtInt(kpis?.qtd_total)}</p></div>
        <div className="kpi"><p className="kpi-label">Banco mais vendido</p><p className="kpi-value" style={{ fontSize: 16 }}>{kpis?.banco_top || '-'}</p><p className="kpi-sub">{fmtInt(kpis?.banco_top_qtd)} vendas</p></div>
        <div className="kpi"><p className="kpi-label">Semanas com meta batida</p><p className="kpi-value">{fmtInt(semanasBatidas.length)}</p></div>
        {semanasBatidas.slice(0, 3).map((s) => (
          <div className="kpi" key={s.semana}><p className="kpi-label">Semana {s.semana_label}</p><p className="kpi-value" style={{ fontSize: 16 }}>{fmtMoeda(s.valor_semana)}</p></div>
        ))}
      </div>

      <div className="panel table-panel">
        <p className="section-label">Minhas vendas ({fmtInt(tabela.total)})</p>
        <div className="template-row head" style={{ gridTemplateColumns: '1fr 1fr 1fr 0.8fr' }}>
          <span>Valor</span><span>CPF</span><span>Banco</span><span>Data</span>
        </div>
        {tabela.rows.length === 0 && !loading && (
          <div className="state-msg">Nenhuma venda encontrada para os filtros selecionados.</div>
        )}
        {tabela.rows.map((r, i) => (
          <div className="template-row" key={i} style={{ gridTemplateColumns: '1fr 1fr 1fr 0.8fr' }}>
            <span>{fmtMoeda(r.valor)}</span>
            <span>{r.cpf}</span>
            <span>{r.banco || '-'}</span>
            <span>{fmtDataBR(r.dia)}</span>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          {podeExpandir && (
            <button className="expand-btn" onClick={() => setPage(1)}>Mostrar mais (+30)</button>
          )}
          {page >= 1 && (
            <>
              <button className="expand-btn" onClick={() => setPage(0)}>Recolher</button>
              {podePaginaAnterior && (
                <button className="expand-btn" onClick={() => setPage((p) => p - 1)}>&larr; P&aacute;gina anterior</button>
              )}
              {podeProximaPagina && (
                <button className="expand-btn" onClick={() => setPage((p) => p + 1)}>Pr&oacute;xima p&aacute;gina &rarr;</button>
              )}
            </>
          )}
        </div>
      </div>

      {showAdd && (
        <div className="funil-overlay" onClick={() => setShowAdd(false)}>
          <div className="funil-panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="funil-header">
              <div><h2>Adicionar ades&atilde;o</h2></div>
              <button className="funil-close" onClick={() => setShowAdd(false)}>&times;</button>
            </div>
            <form className="add-venda-form" onSubmit={handleAdd}>
              <label>Ades&atilde;o<input required value={addForm.adesao} onChange={(e) => setAddForm({ ...addForm, adesao: e.target.value })} /></label>
              <label>CPF<input required value={addForm.cpf} onChange={(e) => setAddForm({ ...addForm, cpf: e.target.value })} /></label>
              <label>Nome<input required value={addForm.nome} onChange={(e) => setAddForm({ ...addForm, nome: e.target.value })} /></label>
              <label>Valor<input required value={addForm.valor} onChange={(e) => setAddForm({ ...addForm, valor: e.target.value })} placeholder="0,00" /></label>
              <label>Banco<input required value={addForm.banco} onChange={(e) => setAddForm({ ...addForm, banco: e.target.value })} /></label>
              {addMsg && <p className="state-msg" style={{ margin: '4px 0' }}>{addMsg}</p>}
              <button type="submit" className="refresh-btn" disabled={adding}>{adding ? 'Enviando...' : 'Adicionar'}</button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

function VendedorasView() {
  const week = presetRange('este_mes') // padrão: mês corrente inteiro
  const [vendedores, setVendedores] = useState([])
  const [vendedor, setVendedor] = useState('')
  const [dataInicio, setDataInicio] = useState(week.from)
  const [dataFim, setDataFim] = useState(week.to)

  const [kpisGeral, setKpisGeral] = useState(null)
  const [kpisVendedor, setKpisVendedor] = useState(null)
  const [porDia, setPorDia] = useState({ rows: [], vendedoresVistos: [] })
  const [tabela, setTabela] = useState({ rows: [], total: 0 })
  const [page, setPage] = useState(0) // 0 = 10 itens, 1 = 40 itens, 2+ = pagina de 30 depois dos 40

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [showRanking, setShowRanking] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const fileInputRef = useRef(null)

  useEffect(() => {
    callApi('vendedoras_filtros', {})
      .then((d) => setVendedores(d?.[0]?.vendedores || []))
      .catch(() => {})
  }, [])

  useEffect(() => { setPage(0) }, [vendedor, dataInicio, dataFim])

  const { limit, offset } = useMemo(() => {
    if (page === 0) return { limit: 10, offset: 0 }
    if (page === 1) return { limit: 40, offset: 0 }
    return { limit: 30, offset: 40 + (page - 2) * 30 }
  }, [page])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    // data_status é uma coluna "date" pura, sem hora/fuso — manda o texto
    // exatamente como está no campo (AAAA-MM-DD), sem converter pra ISO/UTC
    const date_from = dataInicio || ''
    const date_to = dataFim || ''
    try {
      const [dia, tab] = await Promise.all([
        callApi('vendedoras_por_dia', { vendedor, date_from, date_to }),
        callApi('vendedoras_tabela', { vendedor, date_from, date_to, limit: String(limit), offset: String(offset) }),
      ])

      const porDiaMap = {}
      const vendedoresVistos = new Set()
      for (const row of dia ?? []) {
        vendedoresVistos.add(row.vendedor)
        if (!porDiaMap[row.dia]) porDiaMap[row.dia] = { dia: row.dia }
        porDiaMap[row.dia][row.vendedor] = Number(row.vendas)
        porDiaMap[row.dia][`${row.vendedor}__valor`] = Number(row.valor_total)
      }
      setPorDia({
        rows: Object.values(porDiaMap).sort((a, b) => (a.dia > b.dia ? 1 : -1)),
        vendedoresVistos: Array.from(vendedoresVistos),
      })

      setTabela({ rows: tab ?? [], total: tab?.[0]?.total_count ? Number(tab[0].total_count) : 0 })

      if (vendedor) {
        const kv = await callApi('vendedoras_kpis_vendedor', { vendedor, date_from, date_to })
        setKpisVendedor(kv?.[0] ?? null)
        setKpisGeral(null)
      } else {
        const kg = await callApi('vendedoras_kpis_geral', { date_from, date_to })
        setKpisGeral(kg?.[0] ?? null)
        setKpisVendedor(null)
      }

      setLastUpdate(new Date())
    } catch (e) {
      setError(e.message || 'Erro ao carregar dados.')
    } finally {
      setLoading(false)
    }
  }, [vendedor, dataInicio, dataFim, limit, offset])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  const handleSync = async () => {
    setSyncing(true)
    setSyncMsg('')
    try {
      const r = await callApi('vendedoras_sync', {})
      const s = r?.[0]
      setSyncMsg(
        s
          ? `Conclu\u00eddo \u2014 ${fmtInt(s.atualizados_vendedoras)} vendedoras com dados completos, ${fmtInt(s.atualizados_disparochat)} atualizadas em disparochat, ${fmtInt(s.atualizados_total_produtos)} em total_produtos, ${fmtInt(s.atualizados_leads_chatwoot)} em leads_chatwoot.`
          : 'Sincroniza\u00e7\u00e3o conclu\u00edda.'
      )
      load()
    } catch (e) {
      setSyncMsg('Erro ao sincronizar: ' + (e.message || ''))
    } finally {
      setSyncing(false)
    }
  }

  const handleImportClick = () => fileInputRef.current?.click()

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // permite selecionar o mesmo arquivo de novo depois
    if (!file) return
    setImporting(true)
    setImportMsg('')
    try {
      const rows = await parseVendedorasCsv(file)
      if (rows.length === 0) {
        setImportMsg('Nenhuma linha v\u00e1lida encontrada no arquivo.')
        return
      }
      const result = await postApi('vendedoras_import', { rows })
      const r = result?.[0]
      setImportMsg(
        `Importa\u00e7\u00e3o conclu\u00edda \u2014 ${fmtInt(r?.inseridos)} vendas novas adicionadas, ${fmtInt(r?.ignorados)} j\u00e1 existiam (mesmo CPF + ades\u00e3o) e foram ignoradas. Sincronizando...`
      )
      await handleSync()
    } catch (err) {
      setImportMsg('Erro ao importar: ' + (err.message || ''))
    } finally {
      setImporting(false)
    }
  }

  const totalPaginas = tabela.total > 40 ? 2 + Math.ceil((tabela.total - 40) / 30) - 1 : 1
  const podeExpandir = page === 0 && tabela.total > 10
  const podeProximaPagina = page >= 1 && offset + limit < tabela.total
  const podePaginaAnterior = page >= 2

  return (
    <>
      <div className="topbar">
        <h1><span className="pulse" /> Vendedoras</h1>
        <div className="topbar-right">
          <span className="status-line">
            {loading ? 'atualizando...' : lastUpdate ? `atualizado \u00e0s ${fmtHora(lastUpdate)}` : ''}
          </span>
          <button className="reset-btn" onClick={() => { setVendedor(''); setDataInicio(week.from); setDataFim(week.to) }} title="Redefinir filtros">
            &#10226; Redefinir filtros
          </button>
          <button className="dots-btn" onClick={() => setShowRanking(true)} title="Ranking de Vendedoras">
            &#8942;
          </button>
          <input
            type="file"
            accept=".csv"
            ref={fileInputRef}
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
          <button className="refresh-btn" onClick={handleImportClick} disabled={importing} title="Importar vendas de um arquivo CSV">
            {importing ? 'Importando...' : '\u2191 Importar'}
          </button>
          <button className="refresh-btn" onClick={handleSync} disabled={syncing} title="Cruzar CPFs com disparochat/total_produtos/leads_chatwoot e reconciliar pagamentos">
            {syncing ? 'Sincronizando...' : '\u21bb Sincronizar'}
          </button>
          <button className="refresh-btn" onClick={load} disabled={loading} title="Atualizar agora">
            &#8635; Atualizar
          </button>
        </div>
      </div>

      {importMsg && <div className="state-msg" style={{ marginBottom: 10 }}>{importMsg}</div>}
      {syncMsg && <div className="state-msg" style={{ marginBottom: 10 }}>{syncMsg}</div>}

      <div className="filters">
        <SearchSelect value={vendedor} onChange={setVendedor} options={vendedores} label="vendedor" allLabel="vendedor — todas" />
      </div>
      <DateRangeFilter dataInicio={dataInicio} setDataInicio={setDataInicio} dataFim={dataFim} setDataFim={setDataFim} />

      {error && <div className="state-msg error">Erro: {error}</div>}

      <div className="panel chart-panel">
        <p className="section-label">Vendas por dia</p>
        <ResponsiveContainer width="100%" height="80%">
          <BarChart data={porDia.rows}>
            <XAxis dataKey="dia" tick={{ fontSize: 10, fill: '#8a978f' }} tickFormatter={fmtDataBR} />
            <Tooltip
              contentStyle={{ background: '#1b2620', border: '1px solid #263029', borderRadius: 8, fontFamily: 'IBM Plex Mono', fontSize: 12 }}
              labelStyle={{ color: '#8a978f', marginBottom: 4 }}
              labelFormatter={fmtDataBR}
              formatter={(value, name, item) => {
                const valor = item?.payload?.[`${name}__valor`]
                return [`${fmtInt(value)} vendas${valor != null ? ` (${fmtMoeda(valor)})` : ''}`, name]
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'IBM Plex Mono' }} />
            {porDia.vendedoresVistos.map((v, i) => (
              <Bar key={v} dataKey={v} stackId="a" fill={VENDEDOR_CORES[i % VENDEDOR_CORES.length]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      {!vendedor && (
        <div className="kpi-grid">
          <div className="kpi"><p className="kpi-label">Vendedora com mais vendas</p><p className="kpi-value" style={{ fontSize: 16 }}>{kpisGeral?.top_qtd_vendedor || '-'}</p><p className="kpi-sub">{fmtInt(kpisGeral?.top_qtd_valor)} vendas</p></div>
          <div className="kpi"><p className="kpi-label">Vendedora com maior valor</p><p className="kpi-value" style={{ fontSize: 16 }}>{kpisGeral?.top_valor_vendedor || '-'}</p><p className="kpi-sub">{fmtMoeda(kpisGeral?.top_valor_valor)}</p></div>
          <div className="kpi"><p className="kpi-label">Banco mais utilizado</p><p className="kpi-value" style={{ fontSize: 16 }}>{kpisGeral?.banco_top || '-'}</p><p className="kpi-sub">{fmtInt(kpisGeral?.banco_top_qtd)} vendas</p></div>
          <div className="kpi"><p className="kpi-label">Dia com maior valor</p><p className="kpi-value" style={{ fontSize: 16 }}>{kpisGeral?.dia_maior_valor ? fmtDataBR(kpisGeral.dia_maior_valor) : '-'}</p><p className="kpi-sub">{fmtMoeda(kpisGeral?.dia_maior_valor_total)}</p></div>
        </div>
      )}
      {vendedor && (
        <div className="kpi-grid">
          <div className="kpi"><p className="kpi-label">Maior venda</p><p className="kpi-value">{fmtMoeda(kpisVendedor?.maior_venda)}</p></div>
          <div className="kpi"><p className="kpi-label">Dia com mais vendas</p><p className="kpi-value" style={{ fontSize: 16 }}>{kpisVendedor?.dia_mais_vendas ? fmtDataBR(kpisVendedor.dia_mais_vendas) : '-'}</p><p className="kpi-sub">{fmtInt(kpisVendedor?.dia_mais_vendas_qtd)} vendas</p></div>
          <div className="kpi"><p className="kpi-label">Valor total vendido</p><p className="kpi-value">{fmtMoeda(kpisVendedor?.valor_total)}</p></div>
          <div className="kpi"><p className="kpi-label">Quantidade total</p><p className="kpi-value">{fmtInt(kpisVendedor?.qtd_total)}</p></div>
        </div>
      )}

      <div className="panel table-panel">
        <p className="section-label">Vendas ({fmtInt(tabela.total)})</p>
        <div className="template-row head" style={{ gridTemplateColumns: '1.2fr 0.9fr 1fr 1fr 0.8fr 0.6fr' }}>
          <span>Vendedor</span><span>Valor</span><span>CPF</span><span>Banco</span><span>Data</span><span>Conversa</span>
        </div>
        {tabela.rows.length === 0 && !loading && (
          <div className="state-msg">Nenhuma venda encontrada para os filtros selecionados.</div>
        )}
        {tabela.rows.map((r, i) => (
          <div className="template-row" key={i} style={{ gridTemplateColumns: '1.2fr 0.9fr 1fr 1fr 0.8fr 0.6fr' }}>
            <span className="campanha-nome">{r.vendedor}</span>
            <span>{fmtMoeda(r.valor)}</span>
            <span>{r.cpf}</span>
            <span>{r.banco || '-'}</span>
            <span>{fmtDataBR(r.dia)}</span>
            <span>
              {r.covnersation_id ? (
                <a
                  href={
                    r.conversa_sistema === 'chatwoot'
                      ? `https://chatwoot.querosacarfgts.com.br/app/accounts/1/conversations/${r.covnersation_id}`
                      : `https://crm.vendeaitecnologia.com.br/app/accounts/75/conversations/${r.covnersation_id}`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="conversa-link"
                >
                  Abrir &#8599;
                </a>
              ) : '-'}
            </span>
          </div>
        ))}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          {podeExpandir && (
            <button className="expand-btn" onClick={() => setPage(1)}>Mostrar mais (+30)</button>
          )}
          {page >= 1 && (
            <>
              <button className="expand-btn" onClick={() => setPage(0)}>Recolher</button>
              {podePaginaAnterior && (
                <button className="expand-btn" onClick={() => setPage((p) => p - 1)}>&larr; P&aacute;gina anterior</button>
              )}
              {podeProximaPagina && (
                <button className="expand-btn" onClick={() => setPage((p) => p + 1)}>Pr&oacute;xima p&aacute;gina &rarr;</button>
              )}
            </>
          )}
        </div>
      </div>

      {showRanking && <RankingOverlay onClose={() => setShowRanking(false)} />}
    </>
  )
}

const VENDAS_CORES = ['#a9d97f', '#d99089', '#7fa8d9', '#d9b877', '#c17fd9', '#7fd9c1']

function VendasView() {
  const mesAtual = presetRange('este_mes')
  const [dataInicio, setDataInicio] = useState(mesAtual.from)
  const [dataFim, setDataFim] = useState(mesAtual.to)

  const [kpis, setKpis] = useState(null)
  const [porProduto, setPorProduto] = useState([])
  const [diasMes, setDiasMes] = useState([])
  const [porCampanha, setPorCampanha] = useState([])
  const [porOrigem, setPorOrigem] = useState([])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const fileInputRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [kp, pp, dm, pc, po] = await Promise.all([
        callApi('vendas_kpis', { date_from: dataInicio, date_to: dataFim }),
        callApi('vendas_por_produto', { date_from: dataInicio, date_to: dataFim }),
        callApi('vendas_dias_mes', {}),
        callApi('vendas_por_campanha', { date_from: dataInicio, date_to: dataFim }),
        callApi('vendas_por_origem', { date_from: dataInicio, date_to: dataFim }),
      ])
      setKpis(kp?.[0] ?? null)
      setPorProduto(pp ?? [])
      setDiasMes(dm ?? [])
      setPorCampanha(pc ?? [])
      setPorOrigem(po ?? [])
      setLastUpdate(new Date())
    } catch (e) {
      setError(e.message || 'Erro ao carregar dados.')
    } finally {
      setLoading(false)
    }
  }, [dataInicio, dataFim])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  // gr\u00e1fico realizado x proje\u00e7\u00e3o, dia a dia do m\u00eas corrente (igual ao
  // portal da vendedora, s\u00f3 que sem os n\u00edveis de marco)
  const chartData = useMemo(() => {
    if (!diasMes.length) return []
    const hoje = todayISO()
    let acumulado = 0
    const diasIniciados = diasMes.filter((d) => d.dia.slice(0, 10) <= hoje)
    const ultimoIniciado = diasIniciados[diasIniciados.length - 1]
    const projecaoFinal = kpis ? Number(kpis.projecao_mes) : 0

    return diasMes.map((d, i) => {
      const valor = Number(d.valor_dia) || 0
      const iniciado = d.dia.slice(0, 10) <= hoje
      if (iniciado) acumulado += valor
      const row = { dia: fmtDataBR(d.dia) }
      if (iniciado) {
        row.realizado = acumulado
        const ultimoIdx = diasMes.indexOf(ultimoIniciado)
        if (i === ultimoIdx) {
          row.projecao = acumulado
          row.ehAtual = true
          row.projecaoMesTotal = projecaoFinal
        }
      } else if (ultimoIniciado) {
        const ultimoIdx = diasMes.indexOf(ultimoIniciado)
        const acumuladoUltimo = diasMes.slice(0, ultimoIdx + 1).reduce((s, x) => s + (Number(x.valor_dia) || 0), 0)
        const diasRestantes = diasMes.length - 1 - ultimoIdx
        const passo = diasRestantes > 0 ? (projecaoFinal - acumuladoUltimo) / diasRestantes : 0
        row.projecao = acumuladoUltimo + passo * (i - ultimoIdx)
      }
      return row
    })
  }, [diasMes, kpis])

  const handleSync = async () => {
    setSyncing(true)
    setSyncMsg('')
    try {
      const r = await callApi('vendas_sync', {})
      const s = r?.[0]
      setSyncMsg(
        s
          ? `Conclu\u00eddo \u2014 ${fmtInt(s.atualizados_vendas)} vendas com dados completos, ${fmtInt(s.atualizados_disparochat)} atualizadas em disparochat, ${fmtInt(s.atualizados_total_produtos)} em total_produtos, ${fmtInt(s.atualizados_leads_chatwoot)} em leads_chatwoot.`
          : 'Sincroniza\u00e7\u00e3o conclu\u00edda.'
      )
      load()
    } catch (e) {
      setSyncMsg('Erro ao sincronizar: ' + (e.message || ''))
    } finally {
      setSyncing(false)
    }
  }

  const handleImportClick = () => fileInputRef.current?.click()

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImporting(true)
    setImportMsg('')
    try {
      const rows = await parseVendasCsv(file)
      if (rows.length === 0) {
        setImportMsg('Nenhuma linha v\u00e1lida encontrada no arquivo.')
        return
      }
      const result = await postApi('vendas_import', { rows })
      const r = result?.[0]
      setImportMsg(
        `Importa\u00e7\u00e3o conclu\u00edda \u2014 ${fmtInt(r?.inseridos)} vendas novas, ${fmtInt(r?.ignorados)} j\u00e1 existiam (mesmo CPF + ades\u00e3o). Sincronizando...`
      )
      await handleSync()
    } catch (err) {
      setImportMsg('Erro ao importar: ' + (err.message || ''))
    } finally {
      setImporting(false)
    }
  }

  const handleDownload = () => {
    const qs = new URLSearchParams({ type: 'vendas_export', date_from: dataInicio, date_to: dataFim })
    window.open(`/api/dashboard?${qs.toString()}`, '_blank')
  }

  return (
    <>
      <div className="topbar">
        <h1><span className="pulse" /> Vendas</h1>
        <div className="topbar-right">
          <span className="status-line">
            {loading ? 'atualizando...' : lastUpdate ? `atualizado \u00e0s ${fmtHora(lastUpdate)}` : ''}
          </span>
          <button className="reset-btn" onClick={() => { setDataInicio(mesAtual.from); setDataFim(mesAtual.to) }} title="Redefinir filtros">
            &#10226; Redefinir filtros
          </button>
          <input type="file" accept=".csv" ref={fileInputRef} onChange={handleFileChange} style={{ display: 'none' }} />
          <button className="refresh-btn" onClick={handleImportClick} disabled={importing} title="Importar vendas de um arquivo CSV">
            {importing ? 'Importando...' : '\u2191 Importar'}
          </button>
          <button className="refresh-btn" onClick={handleDownload} title="Baixar tabela filtrada em CSV">
            &#8595; Baixar
          </button>
          <button className="refresh-btn" onClick={handleSync} disabled={syncing} title="Cruzar CPFs com disparochat/total_produtos/leads_chatwoot e reconciliar pagamentos">
            {syncing ? 'Sincronizando...' : '\u21bb Sincronizar'}
          </button>
          <button className="refresh-btn" onClick={load} disabled={loading} title="Atualizar agora">
            &#8635; Atualizar
          </button>
        </div>
      </div>

      {importMsg && <div className="state-msg" style={{ marginBottom: 10 }}>{importMsg}</div>}
      {syncMsg && <div className="state-msg" style={{ marginBottom: 10 }}>{syncMsg}</div>}

      <DateRangeFilter dataInicio={dataInicio} setDataInicio={setDataInicio} dataFim={dataFim} setDataFim={setDataFim} />

      {error && <div className="state-msg error">Erro: {error}</div>}

      <div className="panel chart-panel tall">
        <p className="section-label">Vendas por dia &mdash; realizado e proje&ccedil;&atilde;o</p>
        <p className="section-sub">linha tracejada = proje&ccedil;&atilde;o do m&ecirc;s (m&ecirc;s corrente, independente do filtro de data acima)</p>
        <ResponsiveContainer width="100%" height="80%">
          <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <XAxis dataKey="dia" tick={{ fontSize: 9, fill: '#8a978f' }} interval={2} />
            <YAxis tick={{ fontSize: 10, fill: '#8a978f' }} width={50} />
            <Tooltip content={<ChartTooltip />} />
            <Line type="monotone" dataKey="realizado" stroke="#a9d97f" strokeWidth={2.5} dot={false} connectNulls />
            <Line type="monotone" dataKey="projecao" stroke="#a9d97f" strokeOpacity={0.4} strokeDasharray="5 5" strokeWidth={2} dot={false} connectNulls legendType="none" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="kpi-grid">
        <div className="kpi">
          <p className="kpi-label">Valor total | Qtd total</p>
          <p className="kpi-value kpi-split"><span>{fmtMoeda(kpis?.valor_total)}</span><span className="kpi-split-bar">|</span><span className="kpi-split-proj">{fmtInt(kpis?.qtd_total)}</span></p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Hoje | Proje&ccedil;&atilde;o do m&ecirc;s</p>
          <p className="kpi-value kpi-split"><span>{fmtMoeda(kpis?.valor_hoje)}</span><span className="kpi-split-bar">|</span><span className="kpi-split-proj">{fmtMoeda(kpis?.projecao_mes)}</span></p>
        </div>
      </div>

      <div className="kpi-grid">
        {porProduto.map((p, i) => (
          <div className="kpi" key={p.produto}>
            <p className="kpi-label">{p.produto}</p>
            <p className="kpi-value" style={{ color: VENDAS_CORES[i % VENDAS_CORES.length] }}>{fmtMoeda(p.valor_total)}</p>
            <p className="kpi-sub">{fmtInt(p.qtd_total)} vendas</p>
          </div>
        ))}
      </div>

      <div className="panel table-panel">
        <p className="section-label">Por campanha</p>
        <div className="template-row head" style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
          <span>Campanha</span><span>Qtd</span><span>Valor</span>
        </div>
        {porCampanha.length === 0 && !loading && <div className="state-msg">Nenhum dado encontrado.</div>}
        {porCampanha.map((r, i) => (
          <div className="template-row" key={i} style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
            <span className="campanha-nome">{r.campanha}</span>
            <span>{fmtInt(r.qtd)}</span>
            <span>{fmtMoeda(r.valor)}</span>
          </div>
        ))}
      </div>

      <div className="panel table-panel">
        <p className="section-label">Por origem</p>
        <div className="template-row head" style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
          <span>Origem</span><span>Qtd</span><span>Valor</span>
        </div>
        {porOrigem.length === 0 && !loading && <div className="state-msg">Nenhum dado encontrado.</div>}
        {porOrigem.map((r, i) => (
          <div className="template-row" key={i} style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
            <span className="campanha-nome">{r.origem}</span>
            <span>{fmtInt(r.qtd)}</span>
            <span>{fmtMoeda(r.valor)}</span>
          </div>
        ))}
      </div>
    </>
  )
}

function VisaoGeral() {
  const [filtros, setFiltros] = useState({ campanhas: [], origens: [], metas: [] })
  const [campanha, setCampanha] = useState('')
  const [origem, setOrigem] = useState('')
  const [meta, setMeta] = useState('')
  const [dataInicio, setDataInicio] = useState('')
  const [dataFim, setDataFim] = useState('')
  const [horaInicio, setHoraInicio] = useState('')
  const [horaFim, setHoraFim] = useState('')
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
    date_from: dataInicio ? new Date(dataInicio + 'T00:00:00').toISOString() : '',
    date_to: dataFim ? new Date(dataFim + 'T23:59:59').toISOString() : '',
    hora_inicio: horaInicio,
    hora_fim: horaFim,
  }), [campanha, origem, meta, dataInicio, dataFim, horaInicio, horaFim])

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
          <button className="reset-btn" onClick={() => { setCampanha(''); setOrigem(''); setMeta(''); setDataInicio(''); setDataFim(''); setHoraInicio(''); setHoraFim('') }} title="Redefinir filtros">
            &#10226; Redefinir filtros
          </button>
          <button className="refresh-btn" onClick={loadDados} disabled={loading} title="Atualizar agora">
            &#8635; Atualizar
          </button>
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
      </div>
      <DateRangeFilter dataInicio={dataInicio} setDataInicio={setDataInicio} dataFim={dataFim} setDataFim={setDataFim} />
      <HourFilter horaInicio={horaInicio} setHoraInicio={setHoraInicio} horaFim={horaFim} setHoraFim={setHoraFim} />

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
        <div className="kpi"><p className="kpi-label">Valor Pago</p><p className="kpi-value">{fmtMoney(kpis?.valor_pago)}</p></div>
        <div className="kpi"><p className="kpi-label">Faturado</p><p className="kpi-value">{fmtMoney(kpis?.faturado)}</p></div>
        <div className="kpi"><p className="kpi-label">ROI</p><p className="kpi-value accent">{(kpis?.roi ?? 0).toString().replace('.', ',')}</p></div>
      </div>
      <div className="kpi-grid">
        <div className="kpi"><p className="kpi-label">Convers&atilde;o</p><p className="kpi-value">{fmtPct(kpis?.conversao_pct)}</p></div>
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

const VIEW_STORAGE_KEY = 'disparos_dashboard_view'

function Dashboard() {
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem(VIEW_STORAGE_KEY) || 'geral'
    } catch {
      return 'geral'
    }
  })

  const changeView = (v) => {
    setView(v)
    try { localStorage.setItem(VIEW_STORAGE_KEY, v) } catch { /* ignora */ }
  }

  return (
    <div className="app">
      <div className="app-header">
        <img src="/tiger-icon.png" alt="" className="app-logo" />
        <ViewSwitcher view={view} setView={changeView} />
      </div>
      {view === 'geral' && <VisaoGeral />}
      {view === 'leilao' && <LeilaoDetalhado />}
      {view === 'produtos' && <EntradasLP />}
      {view === 'n8n' && <N8nExecucoes />}
      {view === 'vendedoras' && <VendedorasView />}
      {view === 'vendas' && <VendasView />}
    </div>
  )
}

export default function App() {
  const [auth, setAuth] = useState(() => {
    try {
      const raw = localStorage.getItem(AUTH_STORAGE_KEY)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  })

  const logout = () => {
    try { localStorage.removeItem(AUTH_STORAGE_KEY) } catch { /* ignora */ }
    setAuth(null)
  }

  if (!auth) return <LoginGate onLogin={setAuth} />
  if (auth.role === 'vendedora') return <VendedoraPortal vendedor={auth.vendedor} onLogout={logout} />
  return <Dashboard />
}
