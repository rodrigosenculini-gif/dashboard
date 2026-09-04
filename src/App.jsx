import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { BarChart, Bar, AreaChart, Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts'
import IATreinamento from './IATreinamento'
import ArquivosButton from './ArquivosNuvem'
import RefinButton from './RefinLeads'

const REFRESH_MS = 60_000 // atualiza sozinho a cada 60s
// altura de uma linha do breakdown (padding 7+7, conteúdo ~18, borda 1)
const BREAKDOWN_ROW_H = 33
const VISIBLE_DEFAULT = 6

const VIEWS = [
  { id: 'geral', label: 'Disparos' },
  { id: 'leilao', label: 'Meta — Detalhado' },
  { id: 'produtos', label: 'Entradas LP' },
  { id: 'n8n', label: 'n8n — Execuções' },
  { id: 'vendedoras', label: 'Vendedoras' },
  { id: 'vendas', label: 'Vendas' },
  { id: 'ia', label: 'IA — Treinamento' },
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

// Lê o CSV de vendedoras (arquivo exportado em Latin-1, separado por ";"),
// corta só as colunas necessárias e normaliza cpf/data/valor.
// Detecta o formato do número (brasileiro "1.234,56" ou americano "1234.56")
// e sempre devolve no padrão que o Postgres numeric espera (ponto decimal,
// sem separador de milhar) — sem inventar nem cortar dígito nenhum.
function parseValorFlexivel(raw) {
  if (!raw) return ''
  let s = String(raw).trim()
  if (!s) return ''
  const hasComma = s.includes(',')
  const hasDot = s.includes('.')
  if (hasComma && hasDot) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      // formato BR: 1.234,56 -> tira os pontos de milhar, troca a vírgula por ponto
      s = s.replace(/\./g, '').replace(',', '.')
    } else {
      // formato US: 1,234.56 -> tira as vírgulas de milhar, mantém o ponto
      s = s.replace(/,/g, '')
    }
  } else if (hasComma) {
    // só tem vírgula: é o separador decimal (formato BR "1311,35")
    s = s.replace(',', '.')
  }
  // só tem ponto (ou nenhum separador): já está no formato certo, não mexe
  return s
}

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

    const valorRaw = parseValorFlexivel(cols[iValor] || '')
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

// Leê o CSV da visão Vendas. Aceita variações de nome de coluna e não
// exige todas — o gatilho no banco calcula produto/peso/ponto sozinho a
// partir do que vier (tabela OU parcelas+seguro).
// Normaliza o nome do banco pra bater com os já usados no cálculo de peso
// (ex.: "novo_saque_api" -> "NOVO SAQUE", "soma_uy3" -> "SOMA").
function normalizarBanco(raw) {
  const v = (raw || '').trim().toLowerCase()
  if (!v) return ''
  if (v.includes('facta')) return 'FACTA'
  if (v.includes('novo_saque') || v.includes('novosaque') || v.includes('novo saque')) return 'NOVO SAQUE'
  if (v.includes('fgtsv8') || v.includes('fgts_v8') || v.includes('fgts v8')) return 'FGTSV8'
  if (v.includes('v8')) return 'V8'
  if (v.includes('soma')) return 'SOMA'
  if (v.includes('crefaz')) return 'CREFAZ'
  if (v.includes('presen')) return 'PRESENÇA'
  if (v.includes('mercantil')) return 'MERCANTIL'
  if (v.includes('pan')) return 'PAN'
  // desconhecido: devolve em maiúsculo, com _ virando espaço, pra pelo
  // menos ficar legível e não quebrar nada
  return v.replace(/_/g, ' ').toUpperCase()
}

// Normaliza telefone pro padrão DDI+DDD+9+numero (13 dígitos).
// Números com 12 dígitos (sem o "9" na frente do número local) recebem o
// "9" inserido logo depois do DDD. Números já com 13 dígitos não mudam.
function normalizarWhatsapp(raw) {
  let d = (raw || '').replace(/\D/g, '')
  if (!d) return ''
  if (!d.startsWith('55')) d = '55' + d
  if (d.length === 12) {
    d = d.slice(0, 4) + '9' + d.slice(4)
  }
  return d
}

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
  const iAdesao = idx('ade', 'adesão', 'adesao', 'codigo', 'código')
  const iCpf = idx('cpf')
  const iTabela = idx('tabela')
  const iNome = idx('nome', 'cliente')
  const iValor = idx('valor')
  const iData = idx('data status', 'data')
  const iBanco = idx('banco')
  const iParcelas = idx('parcelas')
  const iSeguro = idx('seguro')
  const iWhatsapp = idx('telefone', 'whatsapp', 'celular')

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
      } else if (dataRaw.includes('T')) {
        // "2026-08-27T00:08:15.080149+00:00" -> só a parte da data
        dataIso = dataRaw.slice(0, 10)
      } else {
        dataIso = dataRaw
      }
    }

    const valorRaw = iValor !== -1 ? parseValorFlexivel(cols[iValor] || '') : ''
    const valor = valorRaw && !isNaN(Number(valorRaw)) ? valorRaw : ''

    // código/adesão: mantém só os dígitos (um UUID vira uma sequência de
    // números "aproveitada", já que não tem outro identificador melhor)
    const adesaoRaw = iAdesao !== -1 ? (cols[iAdesao] || '').trim() : ''
    const adesao = adesaoRaw.replace(/\D/g, '')

    rows.push({
      adesao,
      cpf,
      tabela: iTabela !== -1 ? (cols[iTabela] || '').trim() : '',
      nome: iNome !== -1 ? (cols[iNome] || '').trim() : '',
      valor,
      data: dataIso,
      banco: iBanco !== -1 ? normalizarBanco(cols[iBanco]) : '',
      parcelas: iParcelas !== -1 ? (cols[iParcelas] || '').trim() : '',
      seguro: iSeguro !== -1 ? (cols[iSeguro] || '').trim() : 's',
      whatsapp: iWhatsapp !== -1 ? normalizarWhatsapp(cols[iWhatsapp]) : '',
    })
  }
  return rows
}

async function callFactaApi(type, params) {
  const qs = new URLSearchParams({ type, ...params })
  const res = await fetch(`/api/facta?${qs.toString()}`)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Erro ao consultar Facta (${type})`)
  return data
}

async function cancelarPropostaFacta(valor, ehCpfValor) {
  const body = ehCpfValor ? { cpf: valor } : { codigo_af: valor }
  const res = await fetch('/api/facta?type=cancelamento', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Erro ao cancelar proposta')
  return data
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
function fmtPct2(n) {
  return `${(n ?? 0).toFixed(2).replace('.', ',')}%`
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
  const dow = now.getDay() // 0=domingo, 1=segunda, ... 6=sábado
  const diffToMonday = (dow + 6) % 7 // 0 se hoje já é segunda
  const monday = new Date(now)
  monday.setDate(now.getDate() - diffToMonday)
  const friday = new Date(monday)
  friday.setDate(monday.getDate() + 4)
  const hojeStr = fmtDateISO(now)
  const sextaStr = fmtDateISO(friday)
  // nunca passa da sexta-feira dessa semana, mesmo se hoje for sábado/domingo
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
  if (preset === 'esta_semana') {
    const dow = now.getDay() === 0 ? 7 : now.getDay() // segunda=1 ... domingo=7
    return { from: fmtDateISO(new Date(y, m, d - (dow - 1))), to: fmtDateISO(now) }
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
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(null) // guarda o 1º clique enquanto espera o 2º
  const [mesVisivel, setMesVisivel] = useState(() => {
    const base = dataInicio ? new Date(dataInicio + 'T00:00:00') : new Date()
    return { y: base.getFullYear(), m: base.getMonth() }
  })
  const boxRef = useRef(null)

  useEffect(() => {
    function onClickFora(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) { setOpen(false); setPicking(null) }
    }
    document.addEventListener('mousedown', onClickFora)
    return () => document.removeEventListener('mousedown', onClickFora)
  }, [])

  function diasDoMes(y, m) {
    const primeiro = new Date(y, m, 1)
    const inicioSemana = primeiro.getDay() // 0=dom
    const totalDias = new Date(y, m + 1, 0).getDate()
    const dias = []
    for (let i = 0; i < inicioSemana; i++) dias.push(null)
    for (let d = 1; d <= totalDias; d++) dias.push(fmtDateISO(new Date(y, m, d)))
    return dias
  }

  function clicarDia(iso) {
    if (!iso) return
    if (!picking) {
      setPicking(iso)
      setDataInicio(iso)
      setDataFim(iso)
      return
    }
    if (iso < picking) {
      setDataInicio(iso)
      setDataFim(picking)
    } else {
      setDataInicio(picking)
      setDataFim(iso)
    }
    setPicking(null)
    setOpen(false)
  }

  const mudarMes = (delta) => {
    setMesVisivel(({ y, m }) => {
      const nova = new Date(y, m + delta, 1)
      return { y: nova.getFullYear(), m: nova.getMonth() }
    })
  }

  const nomeMes = new Date(mesVisivel.y, mesVisivel.m, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
  const rotulo = dataInicio && dataFim
    ? (dataInicio === dataFim ? fmtDataBR(dataInicio) : `${fmtDataBR(dataInicio)} — ${fmtDataBR(dataFim)}`)
    : 'selecionar período'

  return (
    <div className="date-range-filter" ref={boxRef} style={{ position: 'relative' }}>
      <div className="date-presets">
        <button type="button" onClick={() => applyPreset('hoje')}>Hoje</button>
        <button type="button" onClick={() => applyPreset('ontem')}>Ontem</button>
        <button type="button" onClick={() => applyPreset('esta_semana')}>Esta semana</button>
        <button type="button" onClick={() => applyPreset('este_mes')}>Este m&ecirc;s</button>
        <button type="button" onClick={() => applyPreset('mes_passado')}>M&ecirc;s passado</button>
      </div>
      <button type="button" className="date-range-box-btn" onClick={() => setOpen((o) => !o)}>
        &#128197; {rotulo}
      </button>
      {open && (
        <div className="date-range-popover">
          <div className="date-range-popover-head">
            <button type="button" onClick={() => mudarMes(-1)}>&lsaquo;</button>
            <strong style={{ textTransform: 'capitalize' }}>{nomeMes}</strong>
            <button type="button" onClick={() => mudarMes(1)}>&rsaquo;</button>
          </div>
          <div className="date-range-popover-grid date-range-popover-dow">
            {['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'].map((d) => <span key={d}>{d}</span>)}
          </div>
          <div className="date-range-popover-grid">
            {diasDoMes(mesVisivel.y, mesVisivel.m).map((iso, i) => {
              const dentro = iso && dataInicio && dataFim && iso >= dataInicio && iso <= dataFim
              const borda = iso && (iso === dataInicio || iso === dataFim)
              return (
                <button
                  type="button"
                  key={i}
                  disabled={!iso}
                  onClick={() => clicarDia(iso)}
                  className={`date-range-day ${dentro ? 'in-range' : ''} ${borda ? 'is-edge' : ''}`}
                >
                  {iso ? Number(iso.slice(8, 10)) : ''}
                </button>
              )
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{picking ? 'escolha a data final' : 'escolha a data inicial'}</span>
            <button type="button" className="reset-btn" onClick={() => { setDataInicio(''); setDataFim(''); setPicking(null) }}>Limpar</button>
          </div>
        </div>
      )}
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

  const filtered = options
    .filter((o) => o != null && String(o).trim() !== '')
    .filter((o) => String(o).toLowerCase().includes(query.toLowerCase()))
    .slice(0, 50)

  return (
    <div className="campanha-search" ref={ref}>
      <input
        type="text"
        className="campanha-search-input"
        placeholder={`${label} — todas`}
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
            {allLabel || `${label} — todas`}
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

// Seletor de múltipla escolha (checkboxes) com busca e botão "desmarcar tudo".
// `value` é sempre um array (vazio = "todos").
function MultiSelect({ value, onChange, options, label }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const opcoes = options.filter((o) => o != null && String(o).trim() !== '')
  const opcoesFiltradas = query
    ? opcoes.filter((o) => String(o).toLowerCase().includes(query.toLowerCase()))
    : opcoes

  function toggle(o) {
    if (value.includes(o)) onChange(value.filter((v) => v !== o))
    else onChange([...value, o])
  }

  const rotulo = value.length === 0
    ? `${label} — todos`
    : value.length === 1
      ? value[0]
      : `${label} (${value.length})`

  return (
    <div className="multi-select" ref={ref}>
      <button type="button" className="multi-select-btn" onClick={() => setOpen((o) => !o)}>
        {rotulo}
      </button>
      {open && (
        <div className="multi-select-popover">
          <div className="multi-select-head">
            <span style={{ fontSize: 11.5, color: 'var(--muted)', textTransform: 'uppercase' }}>{label}</span>
            <button type="button" className="reset-btn" onClick={() => onChange([])} disabled={value.length === 0}>
              Desmarcar tudo
            </button>
          </div>
          <input
            type="text"
            className="multi-select-search"
            placeholder={`Buscar ${label}...`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {opcoesFiltradas.map((o) => (
            <label className="multi-select-item" key={o}>
              <input type="checkbox" checked={value.includes(o)} onChange={() => toggle(o)} />
              {o}
            </label>
          ))}
          {opcoes.length === 0 && <div className="campanha-search-empty">Nenhum valor dispon&iacute;vel</div>}
          {opcoes.length > 0 && opcoesFiltradas.length === 0 && (
            <div className="campanha-search-empty">Nenhum valor encontrado</div>
          )}
        </div>
      )}
    </div>
  )
}

function CampanhaSearch({ value, onChange, options }) {
  return <MultiSelect value={value} onChange={onChange} options={options} label="campanha" />
}

function ExpandToggle({ expanded, onToggle, hiddenCount }) {
  if (hiddenCount <= 0 && !expanded) return null
  return (
    <button className="expand-btn" onClick={onToggle}>
      {expanded ? 'Mostrar menos' : `Mostrar mais (+${hiddenCount})`}
    </button>
  )
}

function BreakdownList({ title, items, loading, showInteracoes, showConversao, rows }) {
  const totalLeads = items.reduce((acc, i) => acc + (Number(i.leads) || 0), 0)
  const maxShare = Math.max(
    1,
    ...items.map((i) => (totalLeads ? (Number(i.leads) / totalLeads) * 100 : 0))
  )
  // conversão é escalada pelo maior valor da lista, senão (valores <1%)
  // a barra ficaria invisível
  const maxConv = Math.max(0.0001, ...items.map((i) => Number(i.conversao) || 0))

  const cols = showInteracoes && showConversao
    ? '1.1fr 1.5fr 0.6fr 0.6fr'
    : showInteracoes || showConversao
      ? '1.2fr 1.6fr 0.7fr'
      : '1fr 0.6fr'
  const grid = { gridTemplateColumns: cols }

  return (
    <div className="panel table-panel breakdown">
      <p className="section-label">{title}</p>
      <div className="breakdown-row head" style={grid}>
        <span>Valor</span>
        <span className={showConversao ? undefined : 'num'}>
          {showConversao ? 'Part. / conv.' : 'Leads'}
        </span>
        {showInteracoes && <span className="num">Intera&ccedil;&otilde;es</span>}
        {showConversao && <span className="num">Convers&atilde;o</span>}
      </div>
      <div className="breakdown-scroll" style={rows ? { maxHeight: rows * BREAKDOWN_ROW_H } : undefined}>
        {items.length === 0 && !loading && (
          <div className="state-msg">Sem dados para os filtros selecionados.</div>
        )}
        {items.map((i) => {
          const share = totalLeads ? (Number(i.leads) / totalLeads) * 100 : 0
          const conv = Number(i.conversao) || 0
          return (
            <div className="breakdown-row" key={i.valor} style={grid}>
              <span className="campanha-nome">{i.valor}</span>
              {showConversao ? (
                <span className="bar-cell">
                  <span
                    className="bar-dual"
                    title={`${share.toFixed(1)}% dos leads \u00b7 ${fmtPct(conv)} de convers\u00e3o`}
                  >
                    <span className="bar-dual-side left">
                      <span className="bar-dual-fill share" style={{ width: `${(share / maxShare) * 100}%` }} />
                    </span>
                    <span className="bar-dual-mid" />
                    <span className="bar-dual-side right">
                      <span className="bar-dual-fill conv" style={{ width: `${(conv / maxConv) * 100}%` }} />
                    </span>
                  </span>
                  <span className="bar-value">{fmtInt(i.leads)}</span>
                </span>
              ) : (
                <span className="num" title={`${share.toFixed(1)}% dos leads`}>{fmtInt(i.leads)}</span>
              )}
              {showInteracoes && <span className="num">{fmtInt(i.interacoes)}</span>}
              {showConversao && <span className="num">{fmtPct(i.conversao)}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CampanhaDetalhadoList({ items, loading }) {
  const cols = '1.6fr 0.9fr 1fr 1.1fr 1fr 0.7fr 1fr'
  return (
    <div className="panel table-panel">
      <p className="section-label">Campanha Detalhado</p>
      <div className="template-row head" style={{ gridTemplateColumns: cols }}>
        <span>Campanha</span>
        <span>Leads totais</span>
        <span>Envios/Reenvios</span>
        <span>Tempo m&eacute;dio resposta</span>
        <span>Valor Pago</span>
        <span>Pagas</span>
        <span>Intera&ccedil;&atilde;o (qtd)</span>
      </div>
      {items.length === 0 && !loading && (
        <div className="state-msg">Nenhum dado para os filtros selecionados.</div>
      )}
      <div className="scroll-table">
        {items.map((c) => (
          <div className="template-row" key={c.campanha} style={{ gridTemplateColumns: cols }}>
            <span className="campanha-nome">{c.campanha}</span>
            <span>{fmtInt(c.leads_totais)}</span>
            <span>{fmtInt(c.envios)} / {fmtInt(c.reenvios)}</span>
            <span>{c.tempo_resposta_min != null ? `${fmtInt(Math.round(c.tempo_resposta_min))} min` : '-'}</span>
            <span>{fmtMoeda(c.valor_pago)}</span>
            <span>{fmtInt(c.pagas)}</span>
            <span>{fmtInt(c.interacao_qtd)}</span>
          </div>
        ))}
      </div>
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
  const [campanhaSel, setCampanhaSel] = useState([])
  const campanha = campanhaSel.join(',')

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

  const handleDownload = () => {
    const date_from = dataInicio ? new Date(dataInicio + 'T00:00:00').toISOString() : ''
    const date_to = dataFim ? new Date(dataFim + 'T23:59:59').toISOString() : ''
    const qs = new URLSearchParams({ type: 'disparos_export', campanha, date_from, date_to })
    window.open(`/api/dashboard?${qs.toString()}`, '_blank')
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1><span className="pulse" /> Meta &middot; Painel de Disparos</h1>
          <p className="subtitle">Envio de leads e disparo de WhatsApp via API Meta &mdash; Hotline</p>
        </div>
        <div className="topbar-right">
          <span className="status-line">
            {loading ? 'atualizando...' : lastUpdate ? `atualizado às ${fmtHora(lastUpdate)}` : ''}
          </span>
          <button className="reset-btn" onClick={() => { setCampanhaSel([]); setDataInicio(todayISO()); setDataFim(todayISO()); setHoraInicio(''); setHoraFim('') }} title="Redefinir filtros">
            &#10226; Redefinir filtros
          </button>
          <button className="refresh-btn" onClick={handleDownload} title="Baixar relat&oacute;rio filtrado em CSV">
            &#8595; Baixar
          </button>
          <button className="refresh-btn" onClick={load} disabled={loading} title="Atualizar agora">
            &#8635; Atualizar
          </button>
        </div>
      </div>

      <div className="filters">
        <CampanhaSearch value={campanhaSel} onChange={setCampanhaSel} options={campanhas} />
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
  const [campanhaSel, setCampanhaSel] = useState([])
  const campanha = campanhaSel.join(',')
  const [produtoSel, setProdutoSel] = useState([])
  const [origemSel, setOrigemSel] = useState([])
  const produto = produtoSel.join(',')
  const origem = origemSel.join(',')
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
        callApi('produtos_campanhas', { campanha: args.campanha, produto: args.produto, origem: args.origem, date_from: args.date_from, date_to: args.date_to }),
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

  const handleDownload = () => {
    const qs = new URLSearchParams({ type: 'entradas_export', campanha: args.campanha, origem: args.origem, produto: args.produto, date_from: args.date_from, date_to: args.date_to })
    window.open(`/api/dashboard?${qs.toString()}`, '_blank')
  }

  return (
    <>
      <div className="topbar">
        <h1><span className="pulse" /> Entradas LP</h1>
        <div className="topbar-right">
          <span className="status-line">
            {loading ? 'atualizando...' : lastUpdate ? `atualizado às ${fmtHora(lastUpdate)}` : ''}
          </span>
          <button className="reset-btn" onClick={() => { setCampanhaSel([]); setProdutoSel([]); setOrigemSel([]); setDataInicio(''); setDataFim(''); setHoraInicio(''); setHoraFim('') }} title="Redefinir filtros">
            &#10226; Redefinir filtros
          </button>
          <button className="refresh-btn" onClick={handleDownload} title="Baixar relat&oacute;rio filtrado em CSV">
            &#8595; Baixar
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
        <CampanhaSearch value={campanhaSel} onChange={setCampanhaSel} options={filtros.campanhas} />
        <MultiSelect value={produtoSel} onChange={setProdutoSel} options={filtros.produtos} label="produto" />
        <MultiSelect value={origemSel} onChange={setOrigemSel} options={filtros.origens} label="origem" />
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
  { key: 'simulacoes_saldo', label: 'Simulações com saldo' },
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
  const [campanhaSel, setCampanhaSel] = useState([])
  const campanha = campanhaSel.join(',')
  const [origemSel, setOrigemSel] = useState([])
  const [produtoSel, setProdutoSel] = useState([])
  const origem = origemSel.join(',')
  const produto = produtoSel.join(',')

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
          <CampanhaSearch value={campanhaSel} onChange={setCampanhaSel} options={filtros.campanhas} />
          <MultiSelect value={origemSel} onChange={setOrigemSel} options={filtros.origens} label="origem" />
          {showProduto && (
            <MultiSelect value={produtoSel} onChange={setProdutoSel} options={filtros.produtos} label="produto" />
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

// Consulta (somente leitura) de propostas na Facta, por CPF ou código AF.
// "Andamento de propostas" cobre qualquer tipo de operação; a consulta de
// refinanciamento (por CPF) só existe pra REFIN, então só aparece quando a
// busca é feita por CPF.
// Pega o primeiro campo que existir e não for vazio — usado pra aceitar
// tanto os nomes de campo originais da Facta quanto nomes que você tenha
// renomeado/achatado no seu fluxo n8n, sem quebrar nada.
function pick(obj, ...campos) {
  for (const c of campos) {
    const v = obj?.[c]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return null
}

// Aceita qualquer formato que a Facta mandar: array direto, envelope
// {propostas: [...]} ou {data: [...]}, ou um objeto único já achatado —
// sem exigir nenhum campo específico. Assim, campo novo nunca quebra isso.
function extraiListaPropostas(resp) {
  if (!resp) return []
  if (Array.isArray(resp)) return resp
  if (Array.isArray(resp.propostas)) return resp.propostas
  if (Array.isArray(resp.data)) return resp.data
  if (typeof resp === 'object' && Object.keys(resp).length > 0) return [resp]
  return []
}

// Idem pro refin: aceita array direto, {lista_contratos_refin: {...}}
// (formato original, um objeto por contrato) ou um objeto único já achatado.
// Não adiciona nenhum campo extra ao objeto — só usa isso pra decidir o
// formato da resposta.
function extraiListaRefin(resp) {
  if (!resp) return []
  if (Array.isArray(resp)) return resp
  if (resp.lista_contratos_refin && typeof resp.lista_contratos_refin === 'object') {
    return Object.values(resp.lista_contratos_refin)
  }
  if (typeof resp === 'object' && Object.keys(resp).length > 0) return [resp]
  return []
}

function humanizeLabel(key) {
  return String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
}

// Renderiza QUALQUER campo presente no objeto, sem lista fixa — assim,
// se a Facta mandar um campo novo amanhã, ele já aparece aqui sozinho,
// sem precisar mexer no código.
function CamposGenericos({ obj, prefix }) {
  if (!obj || typeof obj !== 'object') return null
  const entries = Object.entries(obj).filter(
    ([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'function'
  )
  if (entries.length === 0) return null
  return (
    <>
      {entries.map(([k, v]) => {
        const label = prefix ? `${prefix} – ${humanizeLabel(k)}` : humanizeLabel(k)
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          return <CamposGenericos key={k} obj={v} prefix={label} />
        }
        const valorExibido = Array.isArray(v)
          ? (v.length === 0 ? '-' : v.map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item))).join(', '))
          : String(v)
        return <p key={k}><strong>{label}:</strong> {valorExibido}</p>
      })}
    </>
  )
}

function FactaConsultaOverlay({ onClose }) {
  const [busca, setBusca] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [propostas, setPropostas] = useState(null)
  const [refin, setRefin] = useState(null)
  const [buscou, setBuscou] = useState(false)

  const [showCancelar, setShowCancelar] = useState(false)
  const [codigoAfCancelar, setCodigoAfCancelar] = useState('')
  const [confirmarCancelar, setConfirmarCancelar] = useState(false)
  const [cancelando, setCancelando] = useState(false)
  const [resultadoCancelamento, setResultadoCancelamento] = useState(null)

  const ehCpf = (v) => v.replace(/\D/g, '').length === 11

  const handleBuscar = async (e) => {
    e.preventDefault()
    const valor = busca.trim()
    if (!valor) return
    setLoading(true)
    setError(null)
    setPropostas(null)
    setRefin(null)
    setBuscou(true)
    try {
      const usaCpf = ehCpf(valor)
      const params = usaCpf ? { cpf: valor } : { af: valor }
      const resultado = await callFactaApi('andamento', params)
      setPropostas(resultado)
    } catch (e2) {
      setError(e2.message || 'Erro ao consultar a Facta.')
    } finally {
      setLoading(false)
    }
  }

  const abrirCancelar = () => {
    setResultadoCancelamento(null)
    setConfirmarCancelar(false)
    // já sugere o AF da última proposta encontrada, se houver
    const sugestao = pick(listaPropostas[0], 'proposta_numero', 'codigo_af') || busca.trim()
    setCodigoAfCancelar(usaCpfNaBusca ? '' : sugestao)
    setShowCancelar(true)
  }

  const handleCancelar = async (e) => {
    e.preventDefault()
    const valor = codigoAfCancelar.trim()
    if (!valor) return
    if (!confirmarCancelar) return
    setCancelando(true)
    setResultadoCancelamento(null)
    try {
      const resultado = await cancelarPropostaFacta(valor, ehCpf(valor))
      setResultadoCancelamento({ ok: !resultado.erro, mensagem: resultado.mensagem || (resultado.erro ? 'Erro ao cancelar.' : 'Cancelamento solicitado com sucesso.') })
    } catch (e2) {
      setResultadoCancelamento({ ok: false, mensagem: e2.message || 'Erro ao cancelar proposta.' })
    } finally {
      setCancelando(false)
    }
  }

  const listaPropostas = selecionarPropostas(extraiListaPropostas(propostas))
  const listaRefin = extraiListaRefin(refin)
  const usaCpfNaBusca = ehCpf(busca.trim())

  return (
    <div className="funil-overlay" onClick={onClose}>
      <div className="funil-panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760 }}>
        <div className="funil-header">
          <div>
            <h2>Consulta Facta</h2>
            <p className="subtitle">Busca por CPF (11 d&iacute;gitos) ou c&oacute;digo AF &mdash; somente leitura</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="refresh-btn" onClick={abrirCancelar} title="Cancelar uma proposta na Facta">Cancelar Proposta</button>
            <button className="funil-close" onClick={onClose}>&times;</button>
          </div>
        </div>

        {showCancelar && (
          <div className="card" style={{ marginBottom: 16, borderColor: 'var(--rose)' }}>
            <p className="card-label" style={{ color: 'var(--rose)' }}>Cancelar proposta na Facta</p>
            {!resultadoCancelamento ? (
              <form onSubmit={handleCancelar} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <label style={{ fontSize: 12.5, color: 'var(--muted)' }}>C&oacute;digo AF ou CPF (11 d&iacute;gitos)</label>
                <input
                  value={codigoAfCancelar}
                  onChange={(e) => setCodigoAfCancelar(e.target.value)}
                  placeholder="Código AF ou CPF"
                  style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 13, padding: '9px 10px', borderRadius: 7 }}
                />
                {ehCpf(codigoAfCancelar.trim()) && (
                  <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
                    Voc&ecirc; digitou um CPF &mdash; a proposta mais recente desse cliente ser&aacute; localizada e cancelada automaticamente.
                  </p>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--muted)' }}>
                  <input type="checkbox" checked={confirmarCancelar} onChange={(e) => setConfirmarCancelar(e.target.checked)} />
                  Confirmo que quero cancelar essa proposta na Facta (a&ccedil;&atilde;o pode ser irrevers&iacute;vel).
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="submit" className="refresh-btn" disabled={cancelando || !codigoAfCancelar.trim() || !confirmarCancelar} style={{ background: 'var(--rose)' }}>
                    {cancelando ? 'Cancelando...' : 'Confirmar cancelamento'}
                  </button>
                  <button type="button" className="reset-btn" onClick={() => setShowCancelar(false)}>Fechar</button>
                </div>
              </form>
            ) : (
              <div>
                <p style={{ color: resultadoCancelamento.ok ? 'var(--lime)' : 'var(--rose)', fontSize: 13.5 }}>{resultadoCancelamento.mensagem}</p>
                <button className="reset-btn" onClick={() => setShowCancelar(false)}>Fechar</button>
              </div>
            )}
          </div>
        )}

        <form onSubmit={handleBuscar} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="CPF ou código AF"
            style={{ flex: 1, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 13, padding: '9px 10px', borderRadius: 7 }}
          />
          <button type="submit" className="refresh-btn" disabled={loading}>{loading ? 'Buscando...' : 'Buscar'}</button>
        </form>

        {error && <div className="state-msg error">Erro: {error}</div>}

        {buscou && !loading && !error && listaPropostas.length === 0 && listaRefin.length === 0 && (
          <div className="state-msg">Nenhuma proposta encontrada pra essa busca.</div>
        )}

        {listaPropostas.length > 0 && (
          <>
            <p className="section-label" style={{ marginTop: 8 }}>Propostas ({listaPropostas.length})</p>
            {listaPropostas.map((p, i) => {
              const nome = pick(p, 'cliente')
              const cpf = pick(p, 'cpf')
              return (
                <div className="card" key={i} style={{ marginBottom: 12 }}>
                  {(nome || cpf) && (
                    <p className="card-label">{[nome, cpf].filter(Boolean).join(' — ')}</p>
                  )}
                  <div className="grid-2" style={{ maxWidth: '100%' }}>
                    <CamposGenericos obj={p} />
                  </div>
                </div>
              )
            })}
          </>
        )}

        {listaRefin.length > 0 && (
          <>
            <p className="section-label" style={{ marginTop: 20 }}>Contratos eleg&iacute;veis a refinanciamento ({listaRefin.length})</p>
            {listaRefin.map((c, i) => {
              const nome = pick(c, 'cliente')
              const chave = pick(c, 'proposta_numero', 'numero_contrato', 'matricula') || i
              return (
                <div className="card" key={chave} style={{ marginBottom: 12 }}>
                  {nome && <p className="card-label">{nome}</p>}
                  <div className="grid-2" style={{ maxWidth: '100%' }}>
                    <CamposGenericos obj={c} />
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
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

  const handleDownload = () => {
    const linhas = [
      'metrica;valor',
      `total;${stats?.total ?? ''}`,
      `sucesso;${stats?.success ?? ''}`,
      `erro;${stats?.error ?? ''}`,
      `pendentes;${stats?.pending ?? ''}`,
      `tempo_medio_execucao_seg;${stats?.avg_duration_sec ?? ''}`,
      `tempo_medio_pendente_seg;${stats?.avg_pending_sec ?? ''}`,
      '',
      'id;status;pendente_ha_segundos',
      ...(stats?.pending_list || []).map((p) => `${p.id};${p.status};${p.elapsedSec ?? ''}`),
    ]
    const csv = '﻿' + linhas.join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `n8n_execucoes_${dataInicio || 'todas'}_${dataFim || 'todas'}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <div className="topbar">
        <h1><span className="pulse" /> n8n &mdash; Execu&ccedil;&otilde;es</h1>
        <div className="topbar-right">
          <span className="status-line">
            {loading ? 'atualizando...' : lastUpdate ? `atualizado às ${fmtHora(lastUpdate)}` : ''}
          </span>
          <button className="reset-btn" onClick={() => { setWorkflowId(''); setDataInicio(todayISO()); setDataFim(todayISO()) }} title="Redefinir filtros">
            &#10226; Redefinir filtros
          </button>
          <button className="refresh-btn" onClick={handleDownload} title="Baixar relat&oacute;rio filtrado em CSV">
            &#8595; Baixar
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

// Aceita tanto "AAAA-MM-DD[THH:MM]" (ISO) quanto "DD/MM/AAAA[ HH:MM]" (formato
// que a Facta costuma mandar em data_digitacao) e devolve um timestamp
// numérico pra dar pra ordenar por recência. Datas inválidas/vazias viram
// -Infinity, pra sempre ficarem por último.
function parseDataFlexivel(str) {
  if (!str) return -Infinity
  const s = String(str).trim()
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (isoMatch) {
    const t = new Date(s).getTime()
    return isNaN(t) ? -Infinity : t
  }
  const brMatch = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/)
  if (brMatch) {
    const [, dd, mm, yyyy, hh = '00', min = '00', ss = '00'] = brMatch
    const t = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}`).getTime()
    return isNaN(t) ? -Infinity : t
  }
  return -Infinity
}

// Regra de seleção das propostas a mostrar (a Facta pode devolver várias
// pro mesmo CPF/AF):
// 1) Sempre olha a mais recente primeiro (por data_digitacao).
// 2) Se existir alguma com "pago" no status (não precisa ser exatamente esse
//    status, só conter a palavra) — prioridade máxima: mostra só ela
//    (a mais recente entre as pagas).
// 3) Senão, se existir uma "cancelada" e outra em "assinatura" (mesma lógica
//    de conter a palavra, não precisa ser o status exato) — mostra as duas.
// 4) Em qualquer outro caso — mostra as duas mais recentes.
function contemPalavra(p, palavra) {
  const status = (pick(p, 'status', 'status_proposta') || '').toString().toLowerCase()
  return status.includes(palavra)
}

function selecionarPropostas(lista) {
  if (!lista || lista.length === 0) return []
  const ordenada = [...lista].sort(
    (a, b) => parseDataFlexivel(pick(b, 'data_digitacao')) - parseDataFlexivel(pick(a, 'data_digitacao'))
  )

  const pagas = ordenada.filter((p) => contemPalavra(p, 'pago'))
  if (pagas.length > 0) {
    return [pagas[0]]
  }

  const canceladas = ordenada.filter((p) => contemPalavra(p, 'cancelad'))
  const emAssinatura = ordenada.filter((p) => contemPalavra(p, 'assinatura'))
  if (canceladas.length > 0 && emAssinatura.length > 0) {
    const cancelada = canceladas[0]
    const assinatura = emAssinatura.find((p) => p !== cancelada) || emAssinatura[0]
    return assinatura === cancelada ? [cancelada] : [cancelada, assinatura]
  }

  return ordenada.slice(0, 2)
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
  const ehAtual = row.ehSemanaAtual || row.ehAtual
  return (
    <div style={{ background: '#1b2620', border: '1px solid #263029', borderRadius: 8, fontFamily: 'IBM Plex Mono', fontSize: 12, padding: '8px 10px' }}>
      <p style={{ color: '#8a978f', margin: '0 0 4px' }}>{label}</p>
      {row.valorDia != null && (
        <p style={{ margin: '2px 0', color: '#fff' }}>Valor do dia: {fmtMoeda(row.valorDia)}</p>
      )}
      {row.pontoDia != null && (
        <p style={{ margin: '2px 0 8px', color: '#fff' }}>Pontos do dia: {fmtInt(Math.round(row.pontoDia))}</p>
      )}
      {row.realizado != null && (
        <p style={{ margin: '2px 0', color: '#a9d97f' }}>Valor realizado: {fmtMoeda(row.realizado)}</p>
      )}
      {ehAtual && (
        <p style={{ margin: '2px 0', color: '#d9b877' }}>Valor proje&ccedil;&atilde;o do m&ecirc;s: {fmtMoeda(row.projecaoMesTotal)}</p>
      )}
      {!ehAtual && row.realizado == null && row.projecao != null && (
        <p style={{ margin: '2px 0', color: '#d9b877' }}>Valor proje&ccedil;&atilde;o: {fmtMoeda(row.projecao)}</p>
      )}
      {row.pontoRealizado != null && (
        <p style={{ margin: '2px 0', color: '#a9d97f' }}>Pontos realizado: {fmtInt(Math.round(row.pontoRealizado))}</p>
      )}
      {ehAtual && row.pontoMesTotal != null && (
        <p style={{ margin: '2px 0', color: '#d9b877' }}>Pontos proje&ccedil;&atilde;o do m&ecirc;s: {fmtInt(Math.round(row.pontoMesTotal))}</p>
      )}
      {!ehAtual && row.pontoRealizado == null && row.pontoProjecao != null && (
        <p style={{ margin: '2px 0', color: '#d9b877' }}>Pontos proje&ccedil;&atilde;o: {fmtInt(Math.round(row.pontoProjecao))}</p>
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

// Bancos com peso calculado por código de tabela (a vendedora escolhe o
// código certo em vez de digitar parcela/seguro)
const BANCOS_POR_CODIGO = ['FACTA']

// Novo Saque, FGTSV8 (linha Acelera) e C6 não são nem por código nem por
// parcela/seguro sozinhos — o peso vem do NOME da tabela (C6 também precisa
// de parcelas, pois o mesmo nome pode valer pesos diferentes por prazo).
// V8 (consignado CLT) continua no modo parcela + seguro, como sempre foi.
const BANCOS_POR_TABELA_NOME = ['NOVO SAQUE', 'FGTSV8', 'C6']
// Dentre os bancos acima, só o C6 ainda precisa do campo Parcelas — os
// demais (Novo Saque, FGTSV8) têm peso fixo por nome de tabela.
const BANCOS_TABELA_NOME_COM_PARCELAS = ['C6']

// Valores vigentes a partir de 01/09/2026 (tabela_pontos)
const NOVO_SAQUE_TABELAS = [
  { valor: 'TABELA NS', label: 'TABELA NS (12,00)' },
  { valor: 'TABELA CAMPANHA', label: 'TABELA CAMPANHA (9,50)' },
  { valor: 'TABELA DIAMANTE', label: 'TABELA DIAMANTE (7,50)' },
  { valor: 'TABELA GOLD', label: 'TABELA GOLD (6,00)' },
  { valor: 'TABELA MONEY', label: 'TABELA MONEY (4,50)' },
  { valor: 'TABELA LIGHT', label: 'TABELA LIGHT (3,50)' },
  { valor: 'TABELA SOFT', label: 'TABELA SOFT (2,00)' },
  { valor: 'TABELA SMART', label: 'TABELA SMART (1,10)' },
  { valor: 'TABELA ZERO', label: 'TABELA ZERO (0,70)' },
  { valor: 'Novo Saque Novo', label: 'NOVO (CLT — peso fixo 0,60)' },
]

// FGTSV8 - linha Acelera: peso pelo nome da tabela, 1 a 5 parcelas.
// Valores vigentes a partir de 01/09/2026 (tabela_pontos) — GRID, NORMAL e
// PIT STOP não mudaram; ACELERA 2.0, COMETA e TURBO tiveram ajuste de peso.
const FGTSV8_TABELAS = [
  { valor: 'ACELERA 2.0', label: 'ACELERA 2.0 (11,50)' },
  { valor: 'COMETA EXCLUSIVA BMS', label: 'COMETA EXCLUSIVA BMS (8,80)' },
  { valor: 'GRID', label: 'GRID (6,00)' },
  { valor: 'TURBO', label: 'TURBO (5,80)' },
  { valor: 'NORMAL', label: 'NORMAL (4,50)' },
  { valor: 'PIT STOP', label: 'PIT STOP (1,80)' },
]

// C6 Consignado Privado — peso por nome da tabela + parcelas (tabela_pontos,
// vigente a partir de 01/09/2026). Vários nomes se repetem em prazos
// diferentes com pesos diferentes — por isso o campo Parcelas continua
// obrigatório para o C6 (ver BANCOS_TABELA_NOME_COM_PARCELAS acima).
const C6_TABELAS = [
  { valor: 'TOP PLAN 13 C/SEGURO', label: 'TOP PLAN 13 C/SEGURO (48x=1,35 · 24x=1,20)' },
  { valor: 'TOP PLAN 10, 9, 8, 6 E 4 - TODAS C/SEGURO', label: 'TOP PLAN 10,9,8,6 e 4 C/SEGURO (48x=1,20)' },
  { valor: 'TOP PLAN 13, 10, 9, 8 E 6 - TODAS C/SEGURO', label: 'TOP PLAN 13,10,9,8 e 6 C/SEGURO (36x=1,20)' },
  { valor: 'TOP PLAN 3, 2 E 1 - PLAN 13, 10, 9, 8, 6 E 4 - TODAS C/SEGURO', label: 'TOP PLAN 3,2,1 (+13,10,9,8,6,4) C/SEGURO (48x=1,00)' },
  { valor: 'TOP PLAN 4, 3, 2 E 1 - PLAN 13, 10, 9, E 6 - TODAS C/SEGURO', label: 'TOP PLAN 4,3,2,1 (+13,10,9,6) C/SEGURO (36x=1,00)' },
  { valor: 'TOP PLAN 10, 9, 8, 6, 4 E 3 - PLAN 13 - TODAS C/SEGURO', label: 'TOP PLAN 10,9,8,6,4,3 (+13) C/SEGURO (24x=1,00 · 14x=0,80)' },
  { valor: 'TOP PLAN 13, 10, 9, 8, 6 E 4 - TODAS C/SEGURO', label: 'TOP PLAN 13,10,9,8,6,4 C/SEGURO (18x=1,00)' },
  { valor: 'TOP PLAN13 C/SEGURO', label: 'TOP PLAN 13 C/SEGURO — nome curto (14x=1,00)' },
  { valor: 'PLAN 3, 2 E 1 - TODAS C/SEGURO', label: 'PLAN 3,2,1 C/SEGURO (48x=0,80 · 24x=0,70)' },
  { valor: 'NOVO - SEM SEGURO', label: 'NOVO - SEM SEGURO (48x=0,80 · 36x=0,70 · 24x=0,60)' },
  { valor: 'PLAN 4, 3, 2 E 1 - TODAS C/ SEGURO', label: 'PLAN 4,3,2,1 C/SEGURO (36x=0,80)' },
  { valor: 'TOP PLAN 2 E 1 - PLAN 10, 9, 8, 6, 4 E 3 - TODAS C/SEGURO', label: 'TOP PLAN 2,1 (+10,9,8,6,4,3) C/SEGURO (24x=0,80)' },
  { valor: 'TOP PLAN 3, 2 E 1 - PLAN 13, 10, 9, 8, 6 E 4 - TODAS C/SEGURO', label: 'TOP PLAN 3,2,1 (+13,10,9,8,6,4) C/SEGURO (18x=0,80)' },
  { valor: 'PLAN 2 E 1 - TODAS C/SEGURO', label: 'PLAN 2,1 C/SEGURO (24x=0,70)' },
  { valor: 'PLAN 3 E 2 - TODAS C/SEGURO', label: 'PLAN 3,2 C/SEGURO (18x=0,70)' },
  { valor: 'TOP PLAN 2 E 1 - PLAN 10 E 9 - TODAS C/SEGURO', label: 'TOP PLAN 2,1 (+10,9) C/SEGURO (14x=0,70)' },
  { valor: 'PLAN 1 C/SEGURO E NOVO SEM SEGURO', label: 'PLAN 1 C/SEGURO e NOVO SEM SEGURO (18x=0,60)' },
  { valor: 'PLAN 8, 6, 4 E 3 - TODAS C/SEGURO', label: 'PLAN 8,6,4,3 C/SEGURO (14x=0,60)' },
  { valor: 'PLAN 2 E 1 C/SEGURO E NOVO SEM SEGURO', label: 'PLAN 2,1 C/SEGURO e NOVO SEM SEGURO (14x=0,50)' },
  { valor: 'ESP PLAN 6 C/ SEGURO', label: 'ESP PLAN 6 C/SEGURO (18x=0,35)' },
  { valor: 'ESP PLAN 4 C/ SEGURO', label: 'ESP PLAN 4 C/SEGURO (18x=0,30 · 14x=0,30)' },
]

// Todos os outros bancos suportados hoje calculam o peso por parcela + seguro
const BANCOS_VENDA = ['FACTA', 'CREFAZ', 'PAN', 'MERCANTIL', 'PRESENÇA', 'SOMA', 'V8', 'FGTSV8', 'NOVO SAQUE', 'C6']

// Bancos com API instalada pra consulta de adesão (webhook n8n
// consulta-adesao-banco): pra esses, o formulário não pede tabela/parcelas
// — só a adesão, que é buscada e preenchida direto da API do banco.
const BANCOS_COM_API = ['FACTA', 'SOMA', 'PRESENÇA', 'C6']

const FACTA_CODIGOS = [
  { codigo: '69205', label: '69205 — Novo Gold, 60x (1,45)' },
  { codigo: '69191', label: '69191 — Novo Gold, 36/48x (1,35)' },
  { codigo: '69183', label: '69183 — Novo Gold, 36/48x (1,35)' },
  { codigo: '69035', label: '69035 — Novo Gold, 36/48x (1,35)' },
  { codigo: '69027', label: '69027 — Novo Gold, 36/48x (1,35)' },
  { codigo: '69043', label: '69043 — Novo Gold, 36/48x (1,35)' },
  { codigo: '69051', label: '69051 — Novo Gold, 36/48x (1,35)' },
  { codigo: '69167', label: '69167 — Novo Gold, 24/60x (1,25)' },
  { codigo: '69175', label: '69175 — Novo Gold, 24/60x (1,25)' },
  { codigo: '69159', label: '69159 — Novo Gold, 48x (1,20)' },
  { codigo: '69140', label: '69140 — Novo Gold, 24/36x (1,15)' },
  { codigo: '69060', label: '69060 — Novo Gold, 24/36x (1,15)' },
  { codigo: '69132', label: '69132 — Novo Gold, 24x (1,10)' },
  { codigo: '692213', label: '692213 — Novo Smart, 24-60x (1,10)' },
  { codigo: '69221', label: '69221 — Novo Smart, 24-60x (1,10)' },
  { codigo: '69078', label: '69078 — Novo Gold, 36/48x (0,90)' },
  { codigo: '69086', label: '69086 — Novo Gold, 36/48x (0,90)' },
  { codigo: '69213', label: '69213 — Novo Smart: 24x (0,90) · 36/48/60x (1,10) — a partir de 01/09/2026' },
  { codigo: '69230', label: '69230 — Novo Smart: 24x (0,70) · 36/48x (1,10) — a partir de 01/09/2026' },
  { codigo: '69248', label: '69248 — Novo Smart, 24/36/48x (0,60 a partir de 01/09/2026)' },
  { codigo: '69116', label: '69116 — Novo Smart, 24-48x (0,90)' },
  { codigo: '69019', label: '69019 — Novo Gold, 24x (0,80)' },
  { codigo: '69094', label: '69094 — Novo Gold, 24x (0,80)' },
  { codigo: '69272', label: '69272 — Refin Gold Power, 36-60x (0,90)' },
  { codigo: '69264', label: '69264 — Refin Gold Plus, 36-60x (0,80)' },
  { codigo: '69256', label: '69256 — Refin Gold Prime, 36-60x (0,70)' },
  { codigo: '69280', label: '69280 — Refin, 36-60x (0,60)' },
  { codigo: '61107', label: '61107 — Portabilidade >12 pagas, 1-48x (0,35)' },
  { codigo: '61093', label: '61093 — Portabilidade >12 pagas, 1-48x (0,35)' },
  { codigo: '61085', label: '61085 — Portabilidade >12 pagas, 1-48x (0,35)' },
  { codigo: '69299', label: '69299 — Refin da Port, 36/60x (0,35)' },
  { codigo: '69302', label: '69302 — Refin da Port, 36/60x (0,35)' },
  { codigo: '64815', label: '64815 — Portabilidade <12 pagas, 1-48x (0,00)' },
  { codigo: '64823', label: '64823 — Portabilidade <12 pagas, 1-48x (0,00)' },
  { codigo: '64831', label: '64831 — Portabilidade <12 pagas, 1-48x (0,00)' },
  { codigo: '66036', label: '66036 — Novo Gold, 60x (1,15) / 48x com 66010 (1,00)' },
  { codigo: '66028', label: '66028 — Novo Gold, 60x (1,15) / 48x com 66010 (1,00)' },
  { codigo: '66010', label: '66010 — Novo Gold, 48x (1,00) / 36x (0,90)' },
  { codigo: '66060', label: '66060 — Novo Gold, 36x (0,90)' },
  { codigo: '66052', label: '66052 — Novo Gold, 36x (0,90)' },
  { codigo: '65951', label: '65951 — Novo Gold, 36x (0,90)' },
  { codigo: '66044', label: '66044 — Novo Gold, 24x (0,75)' },
  { codigo: '65943', label: '65943 — Novo Gold, 24x (0,75)' },
  { codigo: '66095', label: '66095 — Novo Smart, 48/60x (0,80) / 36x (0,65)' },
  { codigo: '66087', label: '66087 — Novo Smart, 48/60x (0,80) / 36x (0,65)' },
  { codigo: '66079', label: '66079 — Novo Smart, 36x (0,65) / 24x (0,55)' },
  { codigo: '65935', label: '65935 — Novo Smart, 36x (0,65) / 24x (0,55)' },
  { codigo: '641130', label: '641130 — Refin Gold, 36/48x (0,75)' },
  { codigo: '64181', label: '64181 — Refin, 36-60x (0,60)' },
  { codigo: '61433', label: '61433 — Refin da Port CLT, 36/48x (0,30)' },
  { codigo: '64785', label: '64785 — Refin da Port CLT, 36/48x (0,30)' },
]

// Modal de "Adicionar adesão", compartilhado entre o portal restrito da
// vendedora (vendedorFixo definido) e a visão geral de vendedoras (sem
// vendedorFixo — nesse caso exige selecionar a vendedora num dropdown).
// Envia sempre banco/tabela/parcelas/seguro pro backend, que calcula o
// peso via calc_peso_vendas (tabela_pontos + fallback), então os pesos
// batem automaticamente com a tabela vigente sem precisar hardcode aqui.
// Jornada Soma (Consulta Unificada) — botao 'Soma' na toolbar
// Jornada Soma (Consulta Unificada) — a plataforma percorre a cascata de
// bancarizadoras sozinha e para na primeira que aprovar margem.
//
// O aceite é do CLIENTE, não da vendedora: quando a jornada volta com
// linkAceite, ela fica travada em "Aguardando Aceite" e nenhuma bancarizadora
// roda até o cliente assinar (o termo expira em 24h). Por isso o link aqui é
// só copiado/enviado pro cliente — não abrimos nem assinamos por ele.
const SOMA_JORNADA_STATUS = {
  1: 'Em andamento — consultando bancarizadoras',
  2: 'Elegível — pode simular',
  3: 'Gerou proposta',
  4: 'Proposta paga',
  5: 'Não elegível — nenhuma bancarizadora aprovou',
  6: 'Erro — a plataforma vai tentar de novo',
  7: 'Aguardando o cliente assinar o termo',
  8: 'Expirada — o cliente não assinou em 24h',
  9: 'Proposta cancelada',
}

function SomaJornadaModal({ vendedorFixo, onClose }) {
  const [form, setForm] = useState({ cpf: '', nome: '', celular: '', dataNascimento: '' })
  const [jornada, setJornada] = useState(null)
  const [msg, setMsg] = useState('')
  const [carregando, setCarregando] = useState(false)
  const [copiado, setCopiado] = useState(false)
  const [simForm, setSimForm] = useState({ bancarizadora: '', tipoCalculo: 'VALOR_LIQUIDO', valor: '', parcelas: '', comSeguro: true })

  const chamar = async (payload) => {
    setCarregando(true); setMsg('')
    try {
      const d = await postApi('soma_jornada', payload)
      if (d?.error) { setMsg(d.error); return null }
      if (d?.message && !d?.jornadaId && !d?.jorId) { setMsg(d.message); return null }
      return d
    } catch (e) {
      setMsg('Erro: ' + (e.message || ''))
      return null
    } finally {
      setCarregando(false)
    }
  }

  const iniciar = async () => {
    if (!form.cpf || !form.nome || !form.celular) { setMsg('Preencha CPF, nome e celular.'); return }
    const d = await chamar({ acao: 'iniciar', ...form })
    if (d) { setJornada(d); setCopiado(false) }
  }

  const atualizar = async () => {
    const id = jornada?.jornadaId || jornada?.jorId
    if (!id) return
    const d = await chamar({ acao: 'status', jornadaId: id })
    if (d) setJornada((j) => ({ ...j, ...d }))
  }

  const simular = async () => {
    const id = jornada?.jornadaId || jornada?.jorId
    if (!id) return
    if (!simForm.bancarizadora) { setMsg('Escolha a bancarizadora.'); return }
    if (!simForm.valor) { setMsg('Informe o valor.'); return }
    const d = await chamar({
      acao: 'simular',
      jornadaId: id,
      bancarizadora: simForm.bancarizadora,
      tipoCalculo: simForm.tipoCalculo,
      valor: Number(String(simForm.valor).replace(',', '.')),
      parcelas: simForm.parcelas ? Number(simForm.parcelas) : undefined,
      comSeguro: simForm.comSeguro,
    })
    // A simulação nova aparece na jornada; recarrega pra listar todas.
    if (d) await atualizar()
  }

  const link = jornada?.linkAceite || jornada?.jorLinkAceite || null
  const statusId = jornada?.jorStatusId ?? jornada?.statusId ?? null
  const jornadaId = jornada?.jornadaId || jornada?.jorId || null
  const acoes = jornada?.acoes || []
  const bancas = [].concat(jornada?.bancaElegivel || []).filter(Boolean)
  const simulacoes = jornada?.simulacoes || []
  const podeSimular = acoes.includes('SIMULAR')
  const podeGerarProposta = acoes.includes('GERAR_PROPOSTA')

  return (
    <div className="funil-overlay" onClick={onClose}>
      <div className="funil-panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="funil-header">
          <div><h2>Soma &mdash; nova consulta</h2></div>
          <button className="funil-close" onClick={onClose}>&times;</button>
        </div>

        <div className="add-venda-form">
          {!jornada && (
            <>
              <label>CPF<input value={form.cpf} onChange={(e) => setForm({ ...form, cpf: e.target.value })} placeholder="somente n&uacute;meros" /></label>
              <label>Nome completo<input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} /></label>
              <label>Celular<input value={form.celular} onChange={(e) => setForm({ ...form, celular: e.target.value })} placeholder="DDD + n&uacute;mero" /></label>
              <label>Data de nascimento <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(algumas bancarizadoras exigem)</span>
                <input type="date" value={form.dataNascimento} onChange={(e) => setForm({ ...form, dataNascimento: e.target.value })} />
              </label>
              <button type="button" className="refresh-btn" onClick={iniciar} disabled={carregando}>
                {carregando ? 'Consultando...' : 'Consultar margem'}
              </button>
            </>
          )}

          {jornada && (
            <>
              <p className="kpi-sub" style={{ margin: '4px 0' }}>
                Jornada <strong>{jornadaId || '-'}</strong>
                {statusId != null && <> &middot; {SOMA_JORNADA_STATUS[statusId] || ('status ' + statusId)}</>}
              </p>

              {link && (
                <div style={{ border: '1px solid var(--border, #333)', borderRadius: 8, padding: 10, margin: '6px 0' }}>
                  <p className="kpi-sub" style={{ margin: '0 0 6px' }}>
                    <strong>Envie este link para o cliente assinar.</strong> Nenhuma bancarizadora consulta a margem
                    antes do aceite dele, e o termo expira em 24h. O aceite &eacute; do cliente &mdash; n&atilde;o
                    assine no lugar dele.
                  </p>
                  <input readOnly value={link} onClick={(e) => e.target.select()} style={{ width: '100%' }} />
                  <button type="button" className="refresh-btn" style={{ marginTop: 6, fontSize: 12, padding: '4px 8px' }}
                    onClick={() => { navigator.clipboard?.writeText(link); setCopiado(true) }}>
                    {copiado ? 'Link copiado' : 'Copiar link'}
                  </button>
                </div>
              )}

              {jornada?.margemDisponivel != null && (
                <p className="kpi-sub" style={{ margin: '2px 0' }}>
                  Margem dispon&iacute;vel: <strong>{fmtMoeda(jornada.margemDisponivel)}</strong>
                  {jornada?.margemValidaAte ? <> &middot; v&aacute;lida at&eacute; {String(jornada.margemValidaAte).slice(0, 10)}</> : null}
                </p>
              )}

              {/* A API diz em "acoes" o que dá pra fazer agora; a tela segue isso
                  em vez de adivinhar pelo status. Antes do aceite do cliente,
                  SIMULAR não vem e o bloco nem aparece. */}
              {podeSimular && (
                <div style={{ border: '1px solid var(--border, #333)', borderRadius: 8, padding: 10, margin: '6px 0' }}>
                  <p className="kpi-sub" style={{ margin: '0 0 6px' }}><strong>Simular</strong></p>
                  <label>Bancarizadora
                    <select value={simForm.bancarizadora} onChange={(e) => setSimForm({ ...simForm, bancarizadora: e.target.value })}>
                      <option value="">selecione</option>
                      {(bancas.length ? bancas : ['UY3', 'CELCOIN', '321BANK']).map((b) => (
                        <option key={b} value={b}>{b}</option>
                      ))}
                    </select>
                  </label>
                  <label>Tipo de c&aacute;lculo
                    <select value={simForm.tipoCalculo} onChange={(e) => setSimForm({ ...simForm, tipoCalculo: e.target.value })}>
                      <option value="VALOR_LIQUIDO">Valor liberado ao cliente</option>
                      <option value="VALOR_PARCELA">Valor da parcela</option>
                      <option value="VALOR_BRUTO">Valor bruto</option>
                    </select>
                  </label>
                  <label>Valor
                    <input value={simForm.valor} onChange={(e) => setSimForm({ ...simForm, valor: e.target.value })} placeholder="0,00" />
                  </label>
                  <label>Parcelas <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(opcional)</span>
                    <input value={simForm.parcelas} onChange={(e) => setSimForm({ ...simForm, parcelas: e.target.value })} placeholder="ex: 24" />
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={simForm.comSeguro} onChange={(e) => setSimForm({ ...simForm, comSeguro: e.target.checked })} />
                    Com seguro
                  </label>
                  <button type="button" className="refresh-btn" onClick={simular} disabled={carregando}>
                    {carregando ? 'Simulando...' : 'Simular'}
                  </button>
                </div>
              )}

              {simulacoes.length > 0 && (
                <div style={{ margin: '6px 0' }}>
                  <p className="kpi-sub" style={{ margin: '0 0 4px' }}><strong>Simula&ccedil;&otilde;es</strong></p>
                  {simulacoes.map((sm) => (
                    <div key={sm.simId} style={{ border: '1px solid var(--border, #333)', borderRadius: 8, padding: 8, marginBottom: 6 }}>
                      <div style={{ fontSize: 13 }}>
                        <strong>{sm.simBancarizadora}</strong> &middot; l&iacute;quido {fmtMoeda(sm.simValorLiquido)}
                        {sm.simParcelas ? <> &middot; {sm.simParcelas}x</> : null}
                        {sm.simValorParcela ? <> de {fmtMoeda(sm.simValorParcela)}</> : null}
                      </div>
                      {sm.simTaxaMensal != null && (
                        <div className="kpi-sub">Taxa {sm.simTaxaMensal}% a.m.</div>
                      )}
                    </div>
                  ))}
                  {!podeGerarProposta && (
                    <p className="kpi-sub" style={{ margin: '2px 0' }}>
                      Para gerar a proposta ainda falta cadastrar os dados banc&aacute;rios do cliente.
                    </p>
                  )}
                </div>
              )}

              <button type="button" className="refresh-btn" onClick={atualizar} disabled={carregando}>
                {carregando ? 'Atualizando...' : 'Atualizar status'}
              </button>
              <button type="button" className="reset-btn" style={{ fontSize: 12, padding: '4px 8px' }}
                onClick={() => { setJornada(null); setMsg('') }}>
                &larr; Nova consulta
              </button>
            </>
          )}

          {msg && <p className="kpi-sub" style={{ margin: '6px 0' }}>{msg}</p>}
        </div>
      </div>
    </div>
  )
}

function AddVendaModal({ vendedorFixo, vendedoresDisponiveis, onClose, onAdded }) {
  const [addForm, setAddForm] = useState({
    vendedorSel: vendedorFixo || '',
    banco: '', adesao: '', cpf: '', nome: '', valor: '', codigo: '', tabelaNome: '', dataPagamento: '', parcelas: '', seguro: '',
  })
  const [addMsg, setAddMsg] = useState('')
  const [adding, setAdding] = useState(false)
  const [buscando, setBuscando] = useState(false)
  const [buscaResultado, setBuscaResultado] = useState(null)
  const [manualApesarDeApi, setManualApesarDeApi] = useState(false)

  const ehBancoComApi = BANCOS_COM_API.includes(addForm.banco) && !manualApesarDeApi

  // Bancos cuja API nunca traz uma tabela comercial confiável — mesmo quando
  // acha a proposta, a vendedora precisa escolher a tabela na mão.
  const BANCOS_TABELA_SEMPRE_MANUAL = ['C6']

  const buscarNaApi = async () => {
    if (!addForm.adesao) { setAddMsg('Informe a adesão pra buscar.'); return }
    setBuscando(true); setAddMsg(''); setBuscaResultado(null)
    try {
      const d = await postApi('consulta_adesao_banco', { banco: addForm.banco, adesao: addForm.adesao, cpf: addForm.cpf || null })
      if (d?.error) { setAddMsg(d.error); return }
      setBuscaResultado(d)
      if (d.encontrado) {
        setAddForm((f) => ({
          ...f,
          cpf: d.cpf_banco || f.cpf,
          nome: d.nome_banco || f.nome,
          valor: d.valor_banco != null ? String(d.valor_banco) : f.valor,
          tabelaNome: d.tabela_banco || f.tabelaNome,
          parcelas: d.parcelas_banco != null ? String(d.parcelas_banco) : f.parcelas,
        }))
        // Achou a proposta, mas esse banco não manda tabela confiável — ainda
        // precisa abrir o campo pra vendedora escolher a tabela na mão.
        if (BANCOS_TABELA_SEMPRE_MANUAL.includes(addForm.banco)) setManualApesarDeApi(true)
      } else {
        // Não achou: abre o formulário completo direto, sem precisar de um
        // segundo clique da vendedora.
        setManualApesarDeApi(true)
      }
    } catch (e2) {
      setAddMsg('Erro na busca: ' + (e2.message || ''))
    } finally {
      setBuscando(false)
    }
  }

  const handleAdd = async (e) => {
    e.preventDefault()
    const vendedorAlvo = vendedorFixo || addForm.vendedorSel
    if (!vendedorAlvo) {
      setAddMsg('Selecione a vendedora.')
      return
    }
    if (ehBancoComApi && (!addForm.cpf || !addForm.nome || !addForm.valor)) {
      setAddMsg('Busque a adesão antes de adicionar.')
      return
    }
    setAdding(true)
    setAddMsg('')
    try {
      const ehPorCodigo = !ehBancoComApi && BANCOS_POR_CODIGO.includes(addForm.banco)
      const ehPorTabelaNome = !ehBancoComApi && BANCOS_POR_TABELA_NOME.includes(addForm.banco)
      // Soma/Presença manuais: não têm dropdown de código nem de tabela fixa,
      // usam o campo de texto livre — sem isso a tabela ia sempre vazia.
      const ehTabelaLivreDeApiBanco = !ehBancoComApi && BANCOS_COM_API.includes(addForm.banco) && !ehPorCodigo && !ehPorTabelaNome
      const precisaParcelasComTabelaNome = BANCOS_TABELA_NOME_COM_PARCELAS.includes(addForm.banco)
      const result = await postApi('vendedoras_add_venda', {
        vendedor: vendedorAlvo,
        adesao: addForm.adesao,
        cpf: addForm.cpf,
        nome: addForm.nome,
        valor: addForm.valor.replace(',', '.'),
        banco: addForm.banco,
        tabela: ehPorCodigo ? addForm.codigo : (ehPorTabelaNome || ehBancoComApi || ehTabelaLivreDeApiBanco ? addForm.tabelaNome : ''),
        data_pagamento: addForm.dataPagamento,
        parcelas: (ehPorTabelaNome && !precisaParcelasComTabelaNome) ? '' : addForm.parcelas,
        seguro: (ehPorTabelaNome || ehBancoComApi) ? '' : addForm.seguro,
      })
      const r = result?.[0]
      if (r?.ok) {
        setAddMsg('Venda adicionada. Sincronizando...')
        setAddForm({ vendedorSel: vendedorFixo || '', banco: '', adesao: '', cpf: '', nome: '', valor: '', codigo: '', tabelaNome: '', dataPagamento: '', parcelas: '', seguro: '' })
        setBuscaResultado(null)
        if (onAdded) await onAdded()
        setAddMsg('Concluído!')
        setTimeout(() => { onClose(); setAddMsg('') }, 1500)
      } else {
        setAddMsg(r?.mensagem || 'Não foi possível adicionar.')
      }
    } catch (e2) {
      setAddMsg('Erro: ' + (e2.message || ''))
    } finally {
      setAdding(false)
    }
  }

  const tabelaOpcoes = addForm.banco === 'FGTSV8' ? FGTSV8_TABELAS
    : addForm.banco === 'C6' ? C6_TABELAS
    : NOVO_SAQUE_TABELAS

  return (
    <div className="funil-overlay" onClick={onClose}>
      <div className="funil-panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="funil-header">
          <div><h2>Adicionar ades&atilde;o</h2></div>
          <button className="funil-close" onClick={onClose}>&times;</button>
        </div>
        <form className="add-venda-form" onSubmit={handleAdd}>
          {!vendedorFixo && (
            <label>Vendedora
              <select required value={addForm.vendedorSel} onChange={(e) => setAddForm({ ...addForm, vendedorSel: e.target.value })}>
                <option value="">selecione a vendedora</option>
                {(vendedoresDisponiveis || []).map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          )}

          {/* Banco vem primeiro: define o resto do formulário */}
          <label>Banco
            <select required value={addForm.banco} onChange={(e) => {
              setAddForm({ ...addForm, banco: e.target.value, codigo: '', tabelaNome: '', parcelas: '', seguro: '', adesao: '', valor: '', cpf: '', nome: '' })
              setBuscaResultado(null)
              setManualApesarDeApi(false)
            }}>
              <option value="">selecione o banco</option>
              {BANCOS_VENDA.map((b) => <option key={b} value={b}>{b}{BANCOS_COM_API.includes(b) ? ' (busca automática)' : ''}</option>)}
            </select>
          </label>

          {addForm.banco && ehBancoComApi && (
            <>
              <label>Ades&atilde;o
                <div style={{ display: 'flex', gap: 6 }}>
                  <input required value={addForm.adesao} onChange={(e) => { setAddForm({ ...addForm, adesao: e.target.value }); setBuscaResultado(null) }} style={{ flex: 1 }} />
                  <button type="button" className="refresh-btn" onClick={buscarNaApi} disabled={buscando}>
                    {buscando ? 'Buscando...' : 'Buscar'}
                  </button>
                </div>
              </label>

              {buscaResultado?.encontrado && (
                <>
                  <p className="kpi-sub" style={{ margin: '-4px 0 4px' }}>
                    Encontrado: {buscaResultado.nome_banco || addForm.nome || '(nome não veio da API)'} · {fmtMoeda(buscaResultado.valor_banco)}
                    {buscaResultado.parcelas_banco != null ? ` · ${buscaResultado.parcelas_banco}x` : ''}
                    {buscaResultado.status_banco ? ` · ${buscaResultado.status_banco}` : ''}
                  </p>
                  <button type="button" className="refresh-btn" style={{ fontSize: 12, padding: '4px 8px' }} onClick={() => setManualApesarDeApi(true)}>
                    N&atilde;o &eacute; essa proposta? Preencher manualmente
                  </button>
                </>
              )}
            </>
          )}

          {addForm.banco && !ehBancoComApi && (
            <>
              <label>Ades&atilde;o<input required value={addForm.adesao} onChange={(e) => setAddForm({ ...addForm, adesao: e.target.value })} /></label>
              <label>CPF<input required value={addForm.cpf} onChange={(e) => setAddForm({ ...addForm, cpf: e.target.value })} /></label>
              <label>Nome<input required value={addForm.nome} onChange={(e) => setAddForm({ ...addForm, nome: e.target.value })} /></label>
              <label>Valor<input required value={addForm.valor} onChange={(e) => setAddForm({ ...addForm, valor: e.target.value })} placeholder="0,00" /></label>

              {BANCOS_POR_CODIGO.includes(addForm.banco) && (
                <>
                  <label>C&oacute;digo da tabela
                    <select required value={addForm.codigo} onChange={(e) => setAddForm({ ...addForm, codigo: e.target.value })}>
                      <option value="">selecione o c&oacute;digo</option>
                      {FACTA_CODIGOS.map((c) => <option key={c.codigo} value={c.codigo}>{c.label}</option>)}
                    </select>
                  </label>
                  <label>Parcelas <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(s&oacute; necess&aacute;rio pra alguns c&oacute;digos)</span>
                    <input value={addForm.parcelas} onChange={(e) => setAddForm({ ...addForm, parcelas: e.target.value })} placeholder="ex: 36" />
                  </label>
                </>
              )}

              {BANCOS_POR_TABELA_NOME.includes(addForm.banco) && (
                <label>Tabela
                  <select required value={addForm.tabelaNome} onChange={(e) => setAddForm({ ...addForm, tabelaNome: e.target.value })}>
                    <option value="">selecione a tabela</option>
                    {tabelaOpcoes.map((t) => <option key={t.valor} value={t.valor}>{t.label}</option>)}
                  </select>
                </label>
              )}
              {BANCOS_TABELA_NOME_COM_PARCELAS.includes(addForm.banco) && (
                <label>Parcelas
                  <input required value={addForm.parcelas} onChange={(e) => setAddForm({ ...addForm, parcelas: e.target.value })} placeholder="ex: 48" />
                </label>
              )}

              {!BANCOS_POR_CODIGO.includes(addForm.banco) && !BANCOS_POR_TABELA_NOME.includes(addForm.banco) && (
                <>
                  {BANCOS_COM_API.includes(addForm.banco) && (
                    <label>Tabela <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(copie o nome/c&oacute;digo da tabela do portal do banco)</span>
                      <input required value={addForm.tabelaNome} onChange={(e) => setAddForm({ ...addForm, tabelaNome: e.target.value })} />
                    </label>
                  )}
                  <label>Parcelas
                    <input required value={addForm.parcelas} onChange={(e) => setAddForm({ ...addForm, parcelas: e.target.value })} placeholder="ex: 24" />
                  </label>
                  <label>Seguro
                    <select value={addForm.seguro} onChange={(e) => setAddForm({ ...addForm, seguro: e.target.value })}>
                      <option value="">n&atilde;o informado</option>
                      <option value="sim">Com seguro</option>
                      <option value="nao">Sem seguro</option>
                    </select>
                  </label>
                </>
              )}

              {manualApesarDeApi && (
                <button type="button" className="refresh-btn" style={{ fontSize: 12, padding: '4px 8px' }} onClick={() => setManualApesarDeApi(false)}>
                  &larr; Voltar pra busca autom&aacute;tica
                </button>
              )}
            </>
          )}

          <label>Data de pagamento <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(vazio = hoje)</span>
            <input type="date" value={addForm.dataPagamento} onChange={(e) => setAddForm({ ...addForm, dataPagamento: e.target.value })} />
          </label>

          {addMsg && <p className="state-msg" style={{ margin: '4px 0' }}>{addMsg}</p>}
          <button type="submit" className="refresh-btn" disabled={adding}>{adding ? 'Enviando...' : 'Adicionar'}</button>
        </form>
      </div>
    </div>
  )
}


// Novo Saque — botão único que decide sozinho o que mostrar pro CPF digitado:
//  - já existe proposta pra esse CPF (propostas_bancos) -> só mostra o status
//  - não existe -> consulta saldo/ofertas (apenas_consultar:true, nunca
//    formaliza sozinho); se tiver oferta(s), a vendedora ESCOLHE qual tabela
//    formalizar (o Novo Saque libera saldo por tabela/oferta, não é um valor
//    único) e só então informa o pagamento e confirma de vez.
function NovoSaqueModal({ vendedorFixo, onClose }) {
  const [etapa, setEtapa] = useState('cpf') // cpf | status | manual | ofertas | pagamento | feito
  const [cpf, setCpf] = useState('')
  const [produto, setProduto] = useState('FGTS')
  const [status, setStatus] = useState(null)
  const [consulta, setConsulta] = useState(null)
  const [ofertaEscolhida, setOfertaEscolhida] = useState(null)
  const [resultado, setResultado] = useState(null)
  const [erro, setErro] = useState('')
  const [carregando, setCarregando] = useState(false)

  const [manual, setManual] = useState({ name: '', birth_date: '', email: '', gender: 'M', street: '', number: '', neighborhood: '', city: '', state: '', zip_code: '' })
  const [usouManual, setUsouManual] = useState(false)
  const [pagamento, setPagamento] = useState({ tipo: 'pix', pix_key: '', pix_key_type: 'cpf', bank_code: '', bank_account: '', bank_account_digit: '', bank_branch: '', bank_account_type: 'CAC' })

  const doc = String(cpf).replace(/\D/g, '')

  const montaCustomerDataManual = () => ({
    name: manual.name, birth_date: manual.birth_date, email: manual.email, gender: manual.gender,
    address: { street: manual.street, number: manual.number, neighborhood: manual.neighborhood, city: manual.city, state: manual.state, zip_code: manual.zip_code },
  })
  const montaDadosPagamento = () => pagamento.tipo === 'pix'
    ? { pix_key: pagamento.pix_key, pix_key_type: pagamento.pix_key_type }
    : { bank_code: pagamento.bank_code, bank_account: pagamento.bank_account, bank_account_digit: pagamento.bank_account_digit, bank_branch: pagamento.bank_branch, bank_account_type: pagamento.bank_account_type }

  // Passo 1: CPF -> primeiro checa se já existe proposta; só consulta saldo
  // na API do banco se ainda não tiver nenhuma ação registrada pra esse CPF
  const iniciar = async (e) => {
    e?.preventDefault()
    if (doc.length !== 11) { setErro('CPF precisa ter 11 dígitos.'); return }
    setCarregando(true); setErro('')
    try {
      const s = await postApi('novo_saque_status', { cpf: doc })
      if (s?.error) { setErro(s.error); return }
      if (s?.existe) {
        setStatus(s.proposta)
        setEtapa('status')
        return
      }
      await consultarOferta()
    } catch (e2) {
      setErro('Erro na consulta: ' + (e2.message || ''))
      setCarregando(false)
    }
  }

  const consultarOferta = async (manualPreenchido) => {
    setCarregando(true); setErro('')
    try {
      const body = { cpf: doc, product: produto, vendedor: vendedorFixo || null, apenas_consultar: true }
      if (manualPreenchido) body.customer_data_manual = manualPreenchido
      const d = await postApi('novo_saque_saldo', body)
      if (d?.error) { setErro(d.error); return }
      if (d?.precisa_manual) { setEtapa('manual'); return }
      if (!d?.oferta) { setErro(d?.mensagem || 'Nenhuma oferta disponível para esse CPF.'); return }
      setUsouManual(!!manualPreenchido)
      setConsulta(d)
      setEtapa('ofertas')
    } catch (e2) {
      setErro('Erro na consulta: ' + (e2.message || ''))
    } finally {
      setCarregando(false)
    }
  }

  const enviarManual = (e) => {
    e.preventDefault()
    consultarOferta(montaCustomerDataManual())
  }

  const escolherOferta = (oferta) => {
    setOfertaEscolhida(oferta)
    setEtapa('pagamento')
  }

  const confirmarProposta = async (e) => {
    e.preventDefault()
    const pg = montaDadosPagamento()
    if (pagamento.tipo === 'pix' && !pg.pix_key) { setErro('Informe a chave PIX.'); return }
    if (pagamento.tipo === 'conta' && (!pg.bank_code || !pg.bank_account)) { setErro('Informe banco e conta.'); return }
    setCarregando(true); setErro('')
    try {
      const body = {
        cpf: doc, product: produto, vendedor: vendedorFixo || null,
        apenas_consultar: false, dados_pagamento: pg,
        simulation_id_escolhido: ofertaEscolhida?.simulation_id || null,
      }
      if (usouManual) body.customer_data_manual = montaCustomerDataManual()
      const d = await postApi('novo_saque_saldo', body)
      if (d?.error) { setErro(d.error); return }
      setResultado(d)
      setEtapa('feito')
    } catch (e2) {
      setErro('Erro ao enviar proposta: ' + (e2.message || ''))
    } finally {
      setCarregando(false)
    }
  }

  return (
    <div className="funil-overlay" onClick={onClose}>
      <div className="funil-panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 580 }}>
        <div className="funil-header">
          <div><h2>Novo Saque</h2></div>
          <button className="funil-close" onClick={onClose}>&times;</button>
        </div>

        {(etapa === 'cpf' || etapa === 'manual') && (
          <form className="add-venda-form" onSubmit={etapa === 'manual' ? enviarManual : iniciar}>
            <label>CPF do cliente
              <input required value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="somente números" disabled={etapa === 'manual'} />
            </label>
            <label>Produto
              <select value={produto} onChange={(e) => setProduto(e.target.value)} disabled={etapa === 'manual'}>
                <option value="FGTS">FGTS</option>
                <option value="CLT">CLT</option>
              </select>
            </label>

            {etapa === 'manual' && (
              <>
                <p className="state-msg" style={{ margin: '4px 0' }}>
                  CPF n&atilde;o encontrado no Lemit. Preencha os dados do cliente.
                </p>
                <label>Nome completo<input required value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} /></label>
                <label>Data de nascimento<input required type="date" value={manual.birth_date} onChange={(e) => setManual({ ...manual, birth_date: e.target.value })} /></label>
                <label>E-mail<input type="email" value={manual.email} onChange={(e) => setManual({ ...manual, email: e.target.value })} /></label>
                <label>Sexo
                  <select value={manual.gender} onChange={(e) => setManual({ ...manual, gender: e.target.value })}>
                    <option value="M">Masculino</option>
                    <option value="F">Feminino</option>
                  </select>
                </label>
                <label>CEP<input value={manual.zip_code} onChange={(e) => setManual({ ...manual, zip_code: e.target.value })} /></label>
                <label>Rua<input value={manual.street} onChange={(e) => setManual({ ...manual, street: e.target.value })} /></label>
                <label>N&uacute;mero<input value={manual.number} onChange={(e) => setManual({ ...manual, number: e.target.value })} /></label>
                <label>Bairro<input value={manual.neighborhood} onChange={(e) => setManual({ ...manual, neighborhood: e.target.value })} /></label>
                <label>Cidade<input value={manual.city} onChange={(e) => setManual({ ...manual, city: e.target.value })} /></label>
                <label>Estado (UF)<input maxLength={2} value={manual.state} onChange={(e) => setManual({ ...manual, state: e.target.value.toUpperCase() })} /></label>
              </>
            )}

            <button type="submit" className="refresh-btn" disabled={carregando}>
              {carregando ? 'Consultando...' : 'Consultar'}
            </button>
          </form>
        )}

        {etapa === 'status' && status && (
          <div>
            <p className="kpi-label">Proposta j&aacute; existe pra esse CPF</p>
            <p className="kpi-value" style={{ color: status.pago ? 'var(--green, #7ddc9a)' : 'var(--text)' }}>
              {status.pago ? 'Paga' : status.cancelado ? 'Cancelada' : (status.status || 'Em andamento')}
            </p>
            <p className="kpi-sub">{status.tabela_nome || '-'} {status.valor ? `· ${fmtMoeda(status.valor)}` : ''} {status.parcelas ? `· ${status.parcelas}x` : ''}</p>
            <p className="kpi-sub" style={{ wordBreak: 'break-all' }}>proposta: {status.proposal_id}</p>
            <p className="kpi-sub">registrada em: {new Date(status.criado_em).toLocaleString('pt-BR')}</p>
            {status.lancado_em_vendas && <p className="kpi-sub">j&aacute; lan&ccedil;ada em vendas.</p>}
          </div>
        )}

        {etapa === 'ofertas' && consulta && (
          <div>
            <p className="kpi-label">{consulta.cliente || 'Cliente'}</p>
            <p className="kpi-sub" style={{ marginBottom: 10 }}>
              O Novo Saque libera saldo por tabela — escolha a oferta pra formalizar.
            </p>
            <div className="panel table-panel">
              <div className="template-row head" style={{ gridTemplateColumns: '1.6fr 0.6fr 1fr 1fr 0.9fr' }}>
                <span>Tabela</span><span>Parc.</span><span>Liberado</span><span>Parcela</span><span></span>
              </div>
              {(consulta.todas_ofertas || []).map((o, i) => (
                <div className="template-row" key={i} style={{ gridTemplateColumns: '1.6fr 0.6fr 1fr 1fr 0.9fr', alignItems: 'center' }}>
                  <span>{o.tabela || '-'}</span>
                  <span>{o.parcelas ?? '-'}</span>
                  <span>{fmtMoeda(o.liberado)}</span>
                  <span>{fmtMoeda(o.parcela)}</span>
                  <button type="button" className="refresh-btn" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => escolherOferta(o)}>
                    Selecionar
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {etapa === 'pagamento' && ofertaEscolhida && (
          <form className="add-venda-form" onSubmit={confirmarProposta}>
            <p className="kpi-label">Oferta escolhida</p>
            <p className="kpi-value" style={{ color: 'var(--green, #7ddc9a)' }}>{fmtMoeda(ofertaEscolhida.liberado)}</p>
            <p className="kpi-sub" style={{ marginBottom: 10 }}>{ofertaEscolhida.tabela} &middot; {ofertaEscolhida.parcelas}x de {fmtMoeda(ofertaEscolhida.parcela)}</p>
            <button type="button" className="refresh-btn" style={{ marginBottom: 8 }} onClick={() => setEtapa('ofertas')}>&larr; Trocar oferta</button>

            <label>Forma de pagamento
              <select value={pagamento.tipo} onChange={(e) => setPagamento({ ...pagamento, tipo: e.target.value })}>
                <option value="pix">PIX</option>
                <option value="conta">Conta banc&aacute;ria</option>
              </select>
            </label>

            {pagamento.tipo === 'pix' ? (
              <>
                <label>Tipo de chave
                  <select value={pagamento.pix_key_type} onChange={(e) => setPagamento({ ...pagamento, pix_key_type: e.target.value })}>
                    <option value="cpf">CPF</option>
                    <option value="email">E-mail</option>
                    <option value="phone_number">Telefone</option>
                    <option value="aleatory_key">Chave aleat&oacute;ria</option>
                  </select>
                </label>
                <label>Chave PIX<input required value={pagamento.pix_key} onChange={(e) => setPagamento({ ...pagamento, pix_key: e.target.value })} /></label>
              </>
            ) : (
              <>
                <label>C&oacute;digo do banco<input required value={pagamento.bank_code} onChange={(e) => setPagamento({ ...pagamento, bank_code: e.target.value })} /></label>
                <label>Ag&ecirc;ncia<input value={pagamento.bank_branch} onChange={(e) => setPagamento({ ...pagamento, bank_branch: e.target.value })} /></label>
                <label>Conta<input required value={pagamento.bank_account} onChange={(e) => setPagamento({ ...pagamento, bank_account: e.target.value })} /></label>
                <label>D&iacute;gito<input value={pagamento.bank_account_digit} onChange={(e) => setPagamento({ ...pagamento, bank_account_digit: e.target.value })} /></label>
                <label>Tipo de conta
                  <select value={pagamento.bank_account_type} onChange={(e) => setPagamento({ ...pagamento, bank_account_type: e.target.value })}>
                    <option value="CAC">Corrente</option>
                    <option value="TRAN">Pagamento</option>
                    <option value="SLRY">Sal&aacute;rio</option>
                    <option value="SVG">Poupan&ccedil;a</option>
                  </select>
                </label>
              </>
            )}

            <button type="submit" className="refresh-btn" disabled={carregando}>
              {carregando ? 'Enviando...' : 'Confirmar e enviar proposta'}
            </button>
          </form>
        )}

        {etapa === 'feito' && resultado && (
          <div>
            <p className="state-msg" style={{ margin: '4px 0 10px' }}>
              {resultado.ok ? 'Proposta enviada para formalização.' : 'Não foi possível formalizar a proposta.'}
            </p>
            {resultado.transaction_id && <p className="kpi-sub" style={{ wordBreak: 'break-all' }}>proposta: {resultado.transaction_id}</p>}
            <button className="refresh-btn" onClick={onClose}>Fechar</button>
          </div>
        )}

        {erro && <p className="state-msg error" style={{ marginTop: 10 }}>{erro}</p>}
      </div>
    </div>
  )
}


// URL do site de playbooks (projeto separado, "hotline-playbook").
const PLAYBOOK_BASE_URL = 'https://hotline-playbook.vercel.app'

// Botão "Info Produtos": abre direto a Home do site de playbooks (sem
// menuzinho de seleção) num iframe em cima de tudo — o usuário escolhe o
// produto lá dentro.
// Menu genérico de "mais opções" (três risquinhos) — agrupa ações menos
// usadas do topbar num só botão, pra não lotar a barra de filtros.
function MenuOpcoes({ itens, title = 'Mais opções' }) {
  const [aberto, setAberto] = useState(false)
  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button className="dots-btn" onClick={() => setAberto((v) => !v)} title={title} style={{ fontSize: 15 }}>
        &#9776;
      </button>
      {aberto && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 199 }} onClick={() => setAberto(false)} />
          <div className="playbook-dropdown" style={{ width: 200 }}>
            {itens.map((it, i) => (
              <button
                key={i}
                className="playbook-dropdown-item"
                disabled={it.disabled}
                onClick={() => { it.onClick(); setAberto(false) }}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function PlaybookMenuButton() {
  const [aberto, setAberto] = useState(false)

  return (
    <>
      <button
        className="reset-btn"
        title="Info Produtos"
        onClick={() => setAberto(true)}
      >
        Info Produtos
      </button>
      {aberto && (
        <div className="playbook-iframe-overlay">
          <button className="playbook-iframe-close" onClick={() => setAberto(false)}>✕ Fechar</button>
          <iframe src={PLAYBOOK_BASE_URL} title="Playbook" className="playbook-iframe" />
        </div>
      )}
    </>
  )
}


// URL do webhook n8n que consulta o FAQ via IA.
const IA_WEBHOOK_URL = 'https://hotn8n.querosacarfgts.com.br/webhook/vendedoras-ia'

async function treinoPost(acao, extra = {}) {
  const res = await fetch('/api/ia?type=treino', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ acao, ...extra }),
  })
  const data = await res.json()
  if (!res.ok || data?.ok === false) throw new Error(data?.error || data?.erro || `Erro na ação "${acao}"`)
  return data
}

const FASE_LABEL_TREINO = {
  1: 'Início / contextualização',
  2: 'Vendedora na trilha',
  3: 'Perto do especialista',
  4: 'Especialista',
  5: 'Batendo a meta',
}

function fmtNotaTreino(v) {
  return v === null || v === undefined ? '—' : Number(v).toFixed(2).replace('.', ',')
}

// Botão com símbolo de IA: abre um chat moderno (gradiente animado) que
// consulta o webhook do n8n. Nunca fecha sozinho -- só no X.
function TreinamentoPainel({ vendedor }) {
  const [abas, setAbas] = useState([])
  const [loadingAbas, setLoadingAbas] = useState(true)
  const [erro, setErro] = useState('')
  const [sessaoAtiva, setSessaoAtiva] = useState(null) // {sessao_id, fase, ciclo, nota_minima, status}
  const [mensagens, setMensagens] = useState([])
  const [resultado, setResultado] = useState(null)
  const [input, setInput] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [abrindo, setAbrindo] = useState(false)
  const listRef = useRef(null)

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [mensagens, enviando])

  const carregarAbas = useCallback(() => {
    setLoadingAbas(true); setErro('')
    treinoPost('historico', { vendedor })
      .then((r) => setAbas(r.abas || []))
      .catch((e) => setErro(e.message))
      .finally(() => setLoadingAbas(false))
  }, [vendedor])

  useEffect(() => { carregarAbas() }, [carregarAbas])

  async function iniciarNovo() {
    setAbrindo(true); setErro(''); setResultado(null)
    try {
      const r = await treinoPost('iniciar', { vendedor })
      setSessaoAtiva({ sessao_id: r.sessao_id, fase: r.fase, ciclo: r.ciclo, nota_minima: r.nota_minima, status: 'aberta' })
      setMensagens([{ origem: 'CLIENTE_IA', conteudo: r.mensagem_cliente }])
      carregarAbas()
    } catch (e) {
      setErro(e.message)
    } finally {
      setAbrindo(false)
    }
  }

  async function abrirSessao(aba) {
    setAbrindo(true); setErro(''); setResultado(null)
    try {
      const r = await treinoPost('mensagens', { sessao_id: aba.sessao_id })
      setSessaoAtiva({ sessao_id: r.sessao_id, fase: r.fase, ciclo: r.ciclo, nota_minima: r.nota_minima, status: r.status })
      setMensagens(r.mensagens || [])
      if (r.status === 'encerrada') {
        setResultado({
          nota_final: r.nota_final, classificacao: r.classificacao, atingiu_minimo: r.atingiu_minimo,
          resumo: r.resumo_final,
        })
      }
    } catch (e) {
      setErro(e.message)
    } finally {
      setAbrindo(false)
    }
  }

  async function enviar() {
    const texto = input.trim()
    if (!texto || enviando || !sessaoAtiva) return
    setInput('')
    setMensagens((m) => [...m, { origem: 'VENDEDOR', conteudo: texto }])
    setEnviando(true)
    try {
      const r = await treinoPost('mensagem', { sessao_id: sessaoAtiva.sessao_id, mensagem: texto })
      setMensagens((m) => [...m, {
        origem: 'CLIENTE_IA', conteudo: r.mensagem_cliente,
        veredito: r.feedback?.veredito, feedback: r.feedback?.texto, sugestao: r.feedback?.sugestao,
        passo_fluxograma: r.feedback?.passo, delta_pontos: r.feedback?.delta,
      }])
      setSessaoAtiva((s) => ({ ...s, notaParcial: r.nota_parcial }))
    } catch (e) {
      setMensagens((m) => [...m, { origem: 'CLIENTE_IA', conteudo: 'Erro ao processar sua mensagem. Tente de novo.' }])
    } finally {
      setEnviando(false)
    }
  }

  async function encerrar() {
    if (!sessaoAtiva || enviando) return
    setEnviando(true)
    try {
      const r = await treinoPost('encerrar', { sessao_id: sessaoAtiva.sessao_id })
      setResultado(r)
      setSessaoAtiva((s) => ({ ...s, status: 'encerrada' }))
      carregarAbas()
    } catch (e) {
      setErro(e.message)
    } finally {
      setEnviando(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      enviar()
    }
  }

  return (
    <div className="trein-painel">
      <div className="trein-abas">
        {abas.map((a) => (
          <button
            key={a.sessao_id}
            className={`trein-aba ${sessaoAtiva?.sessao_id === a.sessao_id ? 'ativa' : ''}`}
            onClick={() => abrirSessao(a)}
            title={a.titulo}
          >
            {a.status === 'aberta' ? '● ' : ''}
            {a.titulo?.replace(/^Treino\s*/, '') || 'Sessão'}
            {a.nota_final != null && <span className="trein-aba-nota"> · {fmtNotaTreino(a.nota_final)}</span>}
          </button>
        ))}
        <button className="trein-aba trein-aba-novo" onClick={iniciarNovo} disabled={abrindo}>+ Novo</button>
      </div>

      {loadingAbas && <div className="ai-msg ai-msg-ia">Carregando sessões...</div>}
      {erro && <div className="ai-msg ai-msg-ia" style={{ color: 'var(--rose)' }}>{erro}</div>}

      {!sessaoAtiva && !loadingAbas && (
        <div className="ai-chat-empty">Clique em "+ Novo" pra começar um treino, ou escolha uma sessão acima pra rever.</div>
      )}

      {sessaoAtiva && (
        <>
          <div className="trein-status-bar">
            <span>Fase {sessaoAtiva.fase} — {FASE_LABEL_TREINO[sessaoAtiva.fase]}</span>
            <span>Ciclo {sessaoAtiva.ciclo}</span>
            <span>Mínimo {fmtNotaTreino(sessaoAtiva.nota_minima)}</span>
          </div>

          <div className="ai-chat-messages" ref={listRef}>
            {mensagens.map((m, i) => (
              <div key={i}>
                <div className={`ai-msg ${m.origem === 'VENDEDOR' ? 'ai-msg-user' : 'ai-msg-ia'}`}>{m.conteudo}</div>
                {m.origem === 'CLIENTE_IA' && m.feedback && (
                  <div className={`trein-feedback trein-feedback-${m.veredito || 'neutro'}`}>
                    <div className="trein-feedback-topo">
                      <span className="trein-feedback-veredito">
                        {m.veredito === 'acerto' ? '✓ Acerto' : m.veredito === 'erro' ? '✗ Erro' : m.veredito === 'parcial' ? '◐ Parcial' : '—'}
                      </span>
                      {m.delta_pontos != null && (
                        <span className="trein-feedback-delta">{m.delta_pontos > 0 ? '+' : ''}{m.delta_pontos}</span>
                      )}
                      {m.passo_fluxograma && <span className="trein-feedback-passo">passo {m.passo_fluxograma}</span>}
                    </div>
                    <div>{m.feedback}</div>
                    {m.sugestao && <div className="trein-feedback-sugestao">💡 {m.sugestao}</div>}
                  </div>
                )}
              </div>
            ))}
            {enviando && <div className="ai-msg ai-msg-ia ai-msg-loading">Consultando...</div>}
          </div>

          {resultado && (
            <div className="trein-resultado">
              <div className="trein-resultado-nota">
                {fmtNotaTreino(resultado.nota_final)} / 10 — {resultado.classificacao}
              </div>
              {resultado.promoveu && (
                <div className="trein-resultado-promoveu">
                  🎉 Subiu para Fase {resultado.nova_fase} · Ciclo {resultado.novo_ciclo}!
                </div>
              )}
              {resultado.resumo && <div className="trein-resultado-resumo">{resultado.resumo}</div>}
            </div>
          )}

          {sessaoAtiva.status !== 'encerrada' && (
            <div className="ai-chat-inputbar">
              <textarea
                className="ai-chat-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Responda seu cliente por aqui..."
                rows={1}
              />
              <button className="ai-chat-send" onClick={enviar} disabled={enviando || !input.trim()}>Enviar</button>
              <button className="reset-btn" onClick={encerrar} disabled={enviando} title="Encerrar e ver a nota final">
                Encerrar e ver nota
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function AIChatButton({ vendedor }) {
  const [open, setOpen] = useState(false)
  const [modo, setModo] = useState('consulta') // 'consulta' | 'treinamento'
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [historicoCarregado, setHistoricoCarregado] = useState(false)
  const [carregandoHistorico, setCarregandoHistorico] = useState(false)
  const [mostrarMemoria, setMostrarMemoria] = useState(false)
  const [memoriaPergunta, setMemoriaPergunta] = useState('')
  const [memoriaResposta, setMemoriaResposta] = useState('')
  const [enviandoMemoria, setEnviandoMemoria] = useState(false)
  const [memoriaMsg, setMemoriaMsg] = useState('')
  const listRef = useRef(null)

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages, sending])

  useEffect(() => {
    if (!open || modo !== 'consulta' || historicoCarregado) return
    setCarregandoHistorico(true)
    const url = `${IA_WEBHOOK_URL}?Acao=historico&Vendedora=${encodeURIComponent(vendedor || 'geral')}`
    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        if (data?.ok && Array.isArray(data.mensagens) && data.mensagens.length > 0) {
          setMessages(data.mensagens)
        }
      })
      .catch(() => {})
      .finally(() => {
        setHistoricoCarregado(true)
        setCarregandoHistorico(false)
      })
  }, [open, modo, historicoCarregado, vendedor])

  async function enviarMemoria() {
    const pergunta = memoriaPergunta.trim()
    const resposta = memoriaResposta.trim()
    if (!pergunta || !resposta || enviandoMemoria) return
    setEnviandoMemoria(true)
    setMemoriaMsg('')
    try {
      const url = `${IA_WEBHOOK_URL}?Acao=memoria&Vendedora=${encodeURIComponent(vendedor || 'geral')}&Pergunta=${encodeURIComponent(pergunta)}&Resposta=${encodeURIComponent(resposta)}`
      const res = await fetch(url)
      const data = await res.json()
      if (data?.ok) {
        setMemoriaMsg(data.mensagem || 'Informação registrada!')
        setMemoriaPergunta('')
        setMemoriaResposta('')
      } else {
        setMemoriaMsg('Não consegui salvar agora. Tente de novo.')
      }
    } catch (e) {
      setMemoriaMsg('Erro ao salvar. Tente de novo.')
    } finally {
      setEnviandoMemoria(false)
    }
  }

  async function send() {
    const pergunta = input.trim()
    if (!pergunta || sending) return
    setInput('')
    setMessages((m) => [...m, { role: 'user', text: pergunta }])
    setSending(true)
    try {
      const url = `${IA_WEBHOOK_URL}?Pergunta=${encodeURIComponent(pergunta)}&Vendedora=${encodeURIComponent(vendedor || 'geral')}`
      const res = await fetch(url)
      const data = await res.json()
      const resposta = data?.resposta || 'Não consegui consultar agora. Tente novamente em instantes.'
      setMessages((m) => [...m, { role: 'ia', text: resposta }])
    } catch (e) {
      setMessages((m) => [...m, { role: 'ia', text: 'Erro ao consultar a IA. Verifique a conexão e tente de novo.' }])
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <>
      <button className="reset-btn ai-trigger-btn" title="Consultar IA" onClick={() => setOpen(true)}>
        <svg viewBox="0 0 1024 1024" className="ai-trigger-icon" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="aiTigerGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="var(--gold)" />
              <stop offset="50%" stopColor="var(--lime)" />
              <stop offset="100%" stopColor="var(--rose)" />
              <animateTransform attributeName="gradientTransform" type="translate" values="-0.6 0; 0.6 0; -0.6 0" dur="4s" repeatCount="indefinite" />
            </linearGradient>
          </defs>
          <g transform="translate(0,1024) scale(0.1,-0.1)" fill="url(#aiTigerGrad)">
            <path d="M2229 7883 c-5 -16 -14 -39 -19 -53 -49 -131 -90 -409 -90 -614 0 -421 116 -776 371 -1130 l31 -44 -22 -69 c-86 -264 -149 -567 -166 -789 l-7 -87 -62 -28 c-100 -45 -253 -86 -406 -109 -79 -11 -145 -23 -147 -25 -7 -7 98 -196 152 -274 102 -149 286 -317 450 -414 l48 -28 -24 -17 c-43 -33 -153 -99 -226 -136 -40 -20 -72 -42 -72 -49 0 -29 134 -202 225 -290 122 -118 327 -244 485 -296 36 -12 70 -25 76 -29 7 -4 39 -48 72 -98 183 -273 499 -451 957 -539 387 -74 457 -88 540 -112 236 -67 441 -167 637 -310 l87 -64 73 54 c285 210 576 324 1028 401 401 69 615 142 832 282 125 80 272 238 324 346 16 35 25 40 109 68 195 65 345 159 500 315 93 92 215 248 215 274 0 4 -28 22 -62 40 -95 50 -189 107 -227 135 l-34 25 48 28 c169 100 360 277 456 423 62 93 154 259 147 265 -2 2 -67 13 -143 25 -154 23 -312 65 -409 109 l-63 29 -8 78 c-20 223 -67 462 -142 715 l-46 157 45 58 c170 222 294 526 339 830 39 265 16 584 -60 849 -18 61 -36 114 -41 119 -5 5 -70 -12 -151 -38 -538 -177 -910 -420 -1195 -781 l-32 -39 -98 46 c-112 52 -263 112 -311 122 -26 6 -32 4 -38 -13 -3 -12 -24 -43 -46 -71 -21 -27 -39 -52 -39 -54 0 -3 26 -13 58 -21 141 -39 369 -144 531 -246 73 -45 82 -46 221 -4 155 47 371 170 445 255 l20 23 -65 -7 c-36 -4 -164 -27 -285 -51 -121 -24 -221 -43 -222 -41 -6 6 127 155 193 214 206 188 455 337 754 450 159 60 150 62 171 -35 32 -148 42 -278 36 -468 -9 -270 -50 -440 -162 -670 -69 -141 -113 -212 -199 -319 -31 -38 -56 -75 -56 -81 0 -6 16 -58 36 -115 43 -126 96 -324 119 -440 16 -81 44 -256 45 -273 0 -7 -122 55 -221 112 -38 22 -45 9 -24 -41 108 -250 375 -434 727 -502 l56 -11 -36 -55 c-101 -151 -326 -332 -552 -445 -52 -26 -97 -49 -99 -51 -15 -14 148 -146 293 -238 l87 -54 -38 -43 c-146 -164 -314 -272 -531 -344 -90 -29 -134 -64 -160 -124 -36 -89 -148 -210 -261 -285 -199 -133 -402 -202 -779 -266 -349 -59 -520 -110 -757 -225 -82 -40 -187 -98 -233 -128 l-83 -56 -84 55 c-212 138 -452 241 -698 299 -56 13 -192 39 -302 58 -110 20 -238 45 -285 57 -375 95 -629 264 -749 498 -31 61 -71 90 -167 123 -216 75 -402 194 -510 327 l-44 54 87 55 c49 31 106 69 128 86 65 51 165 139 165 146 0 4 -35 24 -77 45 -188 91 -362 214 -468 328 -62 67 -135 164 -135 179 0 4 19 9 43 13 117 19 313 91 425 158 85 50 219 189 269 278 23 41 45 88 49 104 l7 29 -99 -53 c-54 -29 -108 -59 -119 -67 -38 -26 -46 -17 -39 40 19 166 110 533 169 692 14 36 25 71 25 78 0 6 -27 46 -60 87 -155 192 -277 450 -331 698 -30 138 -37 453 -15 612 9 63 22 140 29 170 16 67 10 67 184 4 339 -122 578 -261 766 -443 72 -69 177 -198 177 -216 0 -9 2 -9 -257 43 -110 23 -230 44 -265 48 l-63 6 35 -36 c51 -54 168 -132 268 -178 83 -39 266 -98 301 -98 9 0 61 28 116 61 271 164 586 277 920 329 77 12 151 28 165 36 69 39 232 114 290 133 177 57 414 87 615 76 140 -7 213 -19 258 -42 28 -14 28 -15 10 -35 -32 -37 -153 -121 -368 -257 -268 -170 -274 -174 -269 -182 2 -4 32 -10 66 -14 184 -21 403 -104 505 -191 54 -46 99 -101 90 -110 -3 -3 -90 -21 -193 -40 -104 -19 -193 -39 -198 -44 -4 -4 26 -27 70 -51 166 -91 302 -214 385 -348 24 -38 48 -70 53 -71 15 0 -2 164 -23 225 -11 32 -34 79 -50 104 l-30 46 24 7 c14 3 63 9 110 13 47 4 88 12 91 17 10 16 -34 142 -73 206 -80 132 -172 214 -320 288 l-82 40 132 87 c182 120 255 194 272 274 14 70 -32 146 -113 187 -79 40 -182 58 -372 63 -331 9 -568 -38 -840 -169 -84 -41 -144 -63 -185 -69 -281 -39 -612 -141 -847 -260 -60 -30 -63 -31 -75 -13 -250 357 -539 561 -1059 748 -92 32 -295 96 -309 96 -3 0 -10 -12 -16 -27z M6061 5878 c-29 -99 -93 -201 -175 -283 -45 -45 -96 -87 -113 -94 -18 -7 -33 -17 -33 -20 0 -4 15 -15 34 -23 94 -45 225 -209 277 -345 22 -59 39 -80 39 -50 0 6 23 59 51 117 44 90 64 117 133 185 44 45 96 87 114 94 17 7 32 17 32 21 0 4 -15 14 -32 21 -18 7 -69 49 -114 94 -82 82 -146 184 -175 283 -7 23 -15 42 -19 42 -4 0 -12 -19 -19 -42z M4887 5497 c-153 -441 -442 -796 -807 -991 l-84 -45 33 -18 c18 -10 70 -40 115 -66 330 -195 589 -524 736 -936 18 -50 36 -91 40 -91 4 0 20 35 34 78 154 439 456 805 818 992 38 19 68 37 68 40 0 3 -44 29 -98 58 -354 192 -636 543 -788 980 -16 45 -31 82 -34 82 -3 0 -18 -37 -33 -83z M6310 4827 c0 -36 -65 -140 -116 -186 -31 -28 -60 -51 -65 -51 -18 0 -8 -16 22 -34 50 -30 97 -87 135 -164 l36 -74 22 55 c13 30 32 68 44 84 23 32 88 94 118 112 19 11 18 11 -1 23 -49 29 -115 103 -144 162 -17 35 -31 69 -31 75 0 6 -4 11 -10 11 -5 0 -10 -6 -10 -13z" />
          </g>
        </svg>
      </button>
      {open && (
        <div className="ai-chat-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}>
          <div className="ai-chat-sheet">
            <div className="ai-chat-gradient" />
            <div className="ai-chat-header">
              <div>
                <div className="ai-chat-title">{modo === 'consulta' ? 'Consulta rápida · IA' : 'Treinamento · IA'}</div>
                <div className="ai-chat-subtitle">
                  {modo === 'consulta'
                    ? 'Pergunte sobre qualquer produto — a resposta vem direto do FAQ oficial.'
                    : 'Treine e melhore seu atendimento nesta aba!'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {modo === 'consulta' && (
                  <button
                    className="reset-btn"
                    onClick={() => { setMostrarMemoria((v) => !v); setMemoriaMsg('') }}
                  >
                    {mostrarMemoria ? 'Chat' : 'Memória'}
                  </button>
                )}
                <button
                  className="reset-btn"
                  onClick={() => setModo(modo === 'consulta' ? 'treinamento' : 'consulta')}
                >
                  {modo === 'consulta' ? 'Treinamento' : 'Consulta'}
                </button>
                <button className="ai-chat-close" onClick={() => setOpen(false)}>Encerrar ✕</button>
              </div>
            </div>

            {modo === 'consulta' ? (
              mostrarMemoria ? (
                <div className="ai-chat-messages" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div className="ai-chat-empty" style={{ padding: 0, textAlign: 'left' }}>
                    Adicione uma informação nova pra IA aprender — vale pra todas as vendedoras, não só pra você. Descreva a situação/pergunta separada da resposta, pra IA achar mais fácil quando for relevante.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ fontSize: 11.5, color: 'var(--muted)', textTransform: 'uppercase' }}>Pergunta / situação</label>
                    <input
                      type="text"
                      className="ai-chat-input"
                      style={{ width: '100%' }}
                      value={memoriaPergunta}
                      onChange={(e) => setMemoriaPergunta(e.target.value)}
                      placeholder='Ex: "Cliente autônomo pode contratar o Empréstimo na Conta de Luz?"'
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ fontSize: 11.5, color: 'var(--muted)', textTransform: 'uppercase' }}>Resposta</label>
                    <textarea
                      className="ai-chat-input"
                      style={{ minHeight: 100, width: '100%' }}
                      value={memoriaResposta}
                      onChange={(e) => setMemoriaResposta(e.target.value)}
                      placeholder="Explique a resposta certa — evite deixar específico demais de um banco/caso só, se a regra valer pra geral."
                    />
                  </div>
                  {memoriaMsg && (
                    <div className="ai-chat-subtitle" style={{ color: 'var(--lime)' }}>{memoriaMsg}</div>
                  )}
                  <button className="ai-chat-send" onClick={enviarMemoria} disabled={enviandoMemoria || !memoriaPergunta.trim() || !memoriaResposta.trim()} style={{ alignSelf: 'flex-start' }}>
                    {enviandoMemoria ? 'Salvando...' : 'Salvar'}
                  </button>
                </div>
              ) : (
              <>
                <div className="ai-chat-messages" ref={listRef}>
                  {carregandoHistorico && (
                    <div className="ai-chat-empty">Carregando conversa anterior...</div>
                  )}
                  {!carregandoHistorico && messages.length === 0 && (
                    <div className="ai-chat-empty">Digite sua dúvida abaixo. Ex: "Cliente negativado pode contratar o CLT?"</div>
                  )}
                  {messages.map((m, i) => (
                    <div key={i} className={`ai-msg ai-msg-${m.role}`}>{m.text}</div>
                  ))}
                  {sending && <div className="ai-msg ai-msg-ia ai-msg-loading">Consultando...</div>}
                </div>

                <div className="ai-chat-inputbar">
                  <textarea
                    className="ai-chat-input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Escreva sua dúvida..."
                    rows={1}
                  />
                  <button className="ai-chat-send" onClick={send} disabled={sending || !input.trim()}>Enviar</button>
                </div>
              </>
              )
            ) : (
              <TreinamentoPainel vendedor={vendedor} />
            )}
          </div>
        </div>
      )}
    </>
  )
}


const MASCOT_IMG_URL = 'https://hotlinesolucoes.com.br/wp-content/uploads/2024/08/macote.png'

function unionRect(a, b) {
  if (!a) return b
  if (!b) return a
  const left = Math.min(a.left, b.left)
  const top = Math.min(a.top, b.top)
  const right = Math.max(a.right, b.right)
  const bottom = Math.max(a.bottom, b.bottom)
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

const ONBOARDING_MESSAGES = [
  'Seja bem-vindo ao seu Dashboard de Vendas!',
  'Aqui você pode acompanhar suas vendas todos os dias',
  'Aqui você pode consultar propostas no Facta, diretamente',
  'Aqui você adiciona suas vendas diariamente',
  'Aqui você conversa com uma IA para tirar suas dúvidas do seu dia a dia',
]

function OnboardingTour({ step, onNext, targets }) {
  const [rect, setRect] = useState(null)

  useEffect(() => {
    function measure() {
      const t = targets[step]
      if (!t || t.length === 0) { setRect(null); return }
      if (t.length === 1) {
        setRect(t[0].current ? t[0].current.getBoundingClientRect() : null)
      } else {
        const r1 = t[0].current ? t[0].current.getBoundingClientRect() : null
        const r2 = t[1].current ? t[1].current.getBoundingClientRect() : null
        setRect(unionRect(r1, r2))
      }
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [step, targets])

  const pad = 10
  return (
    <div className="onboarding-overlay">
      {rect && (
        <div
          className="onboarding-spotlight"
          style={{
            left: rect.left - pad,
            top: rect.top - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
          }}
        />
      )}
      <div className="onboarding-bubble">
        <img src={MASCOT_IMG_URL} alt="Esquentadinho" />
        <div className="onboarding-text">{ONBOARDING_MESSAGES[step]}</div>
        <button className="onboarding-next" onClick={onNext}>Próximo →</button>
      </div>
    </div>
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

  const [modo, setModo] = useState('valor') // 'valor' | 'ponto'
  const fmtV = modo === 'ponto' ? ((v) => `${fmtInt(Math.round(v ?? 0))} pts`) : fmtMoeda

  const [showAdd, setShowAdd] = useState(false)
  const [showNovoSaque, setShowNovoSaque] = useState(false)
  const [showSomaJornada, setShowSomaJornada] = useState(false)
  const [showFacta, setShowFacta] = useState(false)
  const [onboardingStep, setOnboardingStep] = useState(() => (
    new URLSearchParams(window.location.search).get('onboarding') === '1' ? 0 : -1
  ))
  const tourChartRef = useRef(null)
  const tourKpiRef = useRef(null)
  const tourFactaRef = useRef(null)
  const tourAddRef = useRef(null)
  const tourAiRef = useRef(null)
  const ONBOARDING_TARGETS = [null, [tourChartRef, tourKpiRef], [tourFactaRef], [tourAddRef], [tourAiRef]]
  function nextOnboardingStep() {
    if (onboardingStep >= ONBOARDING_MESSAGES.length - 1) {
      setOnboardingStep(5)
    } else {
      setOnboardingStep((s) => s + 1)
    }
  }
  function finishOnboarding() {
    setOnboardingStep(-1)
    const url = new URL(window.location.href)
    url.searchParams.delete('onboarding')
    window.history.replaceState({}, '', url.toString())
  }
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

  // monta os dois pontos do gráfico: realizado (acumulado, só semanas
  // passadas) e projeção (linha tracejada da última semana real até o
  // total projetado, na última semana do mês)
  const chartData = useMemo(() => {
    if (!semanas.length) return []
    const hoje = todayISO()
    let acumulado = 0
    let marcosBatidos = 0
    const campoSemana = modo === 'ponto' ? 'ponto_semana' : 'valor_semana'
    // "iniciada" = a semana já começou (mesmo que ainda não tenha terminado)
    // — o valor_semana dela já reflete só os dias que realmente aconteceram,
    // então conta como realizado até agora, não como projeção
    const semanasIniciadas = semanas.filter((s) => s.inicio.slice(0, 10) <= hoje)
    const ultimaIniciada = semanasIniciadas[semanasIniciadas.length - 1]
    const projecaoFinal = meta ? Number(modo === 'ponto' ? meta.pontos_projecao_mes : meta.projecao_mes) : 0

    return semanas.map((s) => {
      const valor = Number(s[campoSemana]) || 0
      const iniciada = s.inicio.slice(0, 10) <= hoje
      if (iniciada) acumulado += valor
      const row = { semana: s.semana_label }
      let nivel = null
      if (modo !== 'ponto' && valor >= META_SEMANA && s.passada && marcosBatidos < 4) {
        marcosBatidos += 1
        nivel = marcosBatidos
      }
      if (iniciada) {
        row.realizado = acumulado
        row.nivel = nivel
        if (s.semana === ultimaIniciada?.semana) {
          row.projecao = acumulado
          row.ehSemanaAtual = true
          row.projecaoMesTotal = projecaoFinal
        }
      } else if (ultimaIniciada) {
        const totalSemanas = semanas.length
        const semanasRestantes = totalSemanas - ultimaIniciada.semana
        const passo = semanasRestantes > 0 ? (projecaoFinal - acumuladoAteUltima(semanas, ultimaIniciada, hoje, campoSemana)) / semanasRestantes : 0
        row.projecao = acumuladoAteUltima(semanas, ultimaIniciada, hoje, campoSemana) + passo * (s.semana - ultimaIniciada.semana)
      }
      return row
    })
  }, [semanas, meta, modo])

  function acumuladoAteUltima(lista, ultima, hoje, campo) {
    let soma = 0
    for (const s of lista) {
      if (s.semana <= ultima.semana) soma += Number(s[campo]) || 0
    }
    return soma
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
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <RefinButton vendedor={vendedor} modo="vendedora" />
          <ArquivosButton dono={vendedor} />
          <PlaybookMenuButton />
          <span ref={tourAiRef} style={{ display: 'inline-flex' }}><AIChatButton vendedor={vendedor} /></span>
          <button className="reset-btn" onClick={() => setModo(modo === 'valor' ? 'ponto' : 'valor')} title="Alternar entre valor e pontos">
            {modo === 'valor' ? '⇄ Ver em pontos' : '⇄ Ver em valor'}
          </button>
          <button className="reset-btn" onClick={onLogout} title="Sair">Sair</button>
        </div>
      </div>

      <div className="topbar">
        <h1><span className="pulse" /> Minhas Vendas</h1>
        <div className="topbar-right">
          <span className="status-line">
            {loading ? 'atualizando...' : lastUpdate ? `atualizado às ${fmtHora(lastUpdate)}` : ''}
          </span>
          <button className="reset-btn" onClick={() => { setDataInicio(week.from); setDataFim(week.to) }} title="Redefinir filtros">
            &#10226; Redefinir filtros
          </button>
          <button ref={tourAddRef} className="refresh-btn" onClick={() => setShowAdd(true)} title="Adicionar adesão">
            + Adicionar adesão
          </button>
          <button className="refresh-btn" onClick={() => setShowNovoSaque(true)} title="Novo Saque: consulta status, saldo/ofertas e cadastro de proposta">
            Novo Saque
          </button>
          <button className="refresh-btn" onClick={() => setShowSomaJornada(true)} title="Soma: consulta de margem, simula&ccedil;&atilde;o e cadastro de proposta">
            Soma
          </button>
          <button ref={tourFactaRef} className="refresh-btn" onClick={() => setShowFacta(true)} title="Consultar proposta na Facta por CPF ou c&oacute;digo AF">
            Consulta Facta
          </button>
          <button className="refresh-btn" onClick={load} disabled={loading} title="Atualizar agora">
            &#8635; Atualizar
          </button>
        </div>
      </div>

      <DateRangeFilter dataInicio={dataInicio} setDataInicio={setDataInicio} dataFim={dataFim} setDataFim={setDataFim} />

      {error && <div className="state-msg error">Erro: {error}</div>}

      <div ref={tourChartRef} className="panel chart-panel tall">
        <p className="section-label">Vendas por semana &mdash; {modo === 'ponto' ? 'pontos' : 'meta'} e proje&ccedil;&atilde;o</p>
        <p className="section-sub">{modo === 'ponto' ? 'exibindo em pontos' : `meta de ${fmtMoeda(META_SEMANA)}/semana`} &middot; linha tracejada = proje&ccedil;&atilde;o do m&ecirc;s</p>
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

      <div ref={tourKpiRef} className="kpi-grid kpi-grid-3">
        <div className="kpi"><p className="kpi-label">Maior {modo === 'ponto' ? 'pontua&ccedil;&atilde;o' : 'venda'}</p><p className="kpi-value">{fmtV(modo === 'ponto' ? kpis?.maior_pontuacao : kpis?.maior_venda)}</p></div>
        <div className="kpi"><p className="kpi-label">Dia com mais vendas</p><p className="kpi-value" style={{ fontSize: 16 }}>{kpis?.dia_mais_vendas ? fmtDataBR(kpis.dia_mais_vendas) : '-'}</p><p className="kpi-sub">{fmtInt(kpis?.dia_mais_vendas_qtd)} vendas</p></div>
        <div className="kpi">
          <p className="kpi-label">{modo === 'ponto' ? 'Pontos totais' : 'Valor total vendido'}</p>
          <p className="kpi-value kpi-split"><span>{fmtV(modo === 'ponto' ? kpis?.pontos_total : kpis?.valor_total)}</span><span className="kpi-split-bar">|</span><span className="kpi-split-proj">{fmtV(modo === 'ponto' ? meta?.pontos_projecao_mes_real : meta?.projecao_mes_real)}</span></p>
          <p className="kpi-sub">realizado | proje&ccedil;&atilde;o do m&ecirc;s</p>
          <p className="kpi-sub">considerando hoje: {fmtV(modo === 'ponto' ? meta?.pontos_projecao_mes : meta?.projecao_mes)}</p>
        </div>
        <div className="kpi"><p className="kpi-label">Quantidade total</p><p className="kpi-value">{fmtInt(kpis?.qtd_total)}</p></div>
        <div className="kpi"><p className="kpi-label">Banco mais vendido</p><p className="kpi-value" style={{ fontSize: 16 }}>{kpis?.banco_top || '-'}</p><p className="kpi-sub">{fmtInt(kpis?.banco_top_qtd)} vendas</p></div>
        {modo !== 'ponto' && (
          <>
            <div className="kpi"><p className="kpi-label">Semanas com meta batida</p><p className="kpi-value">{fmtInt(semanasBatidas.length)}</p></div>
            {semanasBatidas.slice(0, 3).map((s) => (
              <div className="kpi" key={s.semana}><p className="kpi-label">Semana {s.semana_label}</p><p className="kpi-value" style={{ fontSize: 16 }}>{fmtMoeda(s.valor_semana)}</p></div>
            ))}
          </>
        )}
        {meta && (
          <>
            <div className="kpi">
              <p className="kpi-label">M&eacute;dia di&aacute;ria | semanal</p>
              <p className="kpi-value kpi-split">
                <span>{fmtV(meta.dias_uteis_passados > 0 ? (modo === 'ponto' ? meta.pontos_mes_atual : meta.total_mes_atual) / meta.dias_uteis_passados : 0)}</span>
                <span className="kpi-split-bar">|</span>
                <span className="kpi-split-proj">{fmtV(meta.dias_uteis_passados > 0 ? ((modo === 'ponto' ? meta.pontos_mes_atual : meta.total_mes_atual) / meta.dias_uteis_passados) * 5 : 0)}</span>
              </p>
              <p className="kpi-sub">m&eacute;dia semanal = di&aacute;ria &times; 5 dias &uacute;teis</p>
            </div>
            <div className="kpi">
              <p className="kpi-label">Proje&ccedil;&atilde;o di&aacute;ria | semanal</p>
              <p className="kpi-value kpi-split">
                <span>{fmtV(modo === 'ponto' ? meta.pontos_projecao_diaria : meta.projecao_diaria)}</span>
                <span className="kpi-split-bar">|</span>
                <span className="kpi-split-proj">{fmtV(modo === 'ponto' ? meta.pontos_projecao_semanal : meta.projecao_semanal)}</span>
              </p>
              <p className="kpi-sub">ritmo por hora &uacute;til (8h&ndash;18h) de hoje/semana</p>
            </div>
          </>
        )}
      </div>

      <div className="panel table-panel">
        <p className="section-label">Minhas vendas ({fmtInt(tabela.total)})</p>
        <div className="template-row head" style={{ gridTemplateColumns: '1fr 1fr 1fr 0.8fr' }}>
          <span>{modo === 'ponto' ? 'Pontos' : 'Valor'}</span><span>CPF</span><span>Banco</span><span>Data</span>
        </div>
        {tabela.rows.length === 0 && !loading && (
          <div className="state-msg">Nenhuma venda encontrada para os filtros selecionados.</div>
        )}
        {tabela.rows.map((r, i) => (
          <div className="template-row" key={i} style={{ gridTemplateColumns: '1fr 1fr 1fr 0.8fr' }}>
            <span>{fmtV(modo === 'ponto' ? r.ponto : r.valor)}</span>
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
        <AddVendaModal
          vendedorFixo={vendedor}
          onClose={() => setShowAdd(false)}
          onAdded={async () => { await callApi('vendedoras_sync', {}); await load() }}
        />
      )}
      {showNovoSaque && <NovoSaqueModal vendedorFixo={vendedor} onClose={() => setShowNovoSaque(false)} />}
      {showSomaJornada && <SomaJornadaModal vendedorFixo={vendedor} onClose={() => setShowSomaJornada(false)} />}
      {showFacta && <FactaConsultaOverlay onClose={() => setShowFacta(false)} />}

      {onboardingStep >= 0 && onboardingStep < 5 && (
        <OnboardingTour step={onboardingStep} onNext={nextOnboardingStep} targets={ONBOARDING_TARGETS} />
      )}
      {onboardingStep === 5 && (
        <div className="onboarding-final-overlay">
          <div className="onboarding-bubble onboarding-bubble-top">
            <img src={MASCOT_IMG_URL} alt="Esquentadinho" />
            <div className="onboarding-text">E, por fim, aqui você aprende mais informações sobre nossos produtos</div>
            <button className="onboarding-next" onClick={finishOnboarding}>Concluir →</button>
          </div>
          <iframe src="https://hotline-playbook.vercel.app" title="Playbooks" className="playbook-iframe onboarding-final-iframe" />
        </div>
      )}
    </div>
  )
}
function VendedorasView() {
  const week = presetRange('este_mes') // padrão: mês corrente inteiro
  const [vendedores, setVendedores] = useState([])
  const [bancosDisponiveis, setBancosDisponiveis] = useState([])
  const [vendedorSel, setVendedorSel] = useState([])
  const [bancoSel, setBancoSel] = useState([])
  // "vendedor" (singular) só existe quando exatamente 1 está selecionada —
  // é o que ativa o modo de detalhe individual, igual antes
  const vendedor = vendedorSel.length === 1 ? vendedorSel[0] : ''
  const vendedorLista = vendedorSel.join(',')
  const banco = bancoSel.join(',')
  const [dataInicio, setDataInicio] = useState(week.from)
  const [dataFim, setDataFim] = useState(week.to)

  const [kpisGeral, setKpisGeral] = useState(null)
  const [kpisVendedor, setKpisVendedor] = useState(null)
  const [mediasGeral, setMediasGeral] = useState(null)
  const [metaVendedor, setMetaVendedor] = useState(null)
  const [porDia, setPorDia] = useState({ rows: [], vendedoresVistos: [] })
  const [tabela, setTabela] = useState({ rows: [], total: 0 })
  const [page, setPage] = useState(0) // 0 = 10 itens, 1 = 40 itens, 2+ = pagina de 30 depois dos 40

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [showRanking, setShowRanking] = useState(false)
  const [showFacta, setShowFacta] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [showNovoSaque, setShowNovoSaque] = useState(false)
  const [showSomaJornada, setShowSomaJornada] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const fileInputRef = useRef(null)

  const [modo, setModo] = useState('valor') // 'valor' | 'ponto'
  const fmtV = modo === 'ponto' ? ((v) => `${fmtInt(Math.round(v ?? 0))} pts`) : fmtMoeda

  const [showMetaConfig, setShowMetaConfig] = useState(false)
  const [metas, setMetas] = useState(null)
  const [metaForm, setMetaForm] = useState(null)
  const [salvandoMeta, setSalvandoMeta] = useState(false)

  const loadMetas = useCallback(async () => {
    try {
      const m = await callApi('metas_progresso', { vendedor })
      setMetas(m?.[0] ?? null)
    } catch { /* silencioso */ }
  }, [vendedor])

  useEffect(() => { loadMetas() }, [loadMetas])

  const abrirMetaConfig = () => {
    setMetaForm({
      valor_diaria: metas?.valor_diaria ?? 0,
      valor_semanal: metas?.valor_semanal ?? 0,
      valor_mensal: metas?.valor_mensal ?? 0,
      ponto_diaria: metas?.ponto_diaria ?? 0,
      ponto_semanal: metas?.ponto_semanal ?? 0,
      ponto_mensal: metas?.ponto_mensal ?? 0,
      tipo_ativo: metas?.tipo_ativo ?? 'valor',
      periodo_ativo: metas?.periodo_ativo ?? 'semanal',
    })
    setShowMetaConfig(true)
  }

  const salvarMeta = async () => {
    setSalvandoMeta(true)
    try {
      await postApi('metas_set', metaForm)
      await loadMetas()
      setShowMetaConfig(false)
    } catch (e) {
      alert('Erro ao salvar meta: ' + (e.message || ''))
    } finally {
      setSalvandoMeta(false)
    }
  }

  useEffect(() => {
    callApi('vendedoras_filtros', {})
      .then((d) => { setVendedores(d?.[0]?.vendedores || []); setBancosDisponiveis(d?.[0]?.bancos || []) })
      .catch(() => {})
  }, [])

  useEffect(() => { setPage(0) }, [vendedor, banco, dataInicio, dataFim])

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
      const [dia, tab, medias] = await Promise.all([
        callApi('vendedoras_por_dia', { vendedor: vendedorLista, date_from, date_to, banco }),
        callApi('vendedoras_tabela', { vendedor, date_from, date_to, limit: String(limit), offset: String(offset) }),
        callApi('vendedoras_medias_geral', {}),
      ])
      setMediasGeral(medias?.[0] ?? null)

      const porDiaMap = {}
      const totalPorVendedor = {}
      for (const row of dia ?? []) {
        const total = modo === 'ponto' ? Number(row.pontos_total) : Number(row.valor_total)
        totalPorVendedor[row.vendedor] = (totalPorVendedor[row.vendedor] || 0) + total
        if (!porDiaMap[row.dia]) porDiaMap[row.dia] = { dia: row.dia }
        porDiaMap[row.dia][`${row.vendedor}__vendas`] = Number(row.vendas)
        porDiaMap[row.dia][row.vendedor] = modo === 'ponto' ? Number(row.pontos_total) : Number(row.valor_total)
        porDiaMap[row.dia][`${row.vendedor}__valor`] = Number(row.valor_total)
        porDiaMap[row.dia][`${row.vendedor}__pontos`] = Number(row.pontos_total)
      }
      // maior total primeiro — antes ficava na ordem de chegada da query (aleatório)
      const vendedoresVistos = Object.keys(totalPorVendedor).sort((a, b) => totalPorVendedor[b] - totalPorVendedor[a])
      setPorDia({
        rows: Object.values(porDiaMap).sort((a, b) => (a.dia > b.dia ? 1 : -1)),
        vendedoresVistos,
      })

      setTabela({ rows: tab ?? [], total: tab?.[0]?.total_count ? Number(tab[0].total_count) : 0 })

      if (vendedor) {
        const [kv, mv] = await Promise.all([
          callApi('vendedoras_kpis_vendedor', { vendedor, date_from, date_to }),
          callApi('vendedoras_meta', { vendedor }),
        ])
        setKpisVendedor(kv?.[0] ?? null)
        setMetaVendedor(mv?.[0] ?? null)
        setKpisGeral(null)
      } else {
        const kg = await callApi('vendedoras_kpis_geral', { date_from, date_to, banco })
        setKpisGeral(kg?.[0] ?? null)
        setKpisVendedor(null)
        setMetaVendedor(null)
      }

      setLastUpdate(new Date())
    } catch (e) {
      setError(e.message || 'Erro ao carregar dados.')
    } finally {
      setLoading(false)
    }
  }, [vendedor, vendedorLista, banco, dataInicio, dataFim, limit, offset, modo])

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
          ? `Concluído — ${fmtInt(s.atualizados_vendedoras)} vendedoras com dados completos, ${fmtInt(s.atualizados_disparochat)} atualizadas em disparochat, ${fmtInt(s.atualizados_total_produtos)} em total_produtos, ${fmtInt(s.atualizados_leads_chatwoot)} em leads_chatwoot.`
          : 'Sincronização concluída.'
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
        setImportMsg('Nenhuma linha válida encontrada no arquivo.')
        return
      }
      const result = await postApi('vendedoras_import', { rows })
      const r = result?.[0]
      setImportMsg(
        `Importação concluída — ${fmtInt(r?.inseridos)} vendas novas adicionadas, ${fmtInt(r?.ignorados)} já existiam (mesmo CPF + adesão) e foram ignoradas. Sincronizando...`
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

  const handleDownload = () => {
    const qs = new URLSearchParams({ type: 'vendedoras_export', vendedor, date_from: dataInicio || '', date_to: dataFim || '' })
    window.open(`/api/dashboard?${qs.toString()}`, '_blank')
  }

  return (
    <>
      <div className="topbar">
        <h1><span className="pulse" /> Vendedoras</h1>
        <div className="topbar-right">
          <span className="status-line">
            {loading ? 'atualizando...' : lastUpdate ? `atualizado às ${fmtHora(lastUpdate)}` : ''}
          </span>
          <button className="reset-btn" onClick={() => { setVendedorSel([]); setBancoSel([]); setDataInicio(week.from); setDataFim(week.to) }} title="Redefinir filtros">
            &#10226; Redefinir filtros
          </button>
          <button className="refresh-btn" onClick={() => setShowAdd(true)} title="Adicionar adesão para qualquer vendedora">
            + Adicionar adesão
          </button>
          <button className="refresh-btn" onClick={() => setShowNovoSaque(true)} title="Novo Saque: consulta status, saldo/ofertas e cadastro de proposta">
            Novo Saque
          </button>
          <button className="refresh-btn" onClick={() => setShowSomaJornada(true)} title="Soma: consulta de margem, simula&ccedil;&atilde;o e cadastro de proposta">
            Soma
          </button>
          <button className="refresh-btn" onClick={() => setShowFacta(true)} title="Consultar proposta na Facta por CPF ou c&oacute;digo AF">
            Consulta Facta
          </button>
          <button className="dots-btn" onClick={() => setShowRanking(true)} title="Ranking de Vendedoras" style={{ fontSize: 15 }}>
            &#127942;
          </button>
          <button className="refresh-btn" onClick={() => setModo(modo === 'valor' ? 'ponto' : 'valor')} title="Alternar entre valor e pontos">
            {modo === 'valor' ? '⇄ Ver em pontos' : '⇄ Ver em valor'}
          </button>
          <input
            type="file"
            accept=".csv"
            ref={fileInputRef}
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
          <MenuOpcoes
            title="Mais opções"
            itens={[
              { label: '⚙ Configurar meta', onClick: abrirMetaConfig },
              { label: syncing ? 'Sincronizando...' : '↻ Sincronizar', onClick: handleSync, disabled: syncing },
              { label: loading ? 'Atualizando...' : '⟳ Atualizar agora', onClick: load, disabled: loading },
              { label: importing ? 'Importando...' : '↑ Importar CSV', onClick: handleImportClick, disabled: importing },
              { label: '↓ Baixar CSV', onClick: handleDownload },
            ]}
          />
        </div>
      </div>

      {importMsg && <div className="state-msg" style={{ marginBottom: 10 }}>{importMsg}</div>}
      {syncMsg && <div className="state-msg" style={{ marginBottom: 10 }}>{syncMsg}</div>}

      <div className="filters">
        <MultiSelect value={vendedorSel} onChange={setVendedorSel} options={vendedores} label="vendedor" />
        <MultiSelect value={bancoSel} onChange={setBancoSel} options={bancosDisponiveis} label="banco" />
      </div>
      <DateRangeFilter dataInicio={dataInicio} setDataInicio={setDataInicio} dataFim={dataFim} setDataFim={setDataFim} />

      {error && <div className="state-msg error">Erro: {error}</div>}

      <div className="panel chart-panel extra-tall">
        <p className="section-label">Vendas por dia</p>
        {metas && (() => {
          const ehPonto = modo === 'ponto'
          const periodo = metas.periodo_ativo
          const metaAtiva = ehPonto
            ? (periodo === 'diario' ? metas.ponto_diaria : periodo === 'mensal' ? metas.ponto_mensal : metas.ponto_semanal)
            : (periodo === 'diario' ? metas.valor_diaria : periodo === 'mensal' ? metas.valor_mensal : metas.valor_semanal)
          const realizado = ehPonto
            ? (periodo === 'diario' ? metas.realizado_dia_ponto : periodo === 'mensal' ? metas.realizado_mes_ponto : metas.realizado_semana_ponto)
            : (periodo === 'diario' ? metas.realizado_dia_valor : periodo === 'mensal' ? metas.realizado_mes_valor : metas.realizado_semana_valor)
          const pct = metaAtiva > 0 ? Math.min(100, (Number(realizado) / Number(metaAtiva)) * 100) : 0
          const fmt = ehPonto ? (v) => `${fmtInt(Math.round(v ?? 0))} pts` : fmtMoeda
          const periodoLabel = periodo === 'diario' ? 'diária' : periodo === 'mensal' ? 'mensal' : 'semanal'
          return (
            <div style={{ marginBottom: 10, width: '100%' }}>
              <span style={{ fontSize: 10.5, color: 'var(--muted)', fontFamily: 'var(--font-mono)', display: 'block', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                Meta {periodoLabel}{vendedor ? ` · ${vendedor}` : ''}: {fmt(realizado)} / {fmt(metaAtiva)} ({pct.toFixed(0)}%)
              </span>
              <div style={{ width: '100%', background: 'var(--border)', borderRadius: 99, height: 4, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, background: pct >= 100 ? '#a9d97f' : '#d9b877', height: '100%' }} />
              </div>
            </div>
          )
        })()}
        <ResponsiveContainer width="100%" height="70%">
          <BarChart data={porDia.rows}>
            <XAxis dataKey="dia" tick={{ fontSize: 10, fill: '#8a978f' }} tickFormatter={fmtDataBR} />
            <Tooltip
              contentStyle={{ background: '#1b2620', border: '1px solid #263029', borderRadius: 8, fontFamily: 'IBM Plex Mono', fontSize: 12 }}
              labelStyle={{ color: '#8a978f', marginBottom: 4 }}
              labelFormatter={fmtDataBR}
              formatter={(value, name, item) => {
                const vendas = item?.payload?.[`${name}__vendas`]
                const outro = modo === 'ponto' ? item?.payload?.[`${name}__valor`] : item?.payload?.[`${name}__pontos`]
                const outroLabel = modo === 'ponto' ? fmtMoeda(outro) : `${fmtInt(Math.round(outro ?? 0))} pts`
                const valorFmt = modo === 'ponto' ? `${fmtInt(value)} pts` : fmtMoeda(value)
                return [`${valorFmt}${vendas != null ? ` · ${fmtInt(vendas)} vendas` : ''}${outro != null ? ` · ${outroLabel}` : ''}`, name]
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
          <div className="kpi"><p className="kpi-label">Vendedora com maior {modo === 'ponto' ? 'pontua&ccedil;&atilde;o' : 'valor'}</p><p className="kpi-value" style={{ fontSize: 16 }}>{(modo === 'ponto' ? kpisGeral?.top_ponto_vendedor : kpisGeral?.top_valor_vendedor) || '-'}</p><p className="kpi-sub">{fmtV(modo === 'ponto' ? kpisGeral?.top_ponto_valor : kpisGeral?.top_valor_valor)}</p></div>
          <div className="kpi"><p className="kpi-label">Banco mais utilizado</p><p className="kpi-value" style={{ fontSize: 16 }}>{kpisGeral?.banco_top || '-'}</p><p className="kpi-sub">{fmtInt(kpisGeral?.banco_top_qtd)} vendas</p></div>
          <div className="kpi"><p className="kpi-label">Dia com maior {modo === 'ponto' ? 'pontua&ccedil;&atilde;o' : 'valor'}</p><p className="kpi-value" style={{ fontSize: 16 }}>{(modo === 'ponto' ? kpisGeral?.dia_maior_ponto : kpisGeral?.dia_maior_valor) ? fmtDataBR(modo === 'ponto' ? kpisGeral.dia_maior_ponto : kpisGeral.dia_maior_valor) : '-'}</p><p className="kpi-sub">{fmtV(modo === 'ponto' ? kpisGeral?.dia_maior_ponto_total : kpisGeral?.dia_maior_valor_total)}</p></div>
        </div>
      )}
      {!vendedor && mediasGeral && (
        <div className="kpi-grid">
          <div className="kpi">
            <p className="kpi-label">{modo === 'ponto' ? 'Pontos' : 'Valor'} total | Proje&ccedil;&atilde;o do m&ecirc;s</p>
            <p className="kpi-value kpi-split">
              <span>{fmtV(modo === 'ponto' ? kpisGeral?.pontos_total : kpisGeral?.valor_total)}</span>
              <span className="kpi-split-bar">|</span>
              <span className="kpi-split-proj">{fmtV(modo === 'ponto' ? mediasGeral?.pontos_projecao_mes_real : mediasGeral?.projecao_mes_real)}</span>
            </p>
            <p className="kpi-sub">{fmtInt(kpisGeral?.qtd_total)} vendas no per&iacute;odo</p>
            <p className="kpi-sub">considerando hoje: {fmtV(modo === 'ponto' ? mediasGeral?.pontos_projecao_mes : mediasGeral?.projecao_mes)}</p>
          </div>
          <div className="kpi">
            <p className="kpi-label">M&eacute;dia di&aacute;ria (time todo)</p>
            <p className="kpi-value">{fmtV(mediasGeral.dias_uteis_passados > 0 ? (modo === 'ponto' ? mediasGeral.pontos_mes_atual : mediasGeral.total_mes_atual) / mediasGeral.dias_uteis_passados : 0)}</p>
            <p className="kpi-sub">por dia &uacute;til, m&ecirc;s corrente</p>
          </div>
          <div className="kpi">
            <p className="kpi-label">M&eacute;dia semanal (time todo)</p>
            <p className="kpi-value">{fmtV(mediasGeral.dias_uteis_passados > 0 ? ((modo === 'ponto' ? mediasGeral.pontos_mes_atual : mediasGeral.total_mes_atual) / mediasGeral.dias_uteis_passados) * 5 : 0)}</p>
            <p className="kpi-sub">m&eacute;dia di&aacute;ria &times; 5 dias &uacute;teis</p>
          </div>
          <div className="kpi">
            <p className="kpi-label">Proje&ccedil;&atilde;o di&aacute;ria | semanal</p>
            <p className="kpi-value kpi-split">
              <span>{fmtV(modo === 'ponto' ? mediasGeral.pontos_projecao_diaria : mediasGeral.projecao_diaria)}</span>
              <span className="kpi-split-bar">|</span>
              <span className="kpi-split-proj">{fmtV(modo === 'ponto' ? mediasGeral.pontos_projecao_semanal : mediasGeral.projecao_semanal)}</span>
            </p>
            <p className="kpi-sub">ritmo por hora &uacute;til (8h&ndash;18h) de hoje/semana</p>
          </div>
        </div>
      )}
      {vendedor && (
        <div className="kpi-grid">
          <div className="kpi"><p className="kpi-label">Maior {modo === 'ponto' ? 'pontua&ccedil;&atilde;o' : 'venda'}</p><p className="kpi-value">{fmtV(modo === 'ponto' ? kpisVendedor?.maior_pontuacao : kpisVendedor?.maior_venda)}</p></div>
          <div className="kpi"><p className="kpi-label">Dia com mais vendas</p><p className="kpi-value" style={{ fontSize: 16 }}>{kpisVendedor?.dia_mais_vendas ? fmtDataBR(kpisVendedor.dia_mais_vendas) : '-'}</p><p className="kpi-sub">{fmtInt(kpisVendedor?.dia_mais_vendas_qtd)} vendas</p></div>
          <div className="kpi">
            <p className="kpi-label">{modo === 'ponto' ? 'Pontos' : 'Valor'} total | Proje&ccedil;&atilde;o do m&ecirc;s</p>
            <p className="kpi-value kpi-split">
              <span>{fmtV(modo === 'ponto' ? kpisVendedor?.pontos_total : kpisVendedor?.valor_total)}</span>
              <span className="kpi-split-bar">|</span>
              <span className="kpi-split-proj">{fmtV(modo === 'ponto' ? metaVendedor?.pontos_projecao_mes_real : metaVendedor?.projecao_mes_real)}</span>
            </p>
            <p className="kpi-sub">considerando hoje: {fmtV(modo === 'ponto' ? metaVendedor?.pontos_projecao_mes : metaVendedor?.projecao_mes)}</p>
          </div>
          <div className="kpi"><p className="kpi-label">Quantidade total</p><p className="kpi-value">{fmtInt(kpisVendedor?.qtd_total)}</p></div>
        </div>
      )}
      {vendedor && metaVendedor && (
        <div className="kpi-grid kpi-grid-3">
          <div className="kpi">
            <p className="kpi-label">M&eacute;dia di&aacute;ria | semanal</p>
            <p className="kpi-value kpi-split">
              <span>{fmtV(metaVendedor.dias_uteis_passados > 0 ? (modo === 'ponto' ? metaVendedor.pontos_mes_atual : metaVendedor.total_mes_atual) / metaVendedor.dias_uteis_passados : 0)}</span>
              <span className="kpi-split-bar">|</span>
              <span className="kpi-split-proj">{fmtV(metaVendedor.dias_uteis_passados > 0 ? ((modo === 'ponto' ? metaVendedor.pontos_mes_atual : metaVendedor.total_mes_atual) / metaVendedor.dias_uteis_passados) * 5 : 0)}</span>
            </p>
            <p className="kpi-sub">m&eacute;s corrente, {vendedor}</p>
          </div>
          <div className="kpi">
            <p className="kpi-label">Proje&ccedil;&atilde;o di&aacute;ria | semanal</p>
            <p className="kpi-value kpi-split">
              <span>{fmtV(modo === 'ponto' ? metaVendedor.pontos_projecao_diaria : metaVendedor.projecao_diaria)}</span>
              <span className="kpi-split-bar">|</span>
              <span className="kpi-split-proj">{fmtV(modo === 'ponto' ? metaVendedor.pontos_projecao_semanal : metaVendedor.projecao_semanal)}</span>
            </p>
            <p className="kpi-sub">ritmo por hora &uacute;til (8h&ndash;18h)</p>
          </div>
          <div className="kpi">
            <p className="kpi-label">Semana atual</p>
            <p className="kpi-value">{fmtV(modo === 'ponto' ? metaVendedor.pontos_semana_atual : metaVendedor.semana_atual_valor)}</p>
            {modo !== 'ponto' && <p className="kpi-sub">meta: {fmtMoeda(metaVendedor.meta_semana)}</p>}
          </div>
        </div>
      )}

      <div className="panel table-panel">
        <p className="section-label">Vendas ({fmtInt(tabela.total)})</p>
        <div className="template-row head" style={{ gridTemplateColumns: '1.2fr 0.9fr 1fr 1fr 0.8fr 0.6fr' }}>
          <span>Vendedor</span><span>{modo === 'ponto' ? 'Pontos' : 'Valor'}</span><span>CPF</span><span>Banco</span><span>Data</span><span>Conversa</span>
        </div>
        {tabela.rows.length === 0 && !loading && (
          <div className="state-msg">Nenhuma venda encontrada para os filtros selecionados.</div>
        )}
        {tabela.rows.map((r, i) => (
          <div className="template-row" key={i} style={{ gridTemplateColumns: '1.2fr 0.9fr 1fr 1fr 0.8fr 0.6fr' }}>
            <span className="campanha-nome">{r.vendedor}</span>
            <span>{modo === 'ponto' ? fmtInt(Math.round(r.ponto)) : fmtMoeda(r.valor)}</span>
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
      {showFacta && <FactaConsultaOverlay onClose={() => setShowFacta(false)} />}
      {showAdd && (
        <AddVendaModal
          vendedoresDisponiveis={vendedores}
          onClose={() => setShowAdd(false)}
          onAdded={async () => { await callApi('vendedoras_sync', {}); await load() }}
        />
      )}
      {showNovoSaque && <NovoSaqueModal onClose={() => setShowNovoSaque(false)} />}
      {showSomaJornada && <SomaJornadaModal onClose={() => setShowSomaJornada(false)} />}

      {showMetaConfig && metaForm && (
        <div className="funil-overlay" onClick={() => setShowMetaConfig(false)}>
          <div className="funil-panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="funil-header">
              <div><h2>Configurar meta</h2></div>
              <button className="funil-close" onClick={() => setShowMetaConfig(false)}>&times;</button>
            </div>

            <div className="card" style={{ marginBottom: 14 }}>
              <p className="card-label">Qual meta acompanhar</p>
              <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input type="radio" checked={metaForm.tipo_ativo === 'valor'} onChange={() => setMetaForm({ ...metaForm, tipo_ativo: 'valor' })} /> Valor
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input type="radio" checked={metaForm.tipo_ativo === 'ponto'} onChange={() => setMetaForm({ ...metaForm, tipo_ativo: 'ponto' })} /> Pontos
                </label>
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
                {['diario', 'semanal', 'mensal'].map((p) => (
                  <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, textTransform: 'capitalize' }}>
                    <input type="radio" checked={metaForm.periodo_ativo === p} onChange={() => setMetaForm({ ...metaForm, periodo_ativo: p })} /> {p}
                  </label>
                ))}
              </div>
            </div>

            <div className="card">
              <p className="card-label">Metas em valor (R$)</p>
              {['valor_diaria', 'valor_semanal', 'valor_mensal'].map((campo) => (
                <div key={campo} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <label style={{ fontSize: 12.5, color: 'var(--muted)', width: 90, textTransform: 'capitalize' }}>{campo.split('_')[1]}</label>
                  <input
                    type="number"
                    value={metaForm[campo]}
                    onChange={(e) => setMetaForm({ ...metaForm, [campo]: e.target.value })}
                    style={{ flex: 1, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)', padding: '8px 10px', borderRadius: 7, fontFamily: 'var(--font-mono)' }}
                  />
                </div>
              ))}
            </div>

            <div className="card" style={{ marginTop: 10 }}>
              <p className="card-label">Metas em pontos</p>
              {['ponto_diaria', 'ponto_semanal', 'ponto_mensal'].map((campo) => (
                <div key={campo} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <label style={{ fontSize: 12.5, color: 'var(--muted)', width: 90, textTransform: 'capitalize' }}>{campo.split('_')[1]}</label>
                  <input
                    type="number"
                    value={metaForm[campo]}
                    onChange={(e) => setMetaForm({ ...metaForm, [campo]: e.target.value })}
                    style={{ flex: 1, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)', padding: '8px 10px', borderRadius: 7, fontFamily: 'var(--font-mono)' }}
                  />
                </div>
              ))}
            </div>

            <button className="refresh-btn" onClick={salvarMeta} disabled={salvandoMeta} style={{ marginTop: 14, width: '100%' }}>
              {salvandoMeta ? 'Salvando...' : 'Salvar meta'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

const VENDAS_CORES = ['#a9d97f', '#d99089', '#7fa8d9', '#d9b877', '#c17fd9', '#7fd9c1']

function VendasView() {
  const mesAtual = presetRange('este_mes')
  const [dataInicio, setDataInicio] = useState(mesAtual.from)
  const [dataFim, setDataFim] = useState(mesAtual.to)
  const [produtoSel, setProdutoSel] = useState([])
  const [bancoSel, setBancoSel] = useState([])
  const produto = produtoSel.join(',')
  const banco = bancoSel.join(',')

  const [kpis, setKpis] = useState(null)
  const [porProduto, setPorProduto] = useState([])
  const [diasMes, setDiasMes] = useState([])
  const [porCampanha, setPorCampanha] = useState([])
  const [porOrigem, setPorOrigem] = useState([])
  const [filtrosBanco, setFiltrosBanco] = useState([])

  useEffect(() => {
    callApi('vendas_filtros', {})
      .then((d) => setFiltrosBanco(d?.[0]?.bancos || []))
      .catch(() => {})
  }, [])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const [showEngrenagem, setShowEngrenagem] = useState(false)
  const fileInputRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [kp, pp, dm, pc, po] = await Promise.all([
        callApi('vendas_kpis', { date_from: dataInicio, date_to: dataFim, produto, banco }),
        callApi('vendas_por_produto', { date_from: dataInicio, date_to: dataFim }),
        callApi('vendas_dias_mes', { produto, banco }),
        callApi('vendas_por_campanha', { date_from: dataInicio, date_to: dataFim, produto, banco }),
        callApi('vendas_por_origem', { date_from: dataInicio, date_to: dataFim, produto, banco }),
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
  }, [dataInicio, dataFim, produto, banco])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  // gráfico realizado x projeção, dia a dia do mês corrente (igual ao
  // portal da vendedora, só que sem os níveis de marco) — traz tanto valor
  // quanto pontos, pra aparecer os dois no tooltip ao passar o mouse
  const chartData = useMemo(() => {
    if (!diasMes.length) return []
    const hoje = todayISO()
    let acumuladoValor = 0
    let acumuladoPonto = 0
    const diasIniciados = diasMes.filter((d) => d.dia.slice(0, 10) <= hoje)
    const ultimoIniciado = diasIniciados[diasIniciados.length - 1]
    const projecaoValorFinal = kpis ? Number(kpis.projecao_mes) : 0
    const projecaoPontoFinal = kpis ? Number(kpis.pontos_projecao_mes) : 0

    return diasMes.map((d, i) => {
      const valor = Number(d.valor_dia) || 0
      const ponto = Number(d.ponto_dia) || 0
      const iniciado = d.dia.slice(0, 10) <= hoje
      if (iniciado) {
        acumuladoValor += valor
        acumuladoPonto += ponto
      }
      const row = { dia: fmtDataBR(d.dia) }
      row.valorDia = valor
      row.pontoDia = ponto
      if (iniciado) {
        row.realizado = acumuladoValor
        row.pontoRealizado = acumuladoPonto
        const ultimoIdx = diasMes.indexOf(ultimoIniciado)
        if (i === ultimoIdx) {
          row.projecao = acumuladoValor
          row.ehAtual = true
          row.projecaoMesTotal = projecaoValorFinal
          row.pontoMesTotal = projecaoPontoFinal
        }
      } else if (ultimoIniciado) {
        const ultimoIdx = diasMes.indexOf(ultimoIniciado)
        const acumuladoValorUltimo = diasMes.slice(0, ultimoIdx + 1).reduce((s, x) => s + (Number(x.valor_dia) || 0), 0)
        const acumuladoPontoUltimo = diasMes.slice(0, ultimoIdx + 1).reduce((s, x) => s + (Number(x.ponto_dia) || 0), 0)
        const diasRestantes = diasMes.length - 1 - ultimoIdx
        const passoValor = diasRestantes > 0 ? (projecaoValorFinal - acumuladoValorUltimo) / diasRestantes : 0
        const passoPonto = diasRestantes > 0 ? (projecaoPontoFinal - acumuladoPontoUltimo) / diasRestantes : 0
        row.projecao = acumuladoValorUltimo + passoValor * (i - ultimoIdx)
        row.pontoProjecao = acumuladoPontoUltimo + passoPonto * (i - ultimoIdx)
      }
      return row
    })
  }, [diasMes, kpis])

  // cor do gráfico e dos KPIs muda de acordo com o produto selecionado no
  // filtro (mesma cor do card daquele produto); sem filtro, usa o verde padrão
  const corAtual = useMemo(() => {
    if (!produto) return '#a9d97f'
    const idx = porProduto.findIndex((p) => p.produto === produto)
    return idx >= 0 ? VENDAS_CORES[idx % VENDAS_CORES.length] : '#a9d97f'
  }, [produto, porProduto])

  const handleSync = async () => {
    setSyncing(true)
    setSyncMsg('')
    try {
      const r = await callApi('vendas_sync', {})
      const s = r?.[0]
      setSyncMsg(
        s
          ? `Concluído — ${fmtInt(s.atualizados_vendas)} vendas com dados completos, ${fmtInt(s.atualizados_disparochat)} atualizadas em disparochat, ${fmtInt(s.atualizados_total_produtos)} em total_produtos, ${fmtInt(s.atualizados_leads_chatwoot)} em leads_chatwoot.`
          : 'Sincronização concluída.'
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
        setImportMsg('Nenhuma linha válida encontrada no arquivo.')
        return
      }
      const result = await postApi('vendas_import', { rows })
      const r = result?.[0]
      setImportMsg(
        `Importação concluída — ${fmtInt(r?.inseridos)} vendas novas, ${fmtInt(r?.atualizados)} atualizadas (estavam sem peso), ${fmtInt(r?.ignorados)} já estavam completas. Sincronizando...`
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

  // Downloads do que foi coletado das APIs dos bancos (log de consultas e
  // propostas com proposal_id). Ficam atrás da engrenagem pra não poluir a
  // barra principal — são dados de auditoria, não o relatório do dia a dia.
  const handleDownloadBancos = (tipo) => {
    const qs = new URLSearchParams({ type: tipo, date_from: dataInicio, date_to: dataFim })
    if (bancoSel.length) qs.set('banco', bancoSel.join(','))
    window.open(`/api/dashboard?${qs.toString()}`, '_blank')
    setShowEngrenagem(false)
  }

  return (
    <>
      <div className="topbar">
        <h1><span className="pulse" /> Vendas</h1>
        <div className="topbar-right">
          <span className="status-line">
            {loading ? 'atualizando...' : lastUpdate ? `atualizado às ${fmtHora(lastUpdate)}` : ''}
          </span>
          <button className="reset-btn" onClick={() => { setDataInicio(mesAtual.from); setDataFim(mesAtual.to); setProdutoSel([]); setBancoSel([]) }} title="Redefinir filtros">
            &#10226; Redefinir filtros
          </button>
          <input type="file" accept=".csv" ref={fileInputRef} onChange={handleFileChange} style={{ display: 'none' }} />
          <button className="refresh-btn" onClick={handleImportClick} disabled={importing} title="Importar vendas de um arquivo CSV">
            {importing ? 'Importando...' : '↑ Importar'}
          </button>
          <button className="refresh-btn" onClick={handleDownload} title="Baixar tabela filtrada em CSV">
            &#8595; Baixar
          </button>
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <button
              className="refresh-btn"
              onClick={() => setShowEngrenagem((v) => !v)}
              title="Dados coletados das APIs dos bancos"
            >
              &#9881;
            </button>
            {showEngrenagem && (
              <>
                <div
                  onClick={() => setShowEngrenagem(false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 40 }}
                />
                <div
                  style={{
                    position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 41,
                    background: 'var(--panel, #14181c)', border: '1px solid var(--border, #2a3038)',
                    borderRadius: 8, padding: 6, minWidth: 250,
                    boxShadow: '0 8px 24px rgba(0,0,0,.45)',
                  }}
                >
                  <p style={{ margin: '4px 8px 8px', fontSize: 11, color: 'var(--muted, #7d8894)', letterSpacing: '.04em' }}>
                    DADOS DOS BANCOS
                  </p>
                  <button
                    className="refresh-btn"
                    style={{ width: '100%', textAlign: 'left', marginBottom: 4 }}
                    onClick={() => handleDownloadBancos('consultas_bancos_export')}
                    title="Cada consulta feita às APIs dos bancos, com valor informado x valor do banco"
                  >
                    &#8595; Consultas às APIs
                  </button>
                  <button
                    className="refresh-btn"
                    style={{ width: '100%', textAlign: 'left' }}
                    onClick={() => handleDownloadBancos('propostas_bancos_export')}
                    title="Propostas com proposal_id (Novo Saque e outros), com status de pagamento"
                  >
                    &#8595; Propostas / proposal_id
                  </button>
                  <p style={{ margin: '8px 8px 4px', fontSize: 11, color: 'var(--muted, #7d8894)' }}>
                    Respeita o período e o filtro de banco.
                  </p>
                </div>
              </>
            )}
          </div>
          <button className="refresh-btn" onClick={handleSync} disabled={syncing} title="Cruzar CPFs com disparochat/total_produtos/leads_chatwoot e reconciliar pagamentos">
            {syncing ? 'Sincronizando...' : '↻ Sincronizar'}
          </button>
          <button className="refresh-btn" onClick={load} disabled={loading} title="Atualizar agora">
            &#8635; Atualizar
          </button>
        </div>
      </div>

      {importMsg && <div className="state-msg" style={{ marginBottom: 10 }}>{importMsg}</div>}
      {syncMsg && <div className="state-msg" style={{ marginBottom: 10 }}>{syncMsg}</div>}

      <div className="filters">
        <MultiSelect value={produtoSel} onChange={setProdutoSel} options={porProduto.map((p) => p.produto)} label="produto" />
        <MultiSelect value={bancoSel} onChange={setBancoSel} options={filtrosBanco} label="banco" />
      </div>
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
            <Line type="monotone" dataKey="realizado" stroke={corAtual} strokeWidth={2.5} dot={false} connectNulls />
            <Line type="monotone" dataKey="projecao" stroke={corAtual} strokeOpacity={0.4} strokeDasharray="5 5" strokeWidth={2} dot={false} connectNulls legendType="none" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="kpi-grid kpi-grid-4">
        <div className="kpi">
          <p className="kpi-label">Soma de pontos | Qtd total</p>
          <p className="kpi-value kpi-split"><span>{fmtInt(Math.round(kpis?.pontos_total ?? 0))}</span><span className="kpi-split-bar">|</span><span className="kpi-split-proj">{fmtInt(kpis?.qtd_total)}</span></p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Proje&ccedil;&atilde;o do m&ecirc;s (pontos)</p>
          <p className="kpi-value" style={{ color: corAtual }}>{fmtInt(Math.round(kpis?.pontos_projecao_mes_real ?? 0))}</p>
          <p className="kpi-sub">considerando hoje: {fmtInt(Math.round(kpis?.pontos_projecao_mes ?? 0))}</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Soma de valor | Proje&ccedil;&atilde;o valor</p>
          <p className="kpi-value kpi-split"><span>{fmtMoeda(kpis?.valor_total)}</span><span className="kpi-split-bar">|</span><span className="kpi-split-proj">{fmtMoeda(kpis?.projecao_mes_real)}</span></p>
          <p className="kpi-sub">considerando hoje: {fmtMoeda(kpis?.projecao_mes)}</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">% vendas de vendedoras</p>
          <p className="kpi-value" style={{ fontSize: 20 }}>{fmtPct2(kpis?.qtd_total > 0 ? (Number(kpis.qtd_vendedor) / Number(kpis.qtd_total)) * 100 : 0)}</p>
          <p className="kpi-sub">{fmtInt(kpis?.qtd_vendedor)} de {fmtInt(kpis?.qtd_total)} vendas</p>
          <p className="kpi-sub">{fmtInt(Math.round(kpis?.pontos_vendedor ?? 0))} pontos &middot; {fmtMoeda(kpis?.valor_vendedor)}</p>
        </div>
      </div>

      <div className="kpi-grid">
        {porProduto.map((p, i) => (
          <div
            className="kpi"
            key={p.produto}
            onClick={() => setProdutoSel(produtoSel.length === 1 && produtoSel[0] === p.produto ? [] : [p.produto])}
            style={{ cursor: 'pointer', outline: produto === p.produto ? `1px solid ${VENDAS_CORES[i % VENDAS_CORES.length]}` : 'none' }}
            title="Clique para filtrar por esse produto"
          >
            <p className="kpi-label">{p.produto}</p>
            <p className="kpi-value" style={{ color: VENDAS_CORES[i % VENDAS_CORES.length] }}>{fmtInt(Math.round(p.pontos_total))} pts</p>
            <p className="kpi-sub">{fmtInt(p.qtd_total)} vendas &middot; {fmtMoeda(p.valor_total)}</p>
            <p className="kpi-sub">proje&ccedil;&atilde;o: {fmtInt(Math.round(p.pontos_projecao_mes ?? 0))} pts &middot; {fmtMoeda(p.projecao_mes)}</p>
          </div>
        ))}
      </div>

      <div className="kpi-grid kpi-grid-4">
        <div className="kpi">
          <p className="kpi-label">M&eacute;dia di&aacute;ria &mdash; pontos | valor</p>
          <p className="kpi-value kpi-split">
            <span>{fmtInt(Math.round(kpis?.dias_uteis_periodo > 0 ? kpis.pontos_total / kpis.dias_uteis_periodo : 0))}</span>
            <span className="kpi-split-bar">|</span>
            <span className="kpi-split-proj">{fmtMoeda(kpis?.dias_uteis_periodo > 0 ? kpis.valor_total / kpis.dias_uteis_periodo : 0)}</span>
          </p>
        </div>
        <div className="kpi">
          <p className="kpi-label">M&eacute;dia semanal &mdash; pontos | valor</p>
          <p className="kpi-value kpi-split">
            <span>{fmtInt(Math.round(kpis?.dias_uteis_periodo > 0 ? (kpis.pontos_total / kpis.dias_uteis_periodo) * 5 : 0))}</span>
            <span className="kpi-split-bar">|</span>
            <span className="kpi-split-proj">{fmtMoeda(kpis?.dias_uteis_periodo > 0 ? (kpis.valor_total / kpis.dias_uteis_periodo) * 5 : 0)}</span>
          </p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Proje&ccedil;&atilde;o di&aacute;ria &mdash; pontos | valor</p>
          <p className="kpi-value kpi-split">
            <span>{fmtInt(Math.round(kpis?.projecao_diaria_pontos ?? 0))}</span>
            <span className="kpi-split-bar">|</span>
            <span className="kpi-split-proj">{fmtMoeda(kpis?.projecao_diaria_valor)}</span>
          </p>
          <p className="kpi-sub">ritmo por hora &uacute;til (8h-18h) de hoje</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Proje&ccedil;&atilde;o semanal &mdash; pontos | valor</p>
          <p className="kpi-value kpi-split">
            <span>{fmtInt(Math.round(kpis?.projecao_semanal_pontos ?? 0))}</span>
            <span className="kpi-split-bar">|</span>
            <span className="kpi-split-proj">{fmtMoeda(kpis?.projecao_semanal_valor)}</span>
          </p>
          <p className="kpi-sub">ritmo por hora &uacute;til (8h-18h) da semana</p>
        </div>
      </div>

      <div className="panel table-panel">
        <p className="section-label">Por campanha</p>
        <div className="template-row head" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
          <span>Campanha</span><span>Qtd</span><span>Pontos</span><span>Valor</span>
        </div>
        <div className="scroll-table">
          {porCampanha.length === 0 && !loading && <div className="state-msg">Nenhum dado encontrado.</div>}
          {porCampanha.map((r, i) => (
            <div className="template-row" key={i} style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
              <span className="campanha-nome">{r.campanha}</span>
              <span>{fmtInt(r.qtd)}</span>
              <span>{fmtInt(Math.round(r.pontos ?? 0))}</span>
              <span>{fmtMoeda(r.valor)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="panel table-panel">
        <p className="section-label">Por origem</p>
        <div className="template-row head" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
          <span>Origem</span><span>Qtd</span><span>Pontos</span><span>Valor</span>
        </div>
        <div className="scroll-table">
          {porOrigem.length === 0 && !loading && <div className="state-msg">Nenhum dado encontrado.</div>}
          {porOrigem.map((r, i) => (
            <div className="template-row" key={i} style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
              <span className="campanha-nome">{r.origem}</span>
              <span>{fmtInt(r.qtd)}</span>
              <span>{fmtInt(Math.round(r.pontos ?? 0))}</span>
              <span>{fmtMoeda(r.valor)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

// Configuração da janela de funcionamento do leilão. O fluxo n8n
// "leilao - monitor de saude e trava de entrada" lê esses valores da tabela
// leilao_config, então dá pra mudar o horário sem editar o fluxo.
function LeilaoConfigOverlay({ onClose }) {
  const [cfg, setCfg] = useState(null)
  const [loading, setLoading] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [aplicando, setAplicando] = useState('')
  const [msg, setMsg] = useState('')
  const [erro, setErro] = useState('')

  useEffect(() => {
    fetch('/api/dashboard?type=leilao_config')
      .then((r) => r.json())
      .then((r) => { if (r.error) throw new Error(r.error); setCfg(r.data) })
      .catch((e) => setErro(e.message))
      .finally(() => setLoading(false))
  }, [])

  const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }))

  const paraHora = (n) => {
    const v = Number(n ?? 0)
    const h = Math.floor(v)
    const m = Math.round((v - h) * 60)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }
  const paraNumero = (txt) => {
    const [h, m] = String(txt || '0:0').split(':').map(Number)
    return (h || 0) + (m || 0) / 60
  }

  const salvar = async () => {
    setSalvando(true); setMsg(''); setErro('')
    try {
      const res = await fetch('/api/dashboard?type=leilao_config_salvar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      })
      const r = await res.json()
      if (!res.ok || r.error) throw new Error(r.error || 'Erro ao salvar')
      setCfg(r.data)
      const estadoTxt = r.aplicado?.estado === 'ativo' ? 'ativo' : 'pausado'
      if (r.aplicado?.ok) {
        setMsg(
          `Configuração salva. Pela nova janela, o leilão está ${estadoTxt} agora` +
          (r.sync?.ok ? ' e o agendamento foi atualizado.' : '.')
        )
      } else {
        setMsg(`Configuração salva, mas não foi possível aplicar o estado agora${r.aplicado?.motivo ? ` (${r.aplicado.motivo})` : ''}.`)
      }
    } catch (e) {
      setErro(e.message)
    } finally {
      setSalvando(false)
    }
  }

  // liga/desliga na hora, sem esperar o proximo ciclo do agendamento
  const aplicarEstado = async (estado) => {
    setAplicando(estado); setMsg(''); setErro('')
    try {
      const res = await fetch('/api/dashboard?type=leilao_estado', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado }),
      })
      const r = await res.json()
      if (!res.ok || r.error) throw new Error(r.error || 'Erro ao aplicar')
      setMsg(estado === 'ativo'
        ? 'Leilão ativado agora. O agendamento volta a valer no próximo horário configurado.'
        : 'Leilão pausado agora. O agendamento volta a valer no próximo horário configurado.')
    } catch (e) {
      setErro(e.message)
    } finally {
      setAplicando('')
    }
  }

  const DIAS = [
    { n: 1, l: 'Seg' }, { n: 2, l: 'Ter' }, { n: 3, l: 'Qua' },
    { n: 4, l: 'Qui' }, { n: 5, l: 'Sex' }, { n: 6, l: 'Sáb' }, { n: 0, l: 'Dom' },
  ]
  const toggleDia = (n) => {
    const atual = cfg.dias_semana || []
    set('dias_semana', atual.includes(n) ? atual.filter((d) => d !== n) : [...atual, n].sort())
  }

  return (
    <div className="funil-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="funil-sheet" style={{ maxWidth: 620 }}>
        <div className="funil-head">
          <div>
            <div className="funil-title">Leilão — janela de funcionamento</div>
            <div className="funil-sub">
              Fora dessa janela o leilão fica pausado. Usado pelo fluxo de monitoramento no n8n.
            </div>
          </div>
          <button className="reset-btn" onClick={onClose}>Fechar ✕</button>
        </div>

        <div className="funil-body">
          {loading && <div className="state-msg">Carregando…</div>}
          {erro && <div className="state-msg error">Erro: {erro}</div>}

          {cfg && (
            <div className="leilao-form">
              <div className="leilao-agora">
                <div>
                  <strong>Ação imediata</strong>
                  <span>Aplica agora, sem esperar o horário. O agendamento volta a valer no próximo ciclo.</span>
                </div>
                <div className="leilao-agora-btns">
                  <button
                    className="leilao-btn-on"
                    disabled={!!aplicando}
                    onClick={() => aplicarEstado('ativo')}
                  >
                    {aplicando === 'ativo' ? 'Ativando…' : '▶ Ativar agora'}
                  </button>
                  <button
                    className="leilao-btn-off"
                    disabled={!!aplicando}
                    onClick={() => aplicarEstado('pausado')}
                  >
                    {aplicando === 'pausado' ? 'Pausando…' : '⏸ Desativar agora'}
                  </button>
                </div>
              </div>

              <div className="leilao-sep" />

              <div className="leilao-linha">
                <label>Liga às</label>
                <input type="time" value={paraHora(cfg.hora_inicio)} onChange={(e) => set('hora_inicio', paraNumero(e.target.value))} />
                <label>Desliga às</label>
                <input type="time" value={paraHora(cfg.hora_fim)} onChange={(e) => set('hora_fim', paraNumero(e.target.value))} />
              </div>

              <div className="leilao-linha leilao-dias">
                <label>Dias ativos</label>
                <div className="leilao-chips">
                  {DIAS.map((d) => (
                    <button
                      key={d.n}
                      className={`leilao-chip ${(cfg.dias_semana || []).includes(d.n) ? 'on' : ''}`}
                      onClick={() => toggleDia(d.n)}
                    >{d.l}</button>
                  ))}
                </div>
              </div>

              <label className="leilao-check">
                <input type="checkbox" checked={!!cfg.fim_semana_pausado} onChange={(e) => set('fim_semana_pausado', e.target.checked)} />
                <span>Manter pausado no fim de semana</span>
              </label>

              <div className="leilao-sep" />

              <label className="leilao-check">
                <input type="checkbox" checked={!!cfg.bloqueio_ativo} onChange={(e) => set('bloqueio_ativo', e.target.checked)} />
                <span>Bloqueio mensal (virada de folha)</span>
              </label>

              {cfg.bloqueio_ativo && (
                <div className="leilao-linha">
                  <label>Do dia</label>
                  <input type="number" min="1" max="31" value={cfg.bloqueio_dia_inicio} onChange={(e) => set('bloqueio_dia_inicio', e.target.value)} />
                  <input type="time" value={paraHora(cfg.bloqueio_hora_inicio)} onChange={(e) => set('bloqueio_hora_inicio', paraNumero(e.target.value))} />
                  <label>até o dia</label>
                  <input type="number" min="1" max="31" value={cfg.bloqueio_dia_fim} onChange={(e) => set('bloqueio_dia_fim', e.target.value)} />
                  <input type="time" value={paraHora(cfg.bloqueio_hora_fim)} onChange={(e) => set('bloqueio_hora_fim', paraNumero(e.target.value))} />
                </div>
              )}

              {msg && <div className="state-msg" style={{ color: 'var(--lime)' }}>{msg}</div>}

              <div className="leilao-acoes">
                <span className="leilao-hint">
                  {cfg.atualizado_em ? `última alteração: ${new Date(cfg.atualizado_em).toLocaleString('pt-BR')}` : ''}
                </span>
                <button className="refresh-btn" onClick={salvar} disabled={salvando}>
                  {salvando ? 'Salvando…' : 'Salvar configuração'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function VisaoGeral() {
  const [filtros, setFiltros] = useState({ campanhas: [], origens: [], metas: [], tiposEnvio: [], mensagens: [] })
  const [campanhaSel, setCampanhaSel] = useState([])
  const campanha = campanhaSel.join(',')
  const [origemSel, setOrigemSel] = useState([])
  const [metaSel, setMetaSel] = useState([])
  const [tipoEnvioSel, setTipoEnvioSel] = useState([])
  const [mensagemFiltroSel, setMensagemFiltroSel] = useState([])
  const origem = origemSel.join(',')
  const meta = metaSel.join(',')
  const tipoEnvio = tipoEnvioSel.join(',')
  const mensagemFiltro = mensagemFiltroSel.join(',')
  const [dataInicio, setDataInicio] = useState('')
  const [dataFim, setDataFim] = useState('')
  const [horaInicio, setHoraInicio] = useState('')
  const [horaFim, setHoraFim] = useState('')
  const [showFunil, setShowFunil] = useState(false)
  const [showLeilao, setShowLeilao] = useState(false)

  const [kpis, setKpis] = useState(null)
  const [envios, setEnvios] = useState([])
  const [campanhas, setCampanhas] = useState([])
  const [porConversa, setPorConversa] = useState([])
  const [porMeta, setPorMeta] = useState([])
  const [porMensagem, setPorMensagem] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)

  // altura dos tres blocos: usa o que tem MENOS itens, assim nenhum fica
  // com espaco vazio sobrando (os maiores rolam). Limitado a 5-12 linhas.
  const breakdownRows = useMemo(() => {
    const counts = [porConversa.length, porMeta.length, porMensagem.length].filter((n) => n > 0)
    if (!counts.length) return 8
    return Math.max(5, Math.min(Math.min(...counts), 12))
  }, [porConversa, porMeta, porMensagem])

  const apiArgsBase = useMemo(() => ({
    campanha: campanha || '',
    origem: origem || '',
    meta: meta || '',
    tipo_envio: tipoEnvio || '',
    mensagem: mensagemFiltro || '',
    date_from: dataInicio ? new Date(dataInicio + 'T00:00:00').toISOString() : '',
    date_to: dataFim ? new Date(dataFim + 'T23:59:59').toISOString() : '',
    hora_inicio: horaInicio,
    hora_fim: horaFim,
  }), [campanha, origem, meta, tipoEnvio, mensagemFiltro, dataInicio, dataFim, horaInicio, horaFim])

  const loadFiltros = useCallback(async () => {
    try {
      const data = await callApi('filtros', {})
      if (data && data[0]) {
        setFiltros({
          campanhas: data[0].campanhas || [],
          origens: data[0].origens || [],
          metas: data[0].metas || [],
          tiposEnvio: data[0].tipos_envio || [],
          mensagens: data[0].mensagens || [],
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
          campanha: apiArgsBase.campanha,
          origem: apiArgsBase.origem,
          meta: apiArgsBase.meta,
          tipo_envio: apiArgsBase.tipo_envio,
          mensagem: apiArgsBase.mensagem,
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

  const handleDownload = () => {
    const qs = new URLSearchParams(apiArgsBase)
    qs.set('type', 'disparos_export')
    window.open(`/api/dashboard?${qs.toString()}`, '_blank')
  }

  return (
    <>
      <div className="topbar">
        <h1><span className="pulse" /> Disparos &mdash; Dashboard</h1>
        <div className="topbar-right">
          <span className="status-line">
            {loading ? 'atualizando...' : lastUpdate ? `atualizado às ${fmtHora(lastUpdate)}` : ''}
          </span>
          <button className="reset-btn" onClick={() => { setCampanhaSel([]); setOrigemSel([]); setMetaSel([]); setTipoEnvioSel([]); setMensagemFiltroSel([]); setDataInicio(''); setDataFim(''); setHoraInicio(''); setHoraFim('') }} title="Redefinir filtros">
            &#10226; Redefinir filtros
          </button>
          <button className="refresh-btn" onClick={handleDownload} title="Baixar relat&oacute;rio filtrado em CSV">
            &#8595; Baixar
          </button>
          <button className="refresh-btn" onClick={loadDados} disabled={loading} title="Atualizar agora">
            &#8635; Atualizar
          </button>
          <button className="dots-btn" onClick={() => setShowLeilao(true)} title="Configurar janela do leilão">
            &#9881;
          </button>
          <button className="dots-btn" onClick={() => setShowFunil(true)} title="Funil de Disparos">
            &#8942;
          </button>
        </div>
      </div>

      <div className="filters">
        <CampanhaSearch value={campanhaSel} onChange={setCampanhaSel} options={filtros.campanhas} />
        <MultiSelect value={origemSel} onChange={setOrigemSel} options={filtros.origens} label="origem" />
        <MultiSelect value={metaSel} onChange={setMetaSel} options={filtros.metas} label="meta" />
        <MultiSelect value={tipoEnvioSel} onChange={setTipoEnvioSel} options={filtros.tiposEnvio} label="tipo de envio" />
        <MultiSelect value={mensagemFiltroSel} onChange={setMensagemFiltroSel} options={filtros.mensagens} label="mensagem" />
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

      <CampanhaDetalhadoList items={campanhas} loading={loading} />

      <div className="breakdown-grid">
        <BreakdownList title="Por Conversa" items={porConversa} loading={loading} rows={breakdownRows} />
        <BreakdownList title="Meta Retorno" items={porMeta} loading={loading} showInteracoes showConversao rows={breakdownRows} />
        <BreakdownList title="Por Mensagem" items={porMensagem} loading={loading} showInteracoes showConversao rows={breakdownRows} />
      </div>

      {showFunil && <FunilDisparos onClose={() => setShowFunil(false)} />}
      {showLeilao && <LeilaoConfigOverlay onClose={() => setShowLeilao(false)} />}
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
        {view === 'vendedoras' && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <RefinButton vendedor={null} modo="gestao" />
            <ArquivosButton dono={null} />
            <PlaybookMenuButton />
            <AIChatButton vendedor={undefined} />
          </div>
        )}
      </div>
      {view === 'geral' && <VisaoGeral />}
      {view === 'leilao' && <LeilaoDetalhado />}
      {view === 'produtos' && <EntradasLP />}
      {view === 'n8n' && <N8nExecucoes />}
      {view === 'vendedoras' && <VendedorasView />}
      {view === 'vendas' && <VendasView />}
      {view === 'ia' && <IATreinamento />}
    </div>
  )
}

function SingleViewPortal({ children, onLogout }) {
  return (
    <div className="app">
      <div className="app-header">
        <img src="/tiger-icon.png" alt="" className="app-logo" />
        <button className="reset-btn" onClick={onLogout} title="Sair" style={{ marginLeft: 'auto' }}>Sair</button>
      </div>
      {children}
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

  // Primeiro acesso vindo da Trilha do Especialista: a URL chega com
  // ?onboarding=1&senha=... -- faz login automático e limpa a senha da URL.
  // Precisa SEMPRE processar isso, mesmo se já existir uma sessão salva
  // (senão uma sessão antiga no navegador "vence" e o vendedor cai no
  // dashboard errado).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const senhaAuto = params.get('senha')
    if (!senhaAuto) return
    ;(async () => {
      try {
        const data = await postApi('auth_login', { senha: senhaAuto })
        try { localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(data)) } catch { /* ignora */ }
        setAuth(data)
      } catch (e) {
        // senha inválida: usuário cai na tela de login normal
      } finally {
        const url = new URL(window.location.href)
        url.searchParams.delete('senha')
        window.history.replaceState({}, '', url.toString())
      }
    })()
  }, [])

  const logout = () => {
    try { localStorage.removeItem(AUTH_STORAGE_KEY) } catch { /* ignora */ }
    setAuth(null)
  }

  if (!auth) return <LoginGate onLogin={setAuth} />
  if (auth.role === 'vendedora') return <VendedoraPortal vendedor={auth.vendedor} onLogout={logout} />
  if (auth.role === 'entradas_lp') return <SingleViewPortal onLogout={logout}><EntradasLP /></SingleViewPortal>
  return <Dashboard />
}
