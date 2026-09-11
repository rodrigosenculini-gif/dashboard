import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { BarChart, Bar, AreaChart, Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend, LabelList } from 'recharts'
import IATreinamento from './IATreinamento'
import ArquivosButton from './ArquivosNuvem'
import RefinButton from './RefinLeads'
import PresencaEsteiraModal from './PresencaEsteira'
import VisaoInicial from './VisaoInicial'
import Chips from './Chips'
import Trello from './Trello'
import MetaColetiva from './MetaColetiva'
import { callApi as callApiCache, useRevisaoCache, TTL_MS } from './dadosCache'
import * as XLSX from 'xlsx'

// Lê CSV (; ou ,) ou XLSX e devolve as linhas CRUAS, com os nomes de coluna
// exatamente como vieram no arquivo. Quem interpreta é a RPC no banco
// (dashboard_vendas_import_v3), que reconhece o formato do VendeAI e o do
// relatório do portal v8 pelos nomes das colunas.
async function parseArquivoCru(file) {
  const buf = await file.arrayBuffer()
  const nome = (file.name || '').toLowerCase()
  if (nome.endsWith('.xlsx') || nome.endsWith('.xls')) {
    const wb = XLSX.read(buf, { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    return XLSX.utils.sheet_to_json(ws, { defval: null, raw: false })
  }
  // CSV: o relatório do portal v8 vem em latin-1 com ';'
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf) }
  catch { text = new TextDecoder('iso-8859-1').decode(buf) }
  const lines = text.split(/\r\n|\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []
  const delim = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ','

  // Divide respeitando aspas: o relatorio do portal v8 vem com TODOS os valores
  // entre aspas duplas, e um campo pode conter o proprio delimitador.
  const splitLinha = (linha) => {
    const out = []
    let campo = ''
    let dentroDeAspas = false
    for (let i = 0; i < linha.length; i++) {
      const c = linha[i]
      if (c === '"') {
        if (dentroDeAspas && linha[i + 1] === '"') { campo += '"'; i++ }  // aspas escapada
        else dentroDeAspas = !dentroDeAspas
      } else if (c === delim && !dentroDeAspas) {
        out.push(campo); campo = ''
      } else {
        campo += c
      }
    }
    out.push(campo)
    return out.map((x) => x.trim())
  }

  const header = splitLinha(lines[0])
  return lines.slice(1).map((l) => {
    const cols = splitLinha(l)
    const o = {}
    header.forEach((h, i) => { o[h] = cols[i] ?? '' })
    return o
  })
}

const REFRESH_MS = TTL_MS // atualiza sozinho a cada 3 min
// altura de uma linha do breakdown (padding 7+7, conteúdo ~18, borda 1)
const BREAKDOWN_ROW_H = 33
const VISIBLE_DEFAULT = 6

// 'inicio' é a tela Geral (home). A antiga 'geral' era o dashboard de
// Disparos e virou 'disparos' — VIEWS_NAV é o que aparece no menu de views.
const VIEWS = [
  { id: 'inicio', label: 'Geral' },
  { id: 'disparos', label: 'Disparos' },
  { id: 'leilao', label: 'Meta — Detalhado' },
  { id: 'produtos', label: 'Entradas LP' },
  { id: 'n8n', label: 'n8n — Execuções' },
  { id: 'vendedoras', label: 'Vendedoras' },
  { id: 'vendas', label: 'Vendas' },
  { id: 'ia', label: 'IA — Treinamento' },
]

// Passa pelo cache: devolve na hora o que ja foi carregado, congela
// periodo fechado e so revalida quando o Supabase mudou. `opts.forcar`
// (botao Atualizar) ignora tudo isso e vai direto na rede.
async function callApi(type, params, opts) {
  return callApiCache(type, params || {}, opts || {})
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
  const revisaoCache = useRevisaoCache()
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

  const load = useCallback(async (opts) => {
    setLoading(true)
    setError(null)
    const date_from = dataInicio ? new Date(dataInicio + 'T00:00:00').toISOString() : ''
    const date_to = dataFim ? new Date(dataFim + 'T23:59:59').toISOString() : ''
    try {
      const [kpiData, falhaData, templateData] = await Promise.all([
        callApi('hoje_kpis', { date_from, date_to, campanha, hora_inicio: horaInicio, hora_fim: horaFim }, opts),
        callApi('falha_por_minuto', { minutos: '60', campanha }, opts),
        callApi('por_template_hoje', { date_from, date_to, campanha }, opts),
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
  }, [dataInicio, dataFim, campanha, horaInicio, horaFim, revisaoCache])

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
          <button className="refresh-btn" onClick={() => load({ forcar: true })} disabled={loading} title="Atualizar agora">
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
  const revisaoCache = useRevisaoCache()
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
  const mesAtual = presetRange('este_mes')
  const [dataInicio, setDataInicio] = useState(mesAtual.from)
  const [dataFim, setDataFim] = useState(mesAtual.to)
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

  const load = useCallback(async (opts) => {
    setLoading(true)
    setError(null)
    try {
      const [kpiData, entradasData, aprovadasData, campanhasData] = await Promise.all([
        callApi('produtos_kpis', args),
        callApi('produtos_entradas_por_dia', args),
        callApi('produtos_aprovadas_por_dia', args),
        callApi('produtos_campanhas', { campanha: args.campanha, produto: args.produto, origem: args.origem, date_from: args.date_from, date_to: args.date_to }, opts),
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
  }, [args, revisaoCache])

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
          <button className="reset-btn" onClick={() => { setCampanhaSel([]); setProdutoSel([]); setOrigemSel([]); setDataInicio(mesAtual.from); setDataFim(mesAtual.to); setHoraInicio(''); setHoraFim('') }} title="Redefinir filtros">
            &#10226; Redefinir filtros
          </button>
          <button className="refresh-btn" onClick={handleDownload} title="Baixar relat&oacute;rio filtrado em CSV">
            &#8595; Baixar
          </button>
          <button className="refresh-btn" onClick={() => load({ forcar: true })} disabled={loading} title="Atualizar agora">
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
          <button className="refresh-btn" onClick={() => load({ forcar: true })} disabled={loading} title="Atualizar agora">
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

// C6 Consignado Privado — as tabelas validas vem de c6_planos_da_tabela()
// filtradas pelo prazo (endpoint c6_tabelas_opcoes). Nao existe mais lista
// estatica: o nome da tabela do C6 e um agrupamento por prazo, e uma lista
// sem filtro deixava gravar nome e prazo incompativeis (peso null = 0 ponto).

// Todos os outros bancos suportados hoje calculam o peso por parcela + seguro
const BANCOS_VENDA = ['FACTA', 'CREFAZ', 'PAN', 'MERCANTIL', 'PRESENÇA', 'SOMA', 'V8', 'FGTSV8', 'NOVO SAQUE', 'C6']

// Bancos com API instalada pra consulta de adesão (webhook n8n
// consulta-adesao-banco): pra esses, o formulário não pede tabela/parcelas
// — só a adesão, que é buscada e preenchida direto da API do banco.
const BANCOS_COM_API = ['FACTA', 'SOMA', 'PRESENÇA', 'C6', 'PAN']

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

class ErroNaTela extends React.Component {
  constructor(props) { super(props); this.state = { erro: null } }
  static getDerivedStateFromError(erro) { return { erro } }
  componentDidCatch(erro, info) { console.error('Erro no modal:', erro, info) }
  render() {
    if (this.state.erro) {
      return (
        <div className="funil-overlay" onClick={this.props.onClose}>
          <div className="funil-panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <div className="funil-header">
              <div><h2>Algo quebrou nesta tela</h2></div>
              <button className="funil-close" onClick={this.props.onClose}>&times;</button>
            </div>
            <div className="add-venda-form">
              <p className="kpi-sub" style={{ color: '#e5484d' }}>{String(this.state.erro?.message || this.state.erro)}</p>
              <p className="kpi-sub">Feche e tente de novo. Se repetir, me mande esta mensagem.</p>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function SomaJornadaModal({ vendedorFixo, onClose }) {
  const [form, setForm] = useState({ cpf: '', nome: '', celular: '', dataNascimento: '' })
  const [jornada, setJornada] = useState(null)
  const [msg, setMsg] = useState('')
  const [carregando, setCarregando] = useState(false)
  const [copiado, setCopiado] = useState(false)
  // VALOR_PARCELA + margemDisponivel: a margem que a Soma devolve é de PARCELA,
  // não de valor liberado. Simular pela parcela é o que acha o máximo do cliente.
  const [simForm, setSimForm] = useState({ bancarizadora: '', tipoCalculo: 'VALOR_PARCELA', valor: '', parcelas: '', comSeguro: true })
  const [buscandoCpf, setBuscandoCpf] = useState(false)
  const [simulouAuto, setSimulouAuto] = useState(false)
  // A Soma so devolve a margem no momento em que a jornada fica elegivel; nas
  // consultas seguintes ela volta vazia. Guardamos aqui pra nao sumir da tela.
  const [margemSalva, setMargemSalva] = useState(null)
  const [simEscolhida, setSimEscolhida] = useState(null)
  const [contaId, setContaId] = useState(null)
  const [propostaFeita, setPropostaFeita] = useState(null)
  // 26 campos que a Soma exige pra cadastrar o cliente antes de gerar a proposta.
  const [cad, setCad] = useState({
    cliNomeMae: '', cliProfissao: '', cliNacionalidade: 'BRASILEIRA', cliSexo: '',
    cliEstadoCivil: '', cliPoliticamenteExposta: false, cliEmail: '',
    endCep: '', endRua: '', endNumero: '', endBairro: '', endComplemento: '',
    endCidadeId: '', endEstadoId: '',
    conTipoConta: '', conBancoId: '', conAgencia: '', conDigitoAgencia: '',
    conConta: '', conDigitoConta: '', conTipoPix: '', conChavePix: '',
  })
  // Refs em vez de state: nao se perdem em re-render e nao entram como
  // dependencia de efeito (era o que fazia simular em loop).
  const jaSimulouRef = useRef(null)     // guarda o jornadaId ja simulado
  const carregandoRef = useRef(false)
  const tentativasRef = useRef(0)

  const chamar = async (payload) => {
    carregandoRef.current = true
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
      carregandoRef.current = false
      setCarregando(false)
    }
  }

  // Ao sair do campo CPF, tenta preencher nome/celular/nascimento pelas nossas
  // bases (disparochat, leads_chatwoot, vendedoras_analise).
  const buscarPorCpf = async () => {
    const cpf = String(form.cpf || '').replace(/\D/g, '')
    if (cpf.length !== 11) return
    setBuscandoCpf(true)
    try {
      const d = await postApi('busca_cliente_cpf', { cpf })
      if (d?.encontrado) {
        // A Soma espera o celular sem DDI: 12982988998, nao 5512982988998.
        const soDigitos = String(d.celular || '').replace(/\D/g, '')
        const celularLimpo = soDigitos.length > 11 && soDigitos.startsWith('55')
          ? soDigitos.slice(2)
          : soDigitos
        const preenchido = {
          cpf,
          nome: d.nome || '',
          celular: celularLimpo,
          dataNascimento: d.nascimento ? String(d.nascimento).slice(0, 10) : '',
        }
        setForm(preenchido)
        // Achou tudo que a Soma exige: ja dispara a consulta, sem segundo clique.
        if (preenchido.nome && preenchido.celular) {
          setMsg('Dados de ' + (d.origem || 'nossas bases') + '. Consultando...')
          const j = await chamar({ acao: 'iniciar', ...preenchido })
          if (j) { setJornada(j); setCopiado(false) }
          return
        }
        setMsg('Dados de ' + (d.origem || 'nossas bases') + ' — complete o que faltou.')
      } else {
        setMsg('CPF não encontrado nas nossas bases — preencha à mão.')
      }
    } catch (e) {
      // silencioso: é uma conveniência, não pode travar a consulta
    } finally {
      setBuscandoCpf(false)
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
    if (!d) return
    // merge que preserva o que a Soma deixa de mandar nas consultas seguintes
    setJornada((j) => {
      const merged = { ...j, ...d }
      if (d.margemDisponivel == null && j?.margemDisponivel != null) merged.margemDisponivel = j.margemDisponivel
      if ((!d.simulacoes || !d.simulacoes.length) && j?.simulacoes?.length) merged.simulacoes = j.simulacoes
      if (!d.bancaElegivel && j?.bancaElegivel) merged.bancaElegivel = j.bancaElegivel
      return merged
    })
  }

  const simular = async () => {
    const id = jornada?.jornadaId || jornada?.jorId
    if (!id) return
    if (!simForm.bancarizadora && !bancas[0]) { setMsg('Escolha a bancarizadora.'); return }
    if (!simForm.valor) { setMsg('Informe o valor.'); return }
    const d = await chamar({
      acao: 'simular',
      jornadaId: id,
      bancarizadora: simForm.bancarizadora || bancas[0],
      tipoCalculo: simForm.tipoCalculo,
      valor: Number(String(simForm.valor).replace(',', '.')),
      parcelas: simForm.parcelas ? Number(simForm.parcelas) : undefined,
      comSeguro: simForm.comSeguro,
    })
    // A simulação nova aparece na jornada; recarrega pra listar todas.
    if (d) await atualizar()
  }

  const cadastrarECriarProposta = async () => {
    if (!simEscolhida) { setMsg('Escolha a simulação.'); return }
    const faltando = ['cliNomeMae','cliProfissao','cliSexo','cliEstadoCivil','cliEmail',
      'endCep','endRua','endNumero','endBairro','endCidadeId','endEstadoId',
      'conTipoConta','conBancoId','conAgencia','conDigitoAgencia','conConta','conDigitoConta',
      'conTipoPix','conChavePix'].filter((c) => !String(cad[c] || '').trim())
    if (faltando.length) { setMsg('Faltam ' + faltando.length + ' campos obrigatórios.'); return }

    const c = await chamar({
      acao: 'cadastrar_cliente',
      cliente: {
        cliCpf: form.cpf, cliNome: form.nome, cliNascimento: form.dataNascimento,
        cliNomeMae: cad.cliNomeMae, cliProfissao: cad.cliProfissao,
        cliNacionalidade: cad.cliNacionalidade, cliSexo: cad.cliSexo,
        cliEstadoCivil: cad.cliEstadoCivil,
        cliPoliticamenteExposta: !!cad.cliPoliticamenteExposta,
        cliEmail: cad.cliEmail, cliCelular: form.celular,
      },
      endereco: {
        endCep: cad.endCep, endRua: cad.endRua, endNumero: cad.endNumero,
        endBairro: cad.endBairro, endComplemento: cad.endComplemento || '',
        endCidadeId: cad.endCidadeId, endEstadoId: cad.endEstadoId,
      },
      contaBancaria: {
        conTipoConta: cad.conTipoConta, conBancoId: cad.conBancoId,
        conConta: cad.conConta, conDigitoConta: cad.conDigitoConta,
        conAgencia: cad.conAgencia, conDigitoAgencia: cad.conDigitoAgencia,
        conTipoPix: cad.conTipoPix, conChavePix: cad.conChavePix,
      },
    })
    if (!c) return
    const idConta = c.contaBancariaId || c.conId || c.contaBancaria?.conId
      || c.dados?.contaBancariaId || c.dados?.conId || null
    if (!idConta) { setMsg('Cliente cadastrado, mas a Soma não devolveu a conta bancária: ' + JSON.stringify(c).slice(0, 200)); return }
    setContaId(idConta)

    const pr = await chamar({
      acao: 'gerar_proposta',
      jornadaId,
      simulacaoId: simEscolhida,
      contaBancariaId: idConta,
    })
    if (pr) { setPropostaFeita(pr); setMsg('Proposta gerada.'); await atualizar() }
  }

  const link = jornada?.linkAceite || jornada?.jorLinkAceite || null
  const statusId = jornada?.jorStatusId ?? jornada?.statusId ?? null
  const jornadaId = jornada?.jornadaId || jornada?.jorId || null
  // Guarda a margem assim que ela aparece (a Soma nao repete nas consultas seguintes)
  useEffect(() => {
    const m = jornada?.margemDisponivel
    if (m != null && m !== '') setMargemSalva(m)
  }, [jornada?.margemDisponivel])

  const margem = jornada?.margemDisponivel ?? margemSalva
  // Blindagem: se a API devolver esses campos como objeto/string em vez de array,
  // um .map direto quebra a tela inteira (foi o que deixou a tela preta).
  const acoes = Array.isArray(jornada?.acoes) ? jornada.acoes : []
  const bancas = [].concat(jornada?.bancaElegivel || []).filter(Boolean)
  const simulacoes = Array.isArray(jornada?.simulacoes) ? jornada.simulacoes : []
  const podeSimular = acoes.includes('SIMULAR')
  const podeGerarProposta = acoes.includes('GERAR_PROPOSTA')

  // Enquanto a jornada nao chega num estado final, consulta sozinha a cada 5s.
  // Assim a vendedora ve o cliente assinar sem ficar clicando em "Atualizar".
  useEffect(() => {
    if (!jornadaId) return
    const finais = [3, 4, 5, 8, 9]   // gerou proposta, paga, nao elegivel, expirada, cancelada
    if (finais.includes(Number(statusId))) return
    tentativasRef.current = 0
    const t = setInterval(() => {
      // para depois de 10 min pra nao ficar batendo pra sempre
      if (tentativasRef.current >= 120) { clearInterval(t); return }
      tentativasRef.current += 1
      if (!carregandoRef.current) atualizar()
    }, 5000)
    return () => clearInterval(t)
  }, [jornadaId, statusId])

  // Assim que a jornada fica elegivel, simula sozinho pela margem de parcela
  // (e pela banca que a Soma marcou como elegivel). A vendedora nao digita nada;
  // se quiser outro valor, ajusta e clica em Simular de novo.
  useEffect(() => {
    if (!jornadaId || !podeSimular) return
    if (jaSimulouRef.current === jornadaId) return   // ja simulou ESTA jornada
    if (simulacoes.length > 0) { jaSimulouRef.current = jornadaId; return }
    const banca = bancas[0]
    if (!margem || !banca) return
    jaSimulouRef.current = jornadaId                  // trava antes de disparar
    setSimForm((f) => ({ ...f, bancarizadora: banca, tipoCalculo: 'VALOR_PARCELA', valor: String(margem) }))
    ;(async () => {
      try {
        const d = await chamar({
          acao: 'simular', jornadaId, bancarizadora: banca,
          tipoCalculo: 'VALOR_PARCELA', valor: Number(margem), comSeguro: true,
        })
        if (d) await atualizar()
      } catch (e) {
        setMsg('Não consegui simular automaticamente: ' + (e?.message || 'erro'))
      }
    })()
  }, [jornadaId, podeSimular, simulacoes.length, margem])

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
              <label>CPF <span style={{ color: 'var(--muted)', fontWeight: 400 }}>{buscandoCpf ? '(buscando...)' : '(preenche o resto sozinho)'}</span>
                <input value={form.cpf}
                  onChange={(e) => setForm({ ...form, cpf: e.target.value })}
                  onBlur={buscarPorCpf}
                  placeholder="somente n&uacute;meros" />
              </label>
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

              {(Number(statusId) === 5 || Number(statusId) === 8 || Number(statusId) === 9) && (
                <div style={{ border: '2px solid #e5484d', background: 'rgba(229,72,77,0.12)', borderRadius: 8, padding: 10, margin: '6px 0' }}>
                  <p style={{ margin: 0, fontWeight: 700, color: '#e5484d' }}>
                    {Number(statusId) === 5 ? 'Recusado' : Number(statusId) === 8 ? 'Expirou' : 'Cancelado'}
                  </p>
                  <p className="kpi-sub" style={{ margin: '4px 0 0' }}>
                    {SOMA_JORNADA_STATUS[statusId] || ''}
                  </p>
                  {(Array.isArray(jornada?.etapas) ? jornada.etapas : []).map((et, i) => (
                    <p key={i} className="kpi-sub" style={{ margin: '2px 0' }}>
                      <strong>{et?.banca}</strong>: {et?.status}
                      {et?.mensagem ? ' — ' + et.mensagem : ''}
                      {Array.isArray(et?.motivosMapeados) && et.motivosMapeados.length
                        ? ' — ' + et.motivosMapeados.join('; ') : ''}
                    </p>
                  ))}
                </div>
              )}

              {margem != null && (
                <p className="kpi-sub" style={{ margin: '2px 0' }}>
                  Margem dispon&iacute;vel: <strong>{fmtMoeda(margem)}</strong>
                  {jornada?.margemValidaAte ? <> &middot; v&aacute;lida at&eacute; {String(jornada.margemValidaAte).slice(0, 10)}</> : null}
                </p>
              )}

              {/* A API diz em "acoes" o que dá pra fazer agora; a tela segue isso
                  em vez de adivinhar pelo status. Antes do aceite do cliente,
                  SIMULAR não vem e o bloco nem aparece. */}
              {podeSimular && (
                <div style={{ border: '1px solid var(--border, #333)', borderRadius: 8, padding: 10, margin: '6px 0' }}>
                  <p className="kpi-sub" style={{ margin: '0 0 6px' }}>
                    <strong>Simular</strong> &mdash; j&aacute; simulado automaticamente pela margem; ajuste s&oacute; se precisar de outro valor
                  </p>
                  <label>Bancarizadora
                    <select value={simForm.bancarizadora || bancas[0] || ''} onChange={(e) => setSimForm({ ...simForm, bancarizadora: e.target.value })}>
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
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button type="button" className="refresh-btn" onClick={simular} disabled={carregando}>
                      {carregando ? 'Simulando...' : 'Simular com estes valores'}
                    </button>
                    <button type="button" className="refresh-btn" disabled={carregando || !margem}
                      title="Volta pro maximo da margem e simula de novo"
                      onClick={() => {
                        const banca = simForm.bancarizadora || bancas[0]
                        setSimForm({ bancarizadora: banca, tipoCalculo: 'VALOR_PARCELA', valor: String(margem), parcelas: '', comSeguro: true })
                        jaSimulouRef.current = null   // libera a simulacao automatica de novo
                      }}>
                      Refazer pelo m&aacute;ximo
                    </button>
                  </div>
                </div>
              )}

              {simulacoes.length > 0 && (
                <div style={{ margin: '6px 0' }}>
                  <p className="kpi-sub" style={{ margin: '0 0 4px' }}><strong>Simula&ccedil;&otilde;es</strong></p>
                  {simulacoes.map((sm, i) => (
                    <div key={sm?.simId || i} style={{ border: '1px solid var(--border, #333)', borderRadius: 8, padding: 8, marginBottom: 6 }}>
                      <div style={{ fontSize: 13 }}>
                        <strong>{sm.simBancarizadora}</strong> &middot; l&iacute;quido {fmtMoeda(sm.simValorLiquido)}
                        {sm.simPrazo ? <> &middot; {sm.simPrazo}x</> : null}
                        {sm.simValorParcela ? <> de {fmtMoeda(sm.simValorParcela)}</> : null}
                      </div>
                      {sm.simRegraComissaoNome && (
                        <div className="kpi-sub">{sm.simRegraComissaoNome}</div>
                      )}
                      <div className="kpi-sub">
                        {sm.simTaxaMensal != null ? <>Taxa {sm.simTaxaMensal}% a.m.</> : null}
                        {sm.simCetMensal != null ? <> &middot; CET {sm.simCetMensal}%</> : null}
                        {sm.simComSeguroAplicado ? <> &middot; com seguro</> : null}
                      </div>
                      {sm.simValorDivida != null && (
                        <div className="kpi-sub">Total a pagar {fmtMoeda(sm.simValorDivida)}</div>
                      )}
                    </div>
                  ))}
                  {simulacoes.map((sm, i) => (
                    <label key={'esc'+(sm?.simId || i)} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                      <input type="radio" name="simEscolhida" checked={simEscolhida === sm.simId}
                        onChange={() => setSimEscolhida(sm.simId)} />
                      Usar esta ({sm.simBancarizadora} &middot; {fmtMoeda(sm.simValorLiquido)})
                    </label>
                  ))}

                  {!podeGerarProposta && (
                    <p className="kpi-sub" style={{ margin: '2px 0' }}>
                      A Soma ainda n&atilde;o liberou <strong>GERAR_PROPOSTA</strong> nesta jornada
                      (a&ccedil;&otilde;es dispon&iacute;veis: {acoes.join(', ') || 'nenhuma'}). D&aacute; pra
                      preencher o cadastro assim mesmo &mdash; se ela recusar, a mensagem aparece aqui.
                    </p>
                  )}
                </div>
              )}


              {simEscolhida && !propostaFeita && (
                <div style={{ border: '1px solid var(--border, #333)', borderRadius: 8, padding: 10, margin: '6px 0' }}>
                  <p className="kpi-sub" style={{ margin: '0 0 6px' }}>
                    <strong>Dados do cliente</strong> &mdash; a Soma exige tudo isso pra gerar a proposta
                  </p>
                  <label>Nome da m&atilde;e<input value={cad.cliNomeMae} onChange={(e) => setCad({ ...cad, cliNomeMae: e.target.value })} /></label>
                  <label>Profiss&atilde;o<input value={cad.cliProfissao} onChange={(e) => setCad({ ...cad, cliProfissao: e.target.value })} /></label>
                  <label>Nacionalidade<input value={cad.cliNacionalidade} onChange={(e) => setCad({ ...cad, cliNacionalidade: e.target.value })} /></label>
                  <label>Sexo
                    <select value={cad.cliSexo} onChange={(e) => setCad({ ...cad, cliSexo: e.target.value })}>
                      <option value="">selecione</option>
                      <option value="M">Masculino</option>
                      <option value="F">Feminino</option>
                    </select>
                  </label>
                  <label>Estado civil
                    <select value={cad.cliEstadoCivil} onChange={(e) => setCad({ ...cad, cliEstadoCivil: e.target.value })}>
                      <option value="">selecione</option>
                      <option value="SOLTEIRO">Solteiro(a)</option>
                      <option value="CASADO">Casado(a)</option>
                      <option value="DIVORCIADO">Divorciado(a)</option>
                      <option value="VIUVO">Vi&uacute;vo(a)</option>
                      <option value="SEPARADO">Separado(a)</option>
                    </select>
                  </label>
                  <label>E-mail<input value={cad.cliEmail} onChange={(e) => setCad({ ...cad, cliEmail: e.target.value })} type="email" /></label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={cad.cliPoliticamenteExposta}
                      onChange={(e) => setCad({ ...cad, cliPoliticamenteExposta: e.target.checked })} />
                    Pessoa politicamente exposta
                  </label>

                  <p className="kpi-sub" style={{ margin: '8px 0 4px' }}><strong>Endere&ccedil;o</strong></p>
                  <label>CEP<input value={cad.endCep} onChange={(e) => setCad({ ...cad, endCep: e.target.value })} /></label>
                  <label>Rua<input value={cad.endRua} onChange={(e) => setCad({ ...cad, endRua: e.target.value })} /></label>
                  <label>N&uacute;mero<input value={cad.endNumero} onChange={(e) => setCad({ ...cad, endNumero: e.target.value })} /></label>
                  <label>Bairro<input value={cad.endBairro} onChange={(e) => setCad({ ...cad, endBairro: e.target.value })} /></label>
                  <label>Complemento (opcional)<input value={cad.endComplemento} onChange={(e) => setCad({ ...cad, endComplemento: e.target.value })} /></label>
                  <label>Cidade (ID Soma)<input value={cad.endCidadeId} onChange={(e) => setCad({ ...cad, endCidadeId: e.target.value })} /></label>
                  <label>Estado (ID Soma)<input value={cad.endEstadoId} onChange={(e) => setCad({ ...cad, endEstadoId: e.target.value })} /></label>

                  <p className="kpi-sub" style={{ margin: '8px 0 4px' }}><strong>Conta banc&aacute;ria</strong></p>
                  <label>Tipo de conta
                    <select value={cad.conTipoConta} onChange={(e) => setCad({ ...cad, conTipoConta: e.target.value })}>
                      <option value="">selecione</option>
                      <option value="CORRENTE">Corrente</option>
                      <option value="POUPANCA">Poupan&ccedil;a</option>
                    </select>
                  </label>
                  <label>Banco (ID Soma)<input value={cad.conBancoId} onChange={(e) => setCad({ ...cad, conBancoId: e.target.value })} /></label>
                  <label>Ag&ecirc;ncia<input value={cad.conAgencia} onChange={(e) => setCad({ ...cad, conAgencia: e.target.value })} /></label>
                  <label>D&iacute;gito da ag&ecirc;ncia<input value={cad.conDigitoAgencia} onChange={(e) => setCad({ ...cad, conDigitoAgencia: e.target.value })} /></label>
                  <label>Conta<input value={cad.conConta} onChange={(e) => setCad({ ...cad, conConta: e.target.value })} /></label>
                  <label>D&iacute;gito da conta<input value={cad.conDigitoConta} onChange={(e) => setCad({ ...cad, conDigitoConta: e.target.value })} /></label>
                  <label>Tipo de PIX
                    <select value={cad.conTipoPix} onChange={(e) => setCad({ ...cad, conTipoPix: e.target.value })}>
                      <option value="">selecione</option>
                      <option value="CPF">CPF</option>
                      <option value="EMAIL">E-mail</option>
                      <option value="CELULAR">Celular</option>
                      <option value="ALEATORIA">Chave aleat&oacute;ria</option>
                    </select>
                  </label>
                  <label>Chave PIX<input value={cad.conChavePix} onChange={(e) => setCad({ ...cad, conChavePix: e.target.value })} /></label>

                  <button type="button" className="refresh-btn" onClick={cadastrarECriarProposta} disabled={carregando}>
                    {carregando ? 'Enviando...' : 'Cadastrar cliente e gerar proposta'}
                  </button>
                </div>
              )}

              {propostaFeita && (
                <div style={{ border: '2px solid #30a46c', background: 'rgba(48,164,108,0.12)', borderRadius: 8, padding: 10, margin: '6px 0' }}>
                  <p style={{ margin: 0, fontWeight: 700, color: '#30a46c' }}>Proposta gerada</p>
                  <p className="kpi-sub" style={{ margin: '4px 0 0' }}>
                    {propostaFeita.proId || propostaFeita.propostaId || ''} {propostaFeita.proNumBancarizadora ? ' · nº ' + propostaFeita.proNumBancarizadora : ''}
                  </p>
                </div>
              )}

              <button type="button" className="refresh-btn" onClick={atualizar} disabled={carregando}>
                {carregando ? 'Atualizando...' : 'Atualizar status'}
              </button>
              <button type="button" className="reset-btn" style={{ fontSize: 12, padding: '4px 8px' }}
                onClick={() => {
                  setJornada(null); setMsg(''); setSimulouAuto(false); setMargemSalva(null); setCopiado(false)
                  jaSimulouRef.current = null; tentativasRef.current = 0
                  setSimEscolhida(null); setContaId(null); setPropostaFeita(null)
                  setForm({ cpf: '', nome: '', celular: '', dataNascimento: '' })
                  setSimForm({ bancarizadora: '', tipoCalculo: 'VALOR_PARCELA', valor: '', parcelas: '', comSeguro: true })
                }}>
                &larr; Nova consulta
              </button>
            </>
          )}

          {msg && (
            <p className="kpi-sub" style={{
              margin: '6px 0', padding: '6px 8px', borderRadius: 6,
              border: '1px solid var(--border, #333)',
              background: /erro|não|nao |recus|inv|falh/i.test(msg) ? 'rgba(229,72,77,0.12)' : 'transparent',
            }}>{msg}</p>
          )}
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

  // Status que significam "pago" nos bancos com API. Fora disso, a vendedora
  // ve o status e decide se preenche a mao (nao gravamos venda nao paga).
  const STATUS_PAGO_RE = /pag[oa]|integrad|liquidat|contrato pago|credit|desembols/i

  const [c6Opcoes, setC6Opcoes] = useState([])

  // C6: o nome da tabela e um agrupamento POR PRAZO — o mesmo plano tem nomes
  // diferentes em prazos diferentes, e o peso so resolve quando nome e prazo
  // combinam. Antes as opcoes so eram filtradas depois da busca na API; no
  // preenchimento manual caia na lista estatica, sem filtro, e dava pra gravar
  // uma combinacao que nao existe (venda entra com peso null = zero ponto).
  // Agora carrega direto de c6_planos_da_tabela sempre que o prazo muda.
  useEffect(() => {
    if (addForm.banco !== 'C6') { setC6Opcoes([]); return }
    const p = parseInt(addForm.parcelas, 10)
    if (!Number.isFinite(p) || p <= 0) { setC6Opcoes([]); return }
    let cancelado = false
    ;(async () => {
      try {
        const o = await postApi('c6_tabelas_opcoes', { parcelas: p })
        if (!cancelado) setC6Opcoes(o?.opcoes || [])
      } catch { if (!cancelado) setC6Opcoes([]) }
    })()
    return () => { cancelado = true }
  }, [addForm.banco, addForm.parcelas])

  const gravarDireto = async (vendedorAlvo, dados) => {
    const result = await postApi('vendedoras_add_venda', {
      vendedor: vendedorAlvo,
      adesao: dados.adesao,
      cpf: dados.cpf,
      nome: dados.nome,
      valor: String(dados.valor).replace(',', '.'),
      banco: dados.banco,
      tabela: dados.tabela || '',
      data_pagamento: dados.dataPagamento || null,
      parcelas: dados.parcelas ? parseInt(dados.parcelas, 10) : null,
      seguro: dados.seguro || null,
    })
    const r = Array.isArray(result) ? result[0] : result
    if (r?.ok === false) throw new Error(r.mensagem || 'Nao foi possivel gravar.')
    return r
  }

  const buscarNaApi = async () => {
    if (!addForm.adesao) { setAddMsg('Informe a adesão pra buscar.'); return }
    const vendedorAlvo = vendedorFixo || addForm.vendedorSel
    if (!vendedorAlvo) { setAddMsg('Selecione a vendedora antes de buscar.'); return }
    setBuscando(true); setAddMsg(''); setBuscaResultado(null)
    try {
      const d = await postApi('consulta_adesao_banco', { banco: addForm.banco, adesao: addForm.adesao, cpf: addForm.cpf || null })
      if (d?.error) { setAddMsg(d.error); return }
      setBuscaResultado(d)

      if (!d.encontrado) {
        // Nao achou no banco: abre o formulario completo direto
        setManualApesarDeApi(true)
        setAddMsg(d.mensagem || 'Proposta não encontrada na API do banco. Preencha os dados manualmente.')
        return
      }

      const preenchido = {
        ...addForm,
        cpf: d.cpf_banco || addForm.cpf,
        nome: d.nome_banco || addForm.nome,
        valor: d.valor_banco != null ? String(d.valor_banco) : addForm.valor,
        tabelaNome: d.tabela_banco || addForm.tabelaNome,
        parcelas: d.parcelas_banco != null ? String(d.parcelas_banco) : addForm.parcelas,
      }
      setAddForm(preenchido)

      const pago = STATUS_PAGO_RE.test(String(d.status_banco || ''))
      const completo = !!(preenchido.cpf && preenchido.nome && preenchido.valor)
      const precisaTabelaManual = BANCOS_TABELA_SEMPRE_MANUAL.includes(addForm.banco)

      if (precisaTabelaManual) {
        // C6: a API nao devolve a tabela comercial. Carrega as opcoes validas
        // para o prazo devolvido e deixa a vendedora escolher no select.
        try {
          const o = await postApi('c6_tabelas_opcoes', { parcelas: preenchido.parcelas || null })
          setC6Opcoes(o?.opcoes || [])
        } catch { setC6Opcoes([]) }
        setManualApesarDeApi(true)
        setAddMsg(pago
          ? 'Proposta paga encontrada. Escolha a tabela e confirme.'
          : `Proposta encontrada com status "${d.status_banco || '?'}" (ainda não paga). Escolha a tabela e confirme se quiser gravar.`)
        return
      }

      if (pago && completo) {
        // Caminho feliz: pago e com tudo -> grava sem perguntar mais nada
        await gravarDireto(vendedorAlvo, {
          adesao: preenchido.adesao, cpf: preenchido.cpf, nome: preenchido.nome, valor: preenchido.valor,
          banco: addForm.banco, tabela: preenchido.tabelaNome, parcelas: preenchido.parcelas,
          dataPagamento: preenchido.dataPagamento, seguro: preenchido.seguro,
        })
        setAddMsg(`Venda gravada: ${preenchido.nome} · ${fmtMoeda(Number(preenchido.valor))} · ${preenchido.parcelas || '?'}x · ${preenchido.tabelaNome || ''}`)
        setAddForm((f) => ({ ...f, adesao: '', cpf: '', nome: '', valor: '', tabelaNome: '', parcelas: '', codigo: '' }))
        setBuscaResultado(null)
        if (typeof load === 'function') load()
        return
      }

      // Achou mas nao esta paga, ou faltou algum dado: abre os campos
      setManualApesarDeApi(true)
      setAddMsg(!pago
        ? `Proposta encontrada com status "${d.status_banco || '?'}" — ainda não consta como paga. Confira os dados e confirme se quiser gravar.`
        : 'Proposta encontrada, mas faltou algum dado. Complete e confirme.')
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
    // C6: trava a combinacao impossivel antes de gravar. Sem isso a venda entra
    // com peso null e aparece valendo zero ponto pra vendedora.
    if (addForm.banco === 'C6') {
      const p = parseInt(addForm.parcelas, 10)
      if (!Number.isFinite(p) || p <= 0) {
        setAddMsg('Informe as parcelas antes de escolher a tabela do C6 — o peso depende do prazo.')
        return
      }
      const cod = String(addForm.tabelaNome || '').replace(/\D/g, '')
      const opc = c6Opcoes.find((o) => o.codigo === cod)
      if (!cod || !opc) {
        setAddMsg(`O código "${addForm.tabelaNome || ''}" não existe para ${p}x. Escolha um código da lista.`)
        return
      }
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
        tabela: addForm.banco === 'C6'
          ? (c6Opcoes.find((o) => o.codigo === String(addForm.tabelaNome || '').replace(/\D/g, ''))?.nome || addForm.tabelaNome)
          : (ehPorCodigo ? addForm.codigo : (ehPorTabelaNome || ehBancoComApi || ehTabelaLivreDeApiBanco ? addForm.tabelaNome : '')),
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

  // C6: se a busca na API ja devolveu as parcelas, oferece so as tabelas
  // validas para aquele prazo (vindas de c6_planos_da_tabela, no formato do
  // portal). Sem busca, cai na lista estatica.
  // C6: as tabelas validas dependem do prazo, entao a lista so existe depois
  // que as parcelas foram informadas. Sem parcelas o select fica vazio e o
  // formulario pede o prazo primeiro — nao volta mais pra lista estatica sem
  // filtro, que era o que deixava gravar nome e prazo incompativeis.
  const tabelaOpcoes = addForm.banco === 'FGTSV8' ? FGTSV8_TABELAS
    : addForm.banco === 'C6' ? []  // C6 usa o datalist de codigos (c6Opcoes), nao este select
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

              {BANCOS_POR_TABELA_NOME.includes(addForm.banco) && addForm.banco !== 'C6' && (
                <label>Tabela
                  <select required value={addForm.tabelaNome} onChange={(e) => setAddForm({ ...addForm, tabelaNome: e.target.value })}>
                    <option value="">selecione a tabela</option>
                    {tabelaOpcoes.map((t) => <option key={t.valor} value={t.valor}>{t.label}</option>)}
                  </select>
                </label>
              )}
              {addForm.banco === 'C6' && (
                <label>C&oacute;digo da tabela {parseInt(addForm.parcelas, 10) > 0 ? `(${addForm.parcelas}x)` : ''}
                  <input
                    required
                    list="c6-codigos"
                    value={addForm.tabelaNome}
                    onChange={(e) => setAddForm({ ...addForm, tabelaNome: e.target.value })}
                    placeholder={parseInt(addForm.parcelas, 10) > 0 ? 'ex.: 800188 — escolha ou digite' : 'informe as parcelas primeiro'}
                    disabled={!(parseInt(addForm.parcelas, 10) > 0)}
                  />
                  <datalist id="c6-codigos">
                    {c6Opcoes.map((o) => <option key={o.codigo} value={o.codigo}>{`${o.descricao || ''} · peso ${o.pontos}`}</option>)}
                  </datalist>
                  {(() => {
                    const cod = String(addForm.tabelaNome || '').replace(/\D/g, '')
                    const o = c6Opcoes.find((x) => x.codigo === cod)
                    if (!cod) return null
                    return o
                      ? <span className="kpi-sub">{o.descricao || o.codigo} &middot; peso {o.pontos}</span>
                      : <span className="kpi-sub" style={{ color: 'var(--red, #e88)' }}>c&oacute;digo n&atilde;o existe para {addForm.parcelas}x</span>
                  })()}
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
// ---------------------------------------------------------------------
// PAN — a vendedora cadastra a proposta aqui e acompanha o andamento.
// Entra na view Vendedoras (geral) e no portal restrito.
// vendedorFixo preenchido = portal restrito (só as propostas dela);
// null = visão geral (todas as vendedoras).
// ---------------------------------------------------------------------
function PanBadge({ grupo }) {
  const mapa = {
    autorizacao: { txt: 'Autorização', cor: '#e0a458' },
    aprovado: { txt: 'Aprovado', cor: 'var(--green, #7ddc9a)' },
    reprovado: { txt: 'Reprovado', cor: '#e08585' },
    pago: { txt: 'Pago', cor: '#7aa7e0' },
  }
  const m = mapa[grupo] || { txt: grupo || '-', cor: 'var(--text)' }
  return <span style={{ color: m.cor, fontWeight: 600, whiteSpace: 'nowrap' }}>{m.txt}</span>
}

// Colunas: adesao, cliente, cpf, [vendedora], valor, parc, status, acao
function PanTabela({ titulo, linhas, mostrarVendedor, onSimular }) {
  if (!linhas?.length) return null
  const cols = mostrarVendedor
    ? '1fr 1.5fr 1.1fr 1.2fr 1fr 0.5fr 0.9fr 0.8fr'
    : '1fr 1.6fr 1.1fr 1fr 0.5fr 0.9fr 0.8fr'
  return (
    <div style={{ marginBottom: 14 }}>
      <p className="kpi-label" style={{ marginBottom: 6 }}>{titulo} ({linhas.length})</p>
      <div className="panel table-panel">
        <div className="template-row head" style={{ gridTemplateColumns: cols }}>
          <div>Adesão</div><div>Cliente</div><div>CPF</div>
          {mostrarVendedor && <div>Vendedora</div>}
          <div>Valor</div><div>Parc.</div><div>Status</div><div></div>
        </div>
        {linhas.map((l) => (
          <div className="template-row" key={l.adesao} style={{ gridTemplateColumns: cols, alignItems: 'center' }}>
            <div>{l.adesao}</div>
            <div>{l.nome || '-'}</div>
            <div>{l.cpf || '-'}</div>
            {mostrarVendedor && <div>{l.vendedor || '-'}</div>}
            <div>{l.valor != null ? fmtMoeda(l.valor) : '-'}</div>
            <div>{l.parcelas ?? '-'}</div>
            <div><PanBadge grupo={l.grupo} /></div>
            <div>
              {l.grupo === 'aprovado' && onSimular && (
                <button type="button" className="refresh-btn" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => onSimular(l)}>
                  Simular
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const PAN_INTERVALO_MS = 5 * 60 * 1000 // atualiza sozinho a cada 5 min

function PanModal({ vendedorFixo, onClose }) {
  const [busca, setBusca] = useState('')
  const [achado, setAchado] = useState(null)
  const [listas, setListas] = useState(null)
  const [erro, setErro] = useState('')
  const [carregando, setCarregando] = useState(false)
  const [atualizando, setAtualizando] = useState(false)
  const [ultimaAtualizacao, setUltimaAtualizacao] = useState(null)

  const soDigitos = String(busca).replace(/\D/g, '')
  const ehCpf = soDigitos.length === 11
  const mostrarVendedor = !vendedorFixo

  // Esteira/formalizacao do PAN sobre a proposta pesquisada. 'aprovar' so na
  // view geral (backend tambem barra). Resposta fica em esteira[proposta].
  const [esteira, setEsteira] = useState({})     // { [proposta]: { acao, ok, ... } }
  const [esteiraBusy, setEsteiraBusy] = useState('')
  const acaoEsteira = async (linha, acao) => {
    if (acao === 'aprovar' && !window.confirm(`Aprovar a proposta ${linha.adesao} de ${linha.nome || 'cliente'} no PAN?`)) return
    if (acao === 'cancelar' && !window.confirm(`CANCELAR a proposta ${linha.adesao} no PAN? Isso não tem volta.`)) return
    setEsteiraBusy(`${linha.adesao}:${acao}`); setErro('')
    try {
      const d = await postApi('pan_esteira', { acao, proposta: linha.adesao, cpf: linha.cpf, geral: !vendedorFixo })
      if (d?.error) { setErro(d.error); return }
      setEsteira((e) => ({ ...e, [linha.adesao]: { ...d, acao } }))
      if (['aprovar', 'cancelar'].includes(acao) && d.ok) await carregarListas()
    } catch (e2) {
      setErro('Erro: ' + (e2.message || ''))
    } finally {
      setEsteiraBusy('')
    }
  }
  const PAN_STATUS_APROVAVEL = /an[aá]lise\s*(promotora|master)/i

  const carregarListas = async () => {
    try {
      const d = await postApi('pan_listar', { vendedor: vendedorFixo || null })
      if (!d?.error) { setListas(d); setUltimaAtualizacao(new Date()) }
    } catch { /* silencioso: atualizacao de fundo */ }
  }

  // Atualiza sozinho a cada 5 min. Pagas e reprovadas nao sao reconsultadas
  // (quem filtra e a RPC pan_propostas_pendentes, dentro do workflow do n8n).
  useEffect(() => {
    carregarListas()
    // O n8n consulta as APIs a cada 5 min (workflow 'Conferencia APIs bancos');
    // aqui so recarregamos as listas do Postgres no mesmo ritmo.
    const id = setInterval(carregarListas, PAN_INTERVALO_MS)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendedorFixo])

  const atualizarAgora = async () => {
    setAtualizando(true); setErro('')
    try {
      await postApi('pan_atualizar', { vendedor: vendedorFixo || null })
      await carregarListas()
    } catch (e) {
      setErro('Erro ao atualizar: ' + (e.message || ''))
    } finally {
      setAtualizando(false)
    }
  }

  const buscar = async (e) => {
    e?.preventDefault()
    if (!soDigitos) { setErro('Informe o CPF ou a adesão.'); return }
    setCarregando(true); setErro(''); setAchado(null)
    try {
      const d = await postApi('pan_buscar', ehCpf ? { cpf: soDigitos } : { adesao: soDigitos })
      if (d?.error) { setErro(d.error); return }
      setAchado(d)
    } catch (e2) {
      setErro('Erro na busca: ' + (e2.message || ''))
    } finally {
      setCarregando(false)
    }
  }

  return (
    <div className="funil-overlay" onClick={onClose}>
      <div className="funil-panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 940 }}>
        <div className="funil-header">
          <div><h2>PAN{vendedorFixo ? '' : ' \u2014 todas as vendedoras'}</h2></div>
          <button className="funil-close" onClick={onClose}>&times;</button>
        </div>

        {erro && <p className="state-msg" style={{ color: '#e08585' }}>{erro}</p>}

        <form className="add-venda-form" onSubmit={buscar}>
          <label>CPF ou adesão</label>
          <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="CPF (11 dígitos) ou número da adesão" autoFocus />
          <button type="submit" className="refresh-btn" disabled={carregando}>
            {carregando ? 'Consultando...' : 'Consultar'}
          </button>
        </form>

        {achado && (
          <div style={{ marginBottom: 14 }}>
            {achado.tem_proposta ? (
              <>
                <p className="kpi-label">Proposta encontrada &mdash; siga daqui para o cadastro</p>
                <PanTabela titulo="Resultado" linhas={achado.propostas} mostrarVendedor={mostrarVendedor} />
                {achado.propostas.map((l) => {
                  const r = esteira[l.adesao]
                  const busy = (a) => esteiraBusy === `${l.adesao}:${a}`
                  const podeAprovar = !vendedorFixo && l.grupo !== 'pago' && l.grupo !== 'reprovado'
                  const podeCancelar = l.grupo !== 'pago' && l.grupo !== 'reprovado'
                  return (
                    <div key={`acoes-${l.adesao}`} className="panel" style={{ marginTop: 6, padding: 10 }}>
                      <p className="kpi-sub" style={{ marginBottom: 6 }}>
                        Ades&atilde;o {l.adesao} &middot; {l.status || l.grupo || '-'}
                        {!vendedorFixo && !PAN_STATUS_APROVAVEL.test(l.status || '') && podeAprovar ? ' · aprovar só funciona em Análise Promotora/Master' : ''}
                      </p>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {podeAprovar && (
                          <button type="button" className="refresh-btn" disabled={!!esteiraBusy} onClick={() => acaoEsteira(l, 'aprovar')} style={{ fontSize: 12 }}>
                            {busy('aprovar') ? 'Aprovando...' : '\u2714 Aprovar'}
                          </button>
                        )}
                        {podeCancelar && (
                          <button type="button" className="reset-btn" disabled={!!esteiraBusy} onClick={() => acaoEsteira(l, 'cancelar')} style={{ fontSize: 12 }}>
                            {busy('cancelar') ? 'Cancelando...' : '\u2716 Cancelar'}
                          </button>
                        )}
                        <button type="button" className="reset-btn" disabled={!!esteiraBusy || !l.cpf} onClick={() => acaoEsteira(l, 'documentos')} style={{ fontSize: 12 }}>
                          {busy('documentos') ? 'Consultando...' : '\ud83d\udcc4 Documentos'}
                        </button>
                        <button type="button" className="reset-btn" disabled={!!esteiraBusy || !l.cpf} onClick={() => acaoEsteira(l, 'link')} style={{ fontSize: 12 }}>
                          {busy('link') ? 'Buscando...' : '\ud83d\udd17 Link de assinatura'}
                        </button>
                      </div>
                      {r && (
                        <div style={{ marginTop: 8 }}>
                          {r.acao === 'link' && r.ok && r.link && (
                            <p className="kpi-sub" style={{ wordBreak: 'break-all' }}>
                              <a href={r.link} target="_blank" rel="noreferrer">{r.link}</a>{' '}
                              <button type="button" className="reset-btn" onClick={() => navigator.clipboard?.writeText(r.link)}>copiar</button>
                            </p>
                          )}
                          {r.acao === 'documentos' && r.ok && (
                            <div>
                              {(r.documentos || []).length === 0
                                ? <p className="kpi-sub">Nenhum documento pendente.</p>
                                : (r.documentos || []).map((d, i) => (
                                    <p className="kpi-sub" key={i}>{d.tipo || d.descricao || JSON.stringify(d)}{d.status ? ` · ${d.status}` : ''}{d.obrigatorio ? ' · obrigatório' : ''}</p>
                                  ))}
                            </div>
                          )}
                          {['aprovar', 'cancelar'].includes(r.acao) && (
                            <p className="kpi-sub" style={{ color: r.ok ? 'var(--green, #7ddc9a)' : 'var(--red, #e88)' }}>
                              {r.ok ? `${r.acao === 'aprovar' ? 'Aprovada' : 'Cancelada'} no PAN.` : 'O PAN recusou.'}
                              {r.mensagem ? ` ${r.mensagem}` : ''}
                            </p>
                          )}
                          {!r.ok && (
                            <details><summary className="kpi-sub">resposta do PAN</summary>
                              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>{JSON.stringify(r.erro || r.bruto || r, null, 2).slice(0, 1500)}</pre>
                            </details>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </>
            ) : achado.vendas?.length ? (
              <>
                <p className="kpi-label">Sem proposta em andamento, mas ha venda lancada</p>
                {achado.vendas.map((v) => (
                  <p className="kpi-sub" key={v.id}>
                    Adesão {v.adesao} &middot; {v.nome || '-'} &middot; {fmtMoeda(v.valor || 0)} &middot; {v.parcelas}x
                  </p>
                ))}
              </>
            ) : (
              <>
                <p className="kpi-label">Nenhuma proposta para {ehCpf ? 'esse CPF' : 'essa adesão'}</p>
                <p className="kpi-sub">
                  {achado.cliente?.encontrado
                    ? `Cliente localizado nas nossas bases: ${achado.cliente.nome}. Pode seguir para a simulação.`
                    : 'Cliente não localizado nas nossas bases. A simulação vai pedir os dados.'}
                </p>
              </>
            )}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 10, flexWrap: 'wrap' }}>
          <p className="kpi-label" style={{ margin: 0 }}>Acompanhamento</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {ultimaAtualizacao && (
              <span className="kpi-sub" style={{ margin: 0 }}>
                atualizado {ultimaAtualizacao.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            <button type="button" className="refresh-btn" onClick={atualizarAgora} disabled={atualizando} style={{ fontSize: 12 }}>
              {atualizando ? 'Atualizando...' : '\u21bb Atualizar agora'}
            </button>
          </div>
        </div>

        {!listas ? (
          <p className="state-msg">Carregando...</p>
        ) : listas.total === 0 ? (
          <p className="state-msg">Nenhuma proposta do PAN registrada ainda.</p>
        ) : (
          <>
            <PanTabela titulo="Aguardando autorização" linhas={listas.autorizacao} mostrarVendedor={mostrarVendedor} />
            <PanTabela titulo="Aprovadas" linhas={listas.aprovadas} mostrarVendedor={mostrarVendedor} onSimular={() => {}} />
            <PanTabela titulo="Pagas" linhas={listas.pagas} mostrarVendedor={mostrarVendedor} />
            <PanTabela titulo="Reprovadas" linhas={listas.reprovadas} mostrarVendedor={mostrarVendedor} />
          </>
        )}

        <p className="kpi-sub">As listas se atualizam sozinhas a cada 5 minutos. Propostas pagas e reprovadas não são reconsultadas.</p>
      </div>
    </div>
  )
}


// C6 — consulta de proposta por adesão ou por CPF.
// Por adesão vai na API do banco (webhook consulta-adesao-banco, ramo C6 que
// já existia) e grava/atualiza pelo conferir_e_lancar_proposta.
// Por CPF lista o que já temos em propostas_bancos: a API do C6 não tem busca
// por CPF documentada, só por proposalNumber.
function C6Modal({ vendedorFixo, vendedoresDisponiveis, onClose }) {
  const [vendSel, setVendSel] = useState('')  // view geral: vendedora dona da jornada
  const [modo, setModo] = useState('adesao') // adesao | cpf | jornada
  const [adesao, setAdesao] = useState('')
  const [cpf, setCpf] = useState('')
  const [res, setRes] = useState(null)
  const [erro, setErro] = useState('')
  const [carregando, setCarregando] = useState(false)

  // Jornada do Emprestimo do Trabalhador: gerar link -> cliente autoriza ->
  // status AUTORIZADO -> simular. O link e do CLIENTE (prova de vida): a
  // vendedora manda pra ele, nao abre por ele.
  const [jor, setJor] = useState({ nome: '', nascimento: '', telefone: '', parcelas: '', valor: '', renda: '', matricula: '', codigo: '' })
  const [jorLink, setJorLink] = useState(null)
  const [jorStatus, setJorStatus] = useState(null)
  const [jorSim, setJorSim] = useState(null)
  const [jorMsg, setJorMsg] = useState('')
  const [jorBusy, setJorBusy] = useState('')

  const jornada = async (acao) => {
    const doc = String(cpf).replace(/\D/g, '')
    if (doc.length !== 11) { setJorMsg('CPF precisa ter 11 dígitos.'); return }
    if (!vendedorFixo && !vendSel && acao !== 'status') { setJorMsg('Selecione a vendedora dona dessa jornada.'); return }
    setJorBusy(acao); setJorMsg('')
    try {
      const d = await postApi('c6_jornada', {
        acao, cpf: doc, vendedor: vendedorFixo || vendSel || null,
        nome: jor.nome, data_nascimento: jor.nascimento, telefone: jor.telefone,
        parcelas: jor.parcelas, valor: jor.valor, renda: jor.renda, matricula: jor.matricula, covenant_code: jor.codigo,
      })
      if (d?.error) { setJorMsg(d.error); return }
      const txt = (x) => (typeof x === 'string' ? x : JSON.stringify(x || '')).slice(0, 400)
      if (acao === 'gerar') {
        if (d.ok) { setJorLink({ link: d.link, data_expiracao: d.data_expiracao }); setJorStatus(null); setJorMsg('Link gerado. Envie ao cliente para ele autorizar.') }
        else setJorMsg('C6 recusou a geração: ' + txt(d.erro || d.bruto))
      } else if (acao === 'status') {
        setJorStatus({ status_autorizacao: d.status_autorizacao, observacao: d.observacao, expirado: d.expirado, autorizado: d.autorizado })
        if (d.expirado) setJorMsg('A autorização anterior expirou. Gere um novo link.')
        else if (!d.ok) setJorMsg('Status: ' + txt(d.erro))
      } else {
        setJorSim(d)
        if (!d.ok) setJorMsg('Simulação recusada: ' + txt(d.erro || d.bruto))
      }
    } catch (e2) {
      setJorMsg('Erro: ' + (e2.message || ''))
    } finally {
      setJorBusy('')
      carregarJornadas()
    }
  }
  const autorizado = !!jorStatus?.autorizado

  // acompanhamento: o que a vendedora ja fez (link, status, simulacao, proposta)
  const [jornadas, setJornadas] = useState([])
  const carregarJornadas = async () => {
    try { const d = await postApi('c6_jornada', { acao: 'listar', vendedor: vendedorFixo || null }); setJornadas(d?.jornadas || []) } catch {}
  }
  useEffect(() => { if (modo === 'jornada') carregarJornadas() }, [modo])
  const rotuloStatus = (s, expirado) => expirado ? 'EXPIRADA'
    : /^(AUTHORIZED|AUTORIZADO)$/i.test(s || '') ? 'AUTORIZADO'
    : /WAITING|AGUARDANDO/i.test(s || '') ? 'AGUARDANDO'
    : /NOT_AUTHORIZED|NAO_AUTORIZADO/i.test(s || '') ? 'NÃO AUTORIZADO'
    : (s || '—')

  const consultar = async (e) => {
    e?.preventDefault()
    setErro(''); setRes(null)
    const doc = String(cpf).replace(/\D/g, '')
    if (modo === 'cpf' && doc.length !== 11) { setErro('CPF precisa ter 11 dígitos.'); return }
    if (modo === 'adesao' && !String(adesao).replace(/\D/g, '')) { setErro('Informe o número da adesão.'); return }
    setCarregando(true)
    try {
      const d = await postApi('c6_consulta', modo === 'adesao'
        ? { adesao, cpf: doc || null }
        : { cpf: doc })
      if (d?.error) { setErro(d.error); return }
      setRes(d)
    } catch (e2) {
      setErro('Erro na consulta: ' + (e2.message || ''))
    } finally {
      setCarregando(false)
    }
  }

  const linhaStatus = (p) => (
    <div className="template-row" key={p.proposal_id} style={{ gridTemplateColumns: '1.1fr 1.4fr 0.9fr 0.6fr 0.8fr', alignItems: 'center' }}>
      <span style={{ wordBreak: 'break-all' }}>{p.proposal_id}</span>
      <span>{p.tabela_nome || '-'}</span>
      <span>{p.valor != null ? fmtMoeda(Number(p.valor)) : '-'}</span>
      <span>{p.parcelas ?? '-'}</span>
      <span style={{ color: p.pago ? 'var(--green, #7ddc9a)' : p.cancelado ? 'var(--red, #e88)' : 'var(--text)' }}>
        {p.pago ? 'Paga' : p.cancelado ? 'Cancelada' : (p.status || '-')}
      </span>
    </div>
  )

  return (
    <div className="funil-overlay" onClick={onClose}>
      <div className="funil-panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="funil-header">
          <div><h2>C6 &mdash; consulta de proposta</h2></div>
          <button className="funil-close" onClick={onClose}>&times;</button>
        </div>

        <form className="add-venda-form" onSubmit={consultar}>
          <label>Buscar por
            <select value={modo} onChange={(e) => { setModo(e.target.value); setRes(null); setErro('') }}>
              <option value="adesao">Ades&atilde;o (consulta a API do C6)</option>
              <option value="cpf">CPF (propostas j&aacute; registradas)</option>
              <option value="jornada">Jornada: autoriza&ccedil;&atilde;o + simula&ccedil;&atilde;o</option>
            </select>
          </label>

          {modo === 'jornada' && !vendedorFixo && (
            <label>Vendedora
              <select value={vendSel} onChange={(e) => setVendSel(e.target.value)}>
                <option value="">selecione a vendedora</option>
                {(vendedoresDisponiveis || []).map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          )}
          {modo === 'jornada' ? (
            <label>CPF do cliente
              <input required value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="somente n&uacute;meros" />
            </label>
          ) : modo === 'adesao' ? (
            <>
              <label>Ades&atilde;o / n&uacute;mero da proposta
                <input required value={adesao} onChange={(e) => setAdesao(e.target.value)} placeholder="ex.: 606185838" />
              </label>
              <label>CPF (opcional, ajuda a casar a venda)
                <input value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="somente n&uacute;meros" />
              </label>
            </>
          ) : (
            <label>CPF do cliente
              <input required value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="somente n&uacute;meros" />
            </label>
          )}

          {modo !== 'jornada' && (
            <button type="submit" className="refresh-btn" disabled={carregando}>
              {carregando ? 'Consultando...' : 'Consultar'}
            </button>
          )}
        </form>

        {modo === 'jornada' && (
          <div className="add-venda-form" style={{ marginTop: 8 }}>
            <p className="section-label">1. Autoriza&ccedil;&atilde;o de consulta de dados</p>
            <label>Nome completo
              <input value={jor.nome} onChange={(e) => setJor({ ...jor, nome: e.target.value })} placeholder="como no documento" />
            </label>
            <label>Data de nascimento
              <input type="date" value={jor.nascimento} onChange={(e) => setJor({ ...jor, nascimento: e.target.value })} />
            </label>
            <label>Celular (com DDD)
              <input value={jor.telefone} onChange={(e) => setJor({ ...jor, telefone: e.target.value })} placeholder="17988005963" />
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="refresh-btn" disabled={!!jorBusy} onClick={() => jornada('gerar')}>
                {jorBusy === 'gerar' ? 'Gerando...' : 'Gerar link de autoriza\u00e7\u00e3o'}
              </button>
              <button type="button" className="reset-btn" disabled={!!jorBusy} onClick={() => jornada('status')}>
                {jorBusy === 'status' ? 'Consultando...' : 'Consultar status'}
              </button>
            </div>
            {jorLink?.link && (
              <p className="kpi-sub" style={{ wordBreak: 'break-all' }}>
                Link para o cliente: <a href={jorLink.link} target="_blank" rel="noreferrer">{jorLink.link}</a>
                {jorLink.data_expiracao ? ` \u00b7 expira ${jorLink.data_expiracao}` : ''}
                {' '}<button type="button" className="reset-btn" onClick={() => navigator.clipboard?.writeText(jorLink.link)}>copiar</button>
              </p>
            )}
            {jorStatus && (
              <p className="kpi-value" style={{ color: autorizado ? 'var(--green, #7ddc9a)' : jorStatus.expirado ? 'var(--red, #e88)' : 'var(--text)' }}>
                {rotuloStatus(jorStatus.status_autorizacao, jorStatus.expirado)}
                {jorStatus.observacao ? <span className="kpi-sub"> &middot; {jorStatus.observacao}</span> : null}
              </p>
            )}

            <p className="section-label" style={{ marginTop: 12 }}>2. Simula&ccedil;&atilde;o {autorizado ? '' : '(libera ap\u00f3s AUTORIZADO)'}</p>
            <label>Parcelas
              <input value={jor.parcelas} onChange={(e) => setJor({ ...jor, parcelas: e.target.value })} placeholder="ex.: 24" disabled={!autorizado} />
            </label>
            <label>Valor solicitado (R$)
              <input value={jor.valor} onChange={(e) => setJor({ ...jor, valor: e.target.value })} placeholder="ex.: 3000" disabled={!autorizado} />
            </label>
            <label>Renda mensal (R$)
              <input value={jor.renda} onChange={(e) => setJor({ ...jor, renda: e.target.value })} placeholder="ex.: 2500" disabled={!autorizado} />
            </label>
            <label>C&oacute;digo da tabela (opcional)
              <input value={jor.codigo} onChange={(e) => setJor({ ...jor, codigo: e.target.value })} placeholder="ex.: 800080" disabled={!autorizado} />
            </label>
            <label>Matr&iacute;cula (10 d&iacute;gitos, s&oacute; se a API pedir)
              <input value={jor.matricula} onChange={(e) => setJor({ ...jor, matricula: e.target.value })} placeholder="deixe vazio na primeira tentativa" disabled={!autorizado} />
            </label>
            <button type="button" className="refresh-btn" disabled={!autorizado || !!jorBusy} onClick={() => jornada('simular')}>
              {jorBusy === 'simular' ? 'Simulando...' : 'Simular'}
            </button>
            {jorSim?.ok && jorSim.simulacao && (
              <div className="panel" style={{ marginTop: 8 }}>
                <p className="kpi-label">{jorSim.simulacao.product?.description || jorSim.simulacao.covenant?.description || 'Simula\u00e7\u00e3o'}</p>
                <p className="kpi-value">{jorSim.simulacao.net_amount != null ? fmtMoeda(Number(jorSim.simulacao.net_amount)) : '-'}</p>
                <p className="kpi-sub">
                  {jorSim.simulacao.installment_quantity ? `${jorSim.simulacao.installment_quantity}x de ` : ''}
                  {jorSim.simulacao.installment_amount != null ? fmtMoeda(Number(jorSim.simulacao.installment_amount)) : '-'}
                  {jorSim.simulacao.monthly_customer_rate != null ? ` \u00b7 ${jorSim.simulacao.monthly_customer_rate}% a.m.` : ''}
                  {jorSim.simulacao.iof_amount != null ? ` \u00b7 IOF ${fmtMoeda(Number(jorSim.simulacao.iof_amount))}` : ''}
                </p>
              </div>
            )}
            {jorSim && !jorSim.ok && jorSim.enviado && (
              <details style={{ marginTop: 6 }}><summary className="kpi-sub">o que foi enviado / o que o C6 respondeu</summary>
                <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>{JSON.stringify({ enviado: jorSim.enviado, erro: jorSim.erro }, null, 2)}</pre>
              </details>
            )}
            {jorMsg && <p className="state-msg" style={{ marginTop: 8 }}>{jorMsg}</p>}

            {jornadas.length > 0 && (
              <div className="panel table-panel" style={{ marginTop: 14 }}>
                <p className="section-label">Acompanhamento {vendedorFixo ? '' : '(todas as vendedoras)'} &middot; {jornadas.length}</p>
                <div className="template-row head" style={{ gridTemplateColumns: '0.9fr 1.2fr 0.9fr 0.9fr 0.8fr 0.7fr' }}>
                  <span>CPF</span><span>Cliente</span><span>Autoriza&ccedil;&atilde;o</span><span>Simula&ccedil;&atilde;o</span><span>Proposta</span><span>Link</span>
                </div>
                {jornadas.map((j) => (
                  <div className="template-row" key={j.id} style={{ gridTemplateColumns: '0.9fr 1.2fr 0.9fr 0.9fr 0.8fr 0.7fr', alignItems: 'center', cursor: 'pointer' }}
                       onClick={() => { setCpf(j.cpf); setJor((f) => ({ ...f, nome: j.nome || f.nome, nascimento: j.nascimento || f.nascimento, telefone: j.telefone || f.telefone })); setJorLink(j.link ? { link: j.link, data_expiracao: j.link_expira_em } : null); setJorStatus(j.status_autorizacao ? { status_autorizacao: j.status_autorizacao, observacao: j.status_observacao, expirado: j.status_autorizacao === 'EXPIRADA', autorizado: /^(AUTHORIZED|AUTORIZADO)$/i.test(j.status_autorizacao) } : null) }}>
                    <span>{j.cpf}</span>
                    <span>{j.nome || '—'}{!vendedorFixo && j.vendedor ? <span className="kpi-sub"> &middot; {j.vendedor}</span> : null}</span>
                    <span style={{ color: /^(AUTHORIZED|AUTORIZADO)$/i.test(j.status_autorizacao || '') ? 'var(--green, #7ddc9a)' : j.status_autorizacao === 'EXPIRADA' ? 'var(--red, #e88)' : 'var(--text)' }}>
                      {rotuloStatus(j.status_autorizacao, j.status_autorizacao === 'EXPIRADA')}
                    </span>
                    <span>{j.simulacao?.net_amount != null ? fmtMoeda(Number(j.simulacao.net_amount)) : (j.simulado_em ? 'recusada' : '—')}</span>
                    <span style={{ color: j.proposta_paga ? 'var(--green, #7ddc9a)' : 'var(--text)' }}>{j.proposal_id ? (j.proposta_paga ? 'Paga' : (j.proposta_status || j.proposal_id)) : '—'}</span>
                    <span>{j.link ? <button type="button" className="reset-btn" onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(j.link) }}>copiar</button> : '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* --- resultado por adesao --- */}
        {res?.modo === 'adesao' && (
          <div style={{ marginTop: 12 }}>
            {res.api?.encontrado ? (
              <>
                <p className="kpi-label">{res.api.nome_banco || 'Proposta encontrada'}</p>
                <p className="kpi-value" style={{ color: res.local?.pago ? 'var(--green, #7ddc9a)' : 'var(--text)' }}>
                  {res.api.status_banco || '-'}
                </p>
                <p className="kpi-sub">
                  {res.api.valor_banco != null ? fmtMoeda(Number(res.api.valor_banco)) : '-'}
                  {res.api.parcelas_banco ? ` · ${res.api.parcelas_banco}x` : ''}
                  {res.api.cpf_banco ? ` · CPF ${res.api.cpf_banco}` : ''}
                </p>
                <p className="kpi-sub">
                  tabela no nosso cadastro: {res.local?.tabela_nome || '—'}
                  {res.local?.tabela_id ? ` (${res.local.tabela_id})` : ''}
                </p>
                {res.gravacao && (
                  <p className="kpi-sub">
                    {res.gravacao.ok === false
                      ? `não foi possível atualizar: ${res.gravacao.erro || '?'}`
                      : `cadastro atualizado${res.local?.lancado_em_vendas ? ' · já lançada em vendas' : ''}`}
                  </p>
                )}
              </>
            ) : (
              <p className="state-msg">
                {res.api?.mensagem || 'Proposta não encontrada na API do C6 para essa adesão.'}
              </p>
            )}
          </div>
        )}

        {/* --- resultado por CPF --- */}
        {res?.modo === 'cpf' && (
          <div style={{ marginTop: 12 }}>
            {(res.propostas || []).length === 0 ? (
              <p className="state-msg">
                Nenhuma proposta C6 registrada para esse CPF. Se a venda existe no portal,
                consulte pela ades&atilde;o &mdash; a API do C6 s&oacute; busca por n&uacute;mero de proposta.
              </p>
            ) : (
              <div className="panel table-panel">
                <p className="section-label">Propostas C6 desse CPF ({res.propostas.length})</p>
                <div className="template-row head" style={{ gridTemplateColumns: '1.1fr 1.4fr 0.9fr 0.6fr 0.8fr' }}>
                  <span>Ades&atilde;o</span><span>Tabela</span><span>Valor</span><span>Parc.</span><span>Status</span>
                </div>
                {res.propostas.map(linhaStatus)}
              </div>
            )}
          </div>
        )}

        {erro && <p className="state-msg error" style={{ marginTop: 10 }}>{erro}</p>}
      </div>
    </div>
  )
}

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

function AskIaIcone({ nome }) {
  const p = { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }
  if (nome === 'copiar') return <svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>
  if (nome === 'refazer') return <svg {...p}><path d="M20 11A8 8 0 1 0 18 16" /><path d="M20 5v6h-6" /></svg>
  if (nome === 'limpar') return <svg {...p}><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13" /></svg>
  if (nome === 'minimizar') return <svg {...p}><path d="M6 12h12" /></svg>
  if (nome === 'fechar') return <svg {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>
  if (nome === 'enviar') return <svg {...p} strokeWidth={2}><path d="M12 19V5M6 11l6-6 6 6" /></svg>
  if (nome === 'seta') return <svg {...p}><path d="M6 9l6 6 6-6" /></svg>
  if (nome === 'buscar') return <svg {...p}><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></svg>
  // faísca
  return <svg {...p}><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" /></svg>
}

const ASK_MODOS = [
  { id: 'consulta', label: 'Consulta rápida', sub: 'Respostas tiradas do FAQ oficial dos produtos' },
  { id: 'memoria', label: 'Ensinar a IA', sub: 'Registre uma informação nova para todas as vendedoras' },
  { id: 'treinamento', label: 'Treinamento', sub: 'Pratique e melhore seu atendimento' },
]

function AIChatButton({ vendedor }) {
  const [open, setOpen] = useState(false)
  const [minimizado, setMinimizado] = useState(false)
  const [modo, setModo] = useState('consulta')
  const [menuAberto, setMenuAberto] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [historicoCarregado, setHistoricoCarregado] = useState(false)
  const [carregandoHistorico, setCarregandoHistorico] = useState(false)
  const [copiado, setCopiado] = useState(null)
  const [buscaAberta, setBuscaAberta] = useState(false)
  const [busca, setBusca] = useState('')
  const [memoriaPergunta, setMemoriaPergunta] = useState('')
  const [memoriaResposta, setMemoriaResposta] = useState('')
  const [enviandoMemoria, setEnviandoMemoria] = useState(false)
  const [memoriaMsg, setMemoriaMsg] = useState('')
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const menuRef = useRef(null)

  const modoAtual = ASK_MODOS.find((m) => m.id === modo) || ASK_MODOS[0]

  const irAoFim = () => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }
  useEffect(() => { irAoFim() }, [messages, sending])

  // Reabrir (ou sair do minimizado) volta pro fim, nao pro comeco da conversa.
  useEffect(() => {
    if (!open || minimizado || busca) return
    const t = setTimeout(irAoFim, 0)
    return () => clearTimeout(t)
  }, [open, minimizado, modo, busca, historicoCarregado])

  useEffect(() => {
    if (open && !minimizado && modo === 'consulta') inputRef.current?.focus()
  }, [open, minimizado, modo])

  useEffect(() => {
    function fora(e) { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuAberto(false) }
    document.addEventListener('mousedown', fora)
    return () => document.removeEventListener('mousedown', fora)
  }, [])

  useEffect(() => {
    if (!open || modo !== 'consulta' || historicoCarregado) return
    setCarregandoHistorico(true)
    const url = `${IA_WEBHOOK_URL}?Acao=historico&Vendedora=${encodeURIComponent(vendedor || 'geral')}`
    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        if (data?.ok && Array.isArray(data.mensagens) && data.mensagens.length > 0) setMessages(data.mensagens)
      })
      .catch(() => {})
      .finally(() => { setHistoricoCarregado(true); setCarregandoHistorico(false) })
  }, [open, modo, historicoCarregado, vendedor])

  async function enviarMemoria() {
    const pergunta = memoriaPergunta.trim()
    const resposta = memoriaResposta.trim()
    if (!pergunta || !resposta || enviandoMemoria) return
    setEnviandoMemoria(true); setMemoriaMsg('')
    try {
      const url = `${IA_WEBHOOK_URL}?Acao=memoria&Vendedora=${encodeURIComponent(vendedor || 'geral')}&Pergunta=${encodeURIComponent(pergunta)}&Resposta=${encodeURIComponent(resposta)}`
      const data = await (await fetch(url)).json()
      if (data?.ok) {
        setMemoriaMsg(data.mensagem || 'Informação registrada.')
        setMemoriaPergunta(''); setMemoriaResposta('')
      } else {
        setMemoriaMsg('Não consegui salvar agora. Tente de novo.')
      }
    } catch {
      setMemoriaMsg('Erro ao salvar. Tente de novo.')
    } finally {
      setEnviandoMemoria(false)
    }
  }

  async function perguntar(pergunta, { repetindo = false } = {}) {
    if (!pergunta || sending) return
    if (!repetindo) setMessages((m) => [...m, { role: 'user', text: pergunta }])
    setSending(true)
    try {
      const url = `${IA_WEBHOOK_URL}?Pergunta=${encodeURIComponent(pergunta)}&Vendedora=${encodeURIComponent(vendedor || 'geral')}`
      const data = await (await fetch(url)).json()
      const resposta = data?.resposta || 'Não consegui consultar agora. Tente novamente em instantes.'
      setMessages((m) => [...m, { role: 'ia', text: resposta }])
    } catch {
      setMessages((m) => [...m, { role: 'ia', text: 'Erro ao consultar a IA. Verifique a conexão e tente de novo.' }])
    } finally {
      setSending(false)
    }
  }

  function send() {
    const p = input.trim()
    if (!p) return
    setInput('')
    perguntar(p)
  }

  // refaz a última pergunta, trocando a resposta que estava ali
  function refazer(indice) {
    const anterior = [...messages].slice(0, indice).reverse().find((m) => m.role === 'user')
    if (!anterior || sending) return
    setMessages((m) => m.filter((_, i) => i !== indice))
    perguntar(anterior.text, { repetindo: true })
  }

  async function copiar(texto, i) {
    try {
      await navigator.clipboard.writeText(texto)
      setCopiado(i)
      setTimeout(() => setCopiado((c) => (c === i ? null : c)), 1600)
    } catch { /* navegador bloqueou a área de transferência */ }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  function encerrar() {
    setOpen(false); setMinimizado(false); setMenuAberto(false)
    setBuscaAberta(false); setBusca('')
  }

  const temConversa = messages.length > 0
  const termo = busca.trim().toLowerCase()
  // guarda o indice original: copiar/refazer precisam dele mesmo filtrado
  const visiveis = messages
    .map((m, i) => ({ ...m, _i: i }))
    .filter((m) => !termo || String(m.text).toLowerCase().includes(termo))

  return (
    <>
      <button className="reset-btn ai-trigger-btn" title="Consultar IA" onClick={() => { setOpen(true); setMinimizado(false) }}>
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

      {open && minimizado && (
        <button className="askia-pilula" onClick={() => setMinimizado(false)}>
          <AskIaIcone nome="faisca" />
          {temConversa ? 'Continuar conversa' : 'Abrir a IA'}
        </button>
      )}

      {open && !minimizado && (
        <div className="askia-camada">
          <div className="askia-painel" role="dialog" aria-label="Consulta com a IA">
            <div className="askia-brilho" aria-hidden="true" />

            <header className="askia-topo">
              <div className="askia-modo" ref={menuRef}>
                <button className="askia-modo-btn" onClick={() => setMenuAberto((v) => !v)}>
                  <span className="askia-faisca"><AskIaIcone nome="faisca" /></span>
                  {modoAtual.label}
                  <span className={`askia-chevron ${menuAberto ? 'aberto' : ''}`}><AskIaIcone nome="seta" /></span>
                </button>
                {menuAberto && (
                  <div className="askia-menu">
                    {ASK_MODOS.map((m) => (
                      <button key={m.id} className={`askia-menu-item ${m.id === modo ? 'on' : ''}`}
                              onClick={() => { setModo(m.id); setMenuAberto(false); setMemoriaMsg('') }}>
                        <strong>{m.label}</strong>
                        <small>{m.sub}</small>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="askia-acoes">
                {modo === 'consulta' && temConversa && (
                  <button className={`askia-icone ${buscaAberta ? 'on' : ''}`} title="Buscar na conversa"
                          onClick={() => { setBuscaAberta((v) => !v); setBusca('') }}>
                    <AskIaIcone nome="buscar" />
                  </button>
                )}
                {modo === 'consulta' && temConversa && (
                  <button className="askia-icone" title="Limpar conversa" onClick={() => setMessages([])}>
                    <AskIaIcone nome="limpar" />
                  </button>
                )}
                <button className="askia-icone" title="Minimizar" onClick={() => setMinimizado(true)}>
                  <AskIaIcone nome="minimizar" />
                </button>
                <button className="askia-icone askia-icone-sair" title="Encerrar" onClick={encerrar}>
                  <AskIaIcone nome="fechar" />
                </button>
              </div>
            </header>

            {modo === 'consulta' && (
              <>
                {buscaAberta && (
                  <div className="askia-busca">
                    <AskIaIcone nome="buscar" />
                    <input autoFocus value={busca} onChange={(e) => setBusca(e.target.value)}
                           placeholder="Buscar algo já respondido nesta conversa" />
                    {termo && <span className="askia-busca-contagem">{visiveis.length} de {messages.length}</span>}
                    <button className="askia-icone" title="Fechar busca"
                            onClick={() => { setBuscaAberta(false); setBusca('') }}>
                      <AskIaIcone nome="fechar" />
                    </button>
                  </div>
                )}

                <div className="askia-mensagens" ref={listRef}>
                  {termo && visiveis.length === 0 && (
                    <p className="askia-aviso">Nada nesta conversa fala sobre &ldquo;{busca.trim()}&rdquo;.</p>
                  )}
                  {carregandoHistorico && <p className="askia-aviso">Carregando a conversa anterior...</p>}
                  {!carregandoHistorico && !temConversa && (
                    <div className="askia-boas-vindas">
                      <p className="askia-ola">Oi{vendedor ? `, ${String(vendedor).split(/[ .]/)[0]}` : ''}. Pergunte o que precisar sobre os produtos.</p>
                      <p className="askia-sugestao-titulo">Por exemplo:</p>
                      <div className="askia-sugestoes">
                        {['Cliente negativado pode contratar o CLT?',
                          'Qual o prazo de pagamento do FGTS?',
                          'Quais bancos aceitam cliente autônomo?'].map((s) => (
                          <button key={s} className="askia-sugestao" onClick={() => perguntar(s)}>{s}</button>
                        ))}
                      </div>
                    </div>
                  )}

                  {visiveis.map((m) => (
                    m.role === 'user' ? (
                      <div key={m._i} className="askia-user">{m.text}</div>
                    ) : (
                      <div key={m._i} className="askia-ia">
                        <div className="askia-ia-texto">{m.text}</div>
                        <div className="askia-ia-acoes">
                          <button className="askia-icone" title="Copiar resposta" onClick={() => copiar(m.text, m._i)}>
                            <AskIaIcone nome="copiar" />
                          </button>
                          <button className="askia-icone" title="Perguntar de novo" onClick={() => refazer(m._i)} disabled={sending || !!termo}>
                            <AskIaIcone nome="refazer" />
                          </button>
                          {copiado === m._i && <span className="askia-copiado">Copiado</span>}
                        </div>
                      </div>
                    )
                  ))}

                  {sending && (
                    <div className="askia-ia">
                      <div className="askia-digitando"><i /><i /><i /></div>
                    </div>
                  )}
                </div>

                <div className="askia-barra">
                  <textarea
                    ref={inputRef}
                    className="askia-input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Escreva sua dúvida..."
                    rows={1}
                  />
                  <button className="askia-enviar" onClick={send} disabled={sending || !input.trim()} title="Enviar">
                    <AskIaIcone nome="enviar" />
                  </button>
                </div>
              </>
            )}

            {modo === 'memoria' && (
              <div className="askia-mensagens">
                <p className="askia-aviso askia-aviso-alinhado">
                  O que você registrar aqui vale para todas as vendedoras. Separe a situação da resposta — assim a IA acha
                  mais fácil quando for relevante.
                </p>
                <div className="chip-campo">
                  <label>Pergunta ou situação</label>
                  <input className="chip-input" value={memoriaPergunta} onChange={(e) => setMemoriaPergunta(e.target.value)}
                         placeholder='Ex: "Cliente autônomo pode contratar o Empréstimo na Conta de Luz?"' />
                </div>
                <div className="chip-campo">
                  <label>Resposta</label>
                  <textarea className="chip-input" rows={5} value={memoriaResposta} onChange={(e) => setMemoriaResposta(e.target.value)}
                            placeholder="Explique a resposta certa. Se a regra vale pra geral, evite deixar específica de um banco só." />
                </div>
                {memoriaMsg && <p className="askia-ok">{memoriaMsg}</p>}
                <button className="chip-salvar" style={{ alignSelf: 'flex-start' }}
                        onClick={enviarMemoria}
                        disabled={enviandoMemoria || !memoriaPergunta.trim() || !memoriaResposta.trim()}>
                  {enviandoMemoria ? 'Salvando...' : 'Ensinar a IA'}
                </button>
              </div>
            )}

            {modo === 'treinamento' && <TreinamentoPainel vendedor={vendedor} />}
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
  const [metasV2, setMetasV2] = useState(null)
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
  const [showPan, setShowPan] = useState(false)
  const [showC6, setShowC6] = useState(false)
  const [showSomaJornada, setShowSomaJornada] = useState(false)
  const [showPresenca, setShowPresenca] = useState(false)
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
      const [kv, mt, sm, tab, mv] = await Promise.all([
        callApi('vendedoras_kpis_vendedor', { vendedor, date_from, date_to }),
        callApi('vendedoras_meta', { vendedor }),
        callApi('vendedoras_semanas_mes', { vendedor }),
        callApi('vendedoras_tabela', { vendedor, date_from, date_to, limit: String(limit), offset: String(offset) }),
        callApi('metas_v2', { vendedor }),
      ])
      setKpis(kv?.[0] ?? null)
      setMeta(mt?.[0] ?? null)
      setMetasV2(mv?.[0] ?? null)
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
          <button className="refresh-btn" onClick={() => setShowPan(true)} title="PAN: consulta por CPF ou adesão, acompanhamento e cadastro de proposta">
            PAN
          </button>
          <button className="refresh-btn" onClick={() => setShowC6(true)} title="C6: consulta de proposta por adesão (API do banco) ou por CPF (propostas já registradas)">
            C6
          </button>
          <button className="refresh-btn" onClick={() => setShowSomaJornada(true)} title="Soma: consulta de margem, simula&ccedil;&atilde;o e cadastro de proposta">
            Soma
          </button>
          <button className="refresh-btn" onClick={() => setShowPresenca(true)} title="Presença: esteira de pendências, documentos e reapresentação de pagamento">
            Presença
          </button>
          <button ref={tourFactaRef} className="refresh-btn" onClick={() => setShowFacta(true)} title="Consultar proposta na Facta por CPF ou c&oacute;digo AF">
            Consulta Facta
          </button>
          <button className="refresh-btn" onClick={() => load({ forcar: true })} disabled={loading} title="Atualizar agora">
            &#8635; Atualizar
          </button>
        </div>
      </div>

      <DateRangeFilter dataInicio={dataInicio} setDataInicio={setDataInicio} dataFim={dataFim} setDataFim={setDataFim} />

      {error && <div className="state-msg error">Erro: {error}</div>}

      <MetaColetiva dados={metasV2} />

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
        <div className="kpi"><p className="kpi-label">Maior {modo === 'ponto' ? 'pontuação' : 'venda'}</p><p className="kpi-value">{fmtV(modo === 'ponto' ? kpis?.maior_pontuacao : kpis?.maior_venda)}</p></div>
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
      {showPan && <PanModal vendedorFixo={vendedor} onClose={() => setShowPan(false)} />}
      {showC6 && <C6Modal vendedorFixo={vendedor} onClose={() => setShowC6(false)} />}
      {showSomaJornada && <ErroNaTela onClose={() => setShowSomaJornada(false)}><SomaJornadaModal vendedorFixo={vendedor} onClose={() => setShowSomaJornada(false)} /></ErroNaTela>}
      {showPresenca && <PresencaEsteiraModal vendedor={vendedor} modo="vendedora" onClose={() => setShowPresenca(false)} />}
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
  const revisaoCache = useRevisaoCache()
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
  const [showPan, setShowPan] = useState(false)
  const [showC6, setShowC6] = useState(false)
  const [showSomaJornada, setShowSomaJornada] = useState(false)
  const [showPresenca, setShowPresenca] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const fileInputRef = useRef(null)

  const [modo, setModo] = useState('valor') // 'valor' | 'ponto'
  const fmtV = modo === 'ponto' ? ((v) => `${fmtInt(Math.round(v ?? 0))} pts`) : fmtMoeda

  const [showMetaConfig, setShowMetaConfig] = useState(false)
  const [metas, setMetas] = useState(null)
  const [metasV2, setMetasV2] = useState(null)
  useEffect(() => {
    callApi('metas_v2', { vendedor: '' })
      .then((r) => setMetasV2(r?.[0] ?? null))
      .catch(() => setMetasV2(null))
  }, [])
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
  }, [page, revisaoCache])

  const load = useCallback(async (opts) => {
    setLoading(true)
    setError(null)
    // data_status é uma coluna "date" pura, sem hora/fuso — manda o texto
    // exatamente como está no campo (AAAA-MM-DD), sem converter pra ISO/UTC
    const date_from = dataInicio || ''
    const date_to = dataFim || ''
    try {
      const [dia, tab, medias] = await Promise.all([
        callApi('vendedoras_por_dia', { vendedor: vendedorLista, date_from, date_to, banco }, opts),
        callApi('vendedoras_tabela', { vendedor, date_from, date_to, limit: String(limit), offset: String(offset) }, opts),
        callApi('vendedoras_medias_geral', {}, opts),
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
        // total do dia (o que a pilha inteira soma), pro rotulo fixo do gráfico
        porDiaMap[row.dia].__total = (porDiaMap[row.dia].__total || 0) + total
        porDiaMap[row.dia].__totalVendas = (porDiaMap[row.dia].__totalVendas || 0) + Number(row.vendas)
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
          callApi('vendedoras_kpis_vendedor', { vendedor, date_from, date_to }, opts),
          callApi('vendedoras_meta', { vendedor }, opts),
        ])
        setKpisVendedor(kv?.[0] ?? null)
        setMetaVendedor(mv?.[0] ?? null)
        setKpisGeral(null)
      } else {
        const kg = await callApi('vendedoras_kpis_geral', { date_from, date_to, banco }, opts)
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
  }, [vendedor, vendedorLista, banco, dataInicio, dataFim, limit, offset, modo, revisaoCache])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  const handleSync = async () => {
    setSyncing(true)
    setSyncMsg('')
    try {
      const r = await callApi('vendedoras_sync', {}, { forcar: true })
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
          <button className="refresh-btn" onClick={() => setShowPan(true)} title="PAN: consulta por CPF ou adesão, acompanhamento e cadastro de proposta">
            PAN
          </button>
          <button className="refresh-btn" onClick={() => setShowC6(true)} title="C6: consulta de proposta por adesão (API do banco) ou por CPF (propostas já registradas)">
            C6
          </button>
          <button className="refresh-btn" onClick={() => setShowSomaJornada(true)} title="Soma: consulta de margem, simula&ccedil;&atilde;o e cadastro de proposta">
            Soma
          </button>
          <button className="refresh-btn" onClick={() => setShowPresenca(true)} title="Presença: esteira de pendências, documentos e reapresentação de pagamento">
            Presença
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
        <MetaColetiva dados={metasV2} />

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
              labelStyle={{ color: '#8a978f', marginBottom: 6 }}
              itemSorter={(it) => -Number(it.value ?? 0)}
              formatter={(value, name, item) => {
                const vendas = item?.payload?.[`${name}__vendas`]
                const outro = modo === 'ponto' ? item?.payload?.[`${name}__valor`] : item?.payload?.[`${name}__pontos`]
                const outroLabel = modo === 'ponto' ? fmtMoeda(outro) : `${fmtInt(Math.round(outro ?? 0))} pts`
                const valorFmt = modo === 'ponto' ? `${fmtInt(value)} pts` : fmtMoeda(value)
                return [`${valorFmt}${vendas != null ? ` · ${fmtInt(vendas)} vendas` : ''}${outro != null ? ` · ${outroLabel}` : ''}`, name]
              }}
              wrapperStyle={{ outline: 'none' }}
              // o cabecalho do tooltip mostra o TOTAL do dia somando as barras
              labelFormatter={(dia, payload) => {
                if (!payload?.length) return fmtDataBR(dia)
                const soma = (suf) => payload.reduce((t, x) => t + Number(x?.payload?.[`${x.name}${suf}`] ?? 0), 0)
                const total = modo === 'ponto'
                  ? `${fmtInt(Math.round(soma('__pontos')))} pts`
                  : fmtMoeda(soma('__valor'))
                return `${fmtDataBR(dia)} — total do dia: ${total} · ${fmtInt(soma('__vendas'))} vendas`
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'IBM Plex Mono' }} />
            {porDia.vendedoresVistos.map((v, i) => (
              <Bar key={v} dataKey={v} stackId="a" fill={VENDEDOR_CORES[i % VENDEDOR_CORES.length]}>
                {/* rotulo do TOTAL do dia so na ultima barra da pilha, pra
                    aparecer sempre e nao so ao passar o mouse */}
                {i === porDia.vendedoresVistos.length - 1 && (
                  <LabelList
                    dataKey="__total"
                    position="top"
                    style={{ fill: '#8a978f', fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                    formatter={(v) => (modo === 'ponto' ? `${fmtInt(Math.round(v || 0))} pts` : fmtMoeda(v || 0))}
                  />
                )}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      {!vendedor && (
        <div className="kpi-grid">
          <div className="kpi"><p className="kpi-label">Vendedora com mais vendas</p><p className="kpi-value" style={{ fontSize: 16 }}>{kpisGeral?.top_qtd_vendedor || '-'}</p><p className="kpi-sub">{fmtInt(kpisGeral?.top_qtd_valor)} vendas</p></div>
          <div className="kpi"><p className="kpi-label">Vendedora com maior {modo === 'ponto' ? 'pontuação' : 'valor'}</p><p className="kpi-value" style={{ fontSize: 16 }}>{(modo === 'ponto' ? kpisGeral?.top_ponto_vendedor : kpisGeral?.top_valor_vendedor) || '-'}</p><p className="kpi-sub">{fmtV(modo === 'ponto' ? kpisGeral?.top_ponto_valor : kpisGeral?.top_valor_valor)}</p></div>
          <div className="kpi"><p className="kpi-label">Banco mais utilizado</p><p className="kpi-value" style={{ fontSize: 16 }}>{kpisGeral?.banco_top || '-'}</p><p className="kpi-sub">{fmtInt(kpisGeral?.banco_top_qtd)} vendas</p></div>
          <div className="kpi"><p className="kpi-label">Dia com maior {modo === 'ponto' ? 'pontuação' : 'valor'}</p><p className="kpi-value" style={{ fontSize: 16 }}>{(modo === 'ponto' ? kpisGeral?.dia_maior_ponto : kpisGeral?.dia_maior_valor) ? fmtDataBR(modo === 'ponto' ? kpisGeral.dia_maior_ponto : kpisGeral.dia_maior_valor) : '-'}</p><p className="kpi-sub">{fmtV(modo === 'ponto' ? kpisGeral?.dia_maior_ponto_total : kpisGeral?.dia_maior_valor_total)}</p></div>
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
          <div className="kpi"><p className="kpi-label">Maior {modo === 'ponto' ? 'pontuação' : 'venda'}</p><p className="kpi-value">{fmtV(modo === 'ponto' ? kpisVendedor?.maior_pontuacao : kpisVendedor?.maior_venda)}</p></div>
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
          onAdded={async () => { await callApi('vendedoras_sync', {}, { forcar: true }); await load() }}
        />
      )}
      {showNovoSaque && <NovoSaqueModal onClose={() => setShowNovoSaque(false)} />}
      {showPan && <PanModal onClose={() => setShowPan(false)} />}
      {showC6 && <C6Modal vendedoresDisponiveis={vendedores} onClose={() => setShowC6(false)} />}
      {showSomaJornada && <ErroNaTela onClose={() => setShowSomaJornada(false)}><SomaJornadaModal onClose={() => setShowSomaJornada(false)} /></ErroNaTela>}
      {showPresenca && <PresencaEsteiraModal vendedor={null} modo="geral" onClose={() => setShowPresenca(false)} />}

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
  const revisaoCache = useRevisaoCache()
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

  const load = useCallback(async (opts) => {
    setLoading(true)
    setError(null)
    try {
      const [kp, pp, dm, pc, po] = await Promise.all([
        callApi('vendas_kpis', { date_from: dataInicio, date_to: dataFim, produto, banco }, opts),
        callApi('vendas_por_produto', { date_from: dataInicio, date_to: dataFim }, opts),
        callApi('vendas_dias_mes', { produto, banco }, opts),
        callApi('vendas_por_campanha', { date_from: dataInicio, date_to: dataFim, produto, banco }, opts),
        callApi('vendas_por_origem', { date_from: dataInicio, date_to: dataFim, produto, banco }, opts),
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
  }, [dataInicio, dataFim, produto, banco, revisaoCache])

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
      const r = await callApi('vendas_sync', {}, { forcar: true })
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

  const ajusteInputRef = useRef(null)
  const [ajuste, setAjuste] = useState(null)          // { rows, previa }
  const [ajustando, setAjustando] = useState(false)

  // Importacao: le o relatorio cru (v8, C6, Novo Saque, Soma, Presenca ou
  // planilha do VendeAI), simula na RPC v3 e mostra a previa antes de gravar.
  // So grava quando a pessoa confirmar no modal.
  const handleAjusteFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setAjustando(true); setImportMsg('')
    try {
      const rows = await parseArquivoCru(file)
      if (!rows.length) { setImportMsg('Nenhuma linha encontrada no arquivo.'); return }
      const previa = await postApi('vendas_import_v3', { rows, aplicar: false })
      if (previa?.error) { setImportMsg(previa.error); return }
      setAjuste({ rows, previa })
    } catch (err) {
      setImportMsg('Erro ao ler o arquivo: ' + (err.message || ''))
    } finally {
      setAjustando(false)
    }
  }

  const aplicarAjuste = async () => {
    if (!ajuste) return
    setAjustando(true)
    try {
      const r = await postApi('vendas_import_v3', { rows: ajuste.rows, aplicar: true })
      if (r?.error) { setImportMsg(r.error); return }
      const rs = r.resumo || {}
      setImportMsg(`Importação aplicada — ${fmtInt(rs.atualizar)} atualizadas, ${fmtInt(rs.inserir)} inseridas, ${fmtInt(rs.ja_correto)} já corretas, ${fmtInt(rs.rejeitado)} rejeitadas, ${fmtInt(rs.ignorado)} ignoradas (banco sem importação).`)
      setAjuste(null)
      await handleSync()
    } catch (err) {
      setImportMsg('Erro ao aplicar: ' + (err.message || ''))
    } finally {
      setAjustando(false)
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
          <input type="file" accept=".csv,.xlsx,.xls" ref={ajusteInputRef} onChange={handleAjusteFile} style={{ display: 'none' }} />
          <button className="refresh-btn" onClick={() => ajusteInputRef.current?.click()} disabled={ajustando} title="Importar relatório de qualquer banco (v8, C6, Novo Saque, Soma, Presença) ou a planilha do VendeAI. Mostra a prévia linha a linha antes de gravar.">
            {ajustando ? 'Lendo...' : '↑ Importação'}
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
          <button className="refresh-btn" onClick={() => load({ forcar: true })} disabled={loading} title="Atualizar agora">
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

      <div className="kpi-grid kpi-grid-produtos">
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
      {ajuste && (
        <div className="funil-overlay" onClick={() => setAjuste(null)}>
          <div className="funil-panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 980 }}>
            <div className="funil-header">
              <div><h2>Importa&ccedil;&atilde;o &mdash; pr&eacute;via</h2></div>
              <button className="funil-close" onClick={() => setAjuste(null)}>&times;</button>
            </div>
            <p className="kpi-sub" style={{ marginBottom: 10 }}>
              {ajuste.previa.total} linhas lidas &middot;{' '}
              <b style={{ color: 'var(--green, #7ddc9a)' }}>{fmtInt(ajuste.previa.resumo?.atualizar)} a atualizar</b> &middot;{' '}
              {fmtInt(ajuste.previa.resumo?.inserir)} a inserir &middot;{' '}
              {fmtInt(ajuste.previa.resumo?.ja_correto)} j&aacute; corretas &middot;{' '}
              <span style={{ color: '#e08585' }}>{fmtInt(ajuste.previa.resumo?.rejeitado)} rejeitadas</span> &middot;{' '}
              {fmtInt(ajuste.previa.resumo?.ignorado)} ignoradas (banco sem importação)
            </p>
            <div className="panel table-panel" style={{ maxHeight: 420, overflowY: 'auto' }}>
              <div className="template-row head" style={{ gridTemplateColumns: '0.5fr 0.6fr 0.9fr 1.6fr 1.6fr 1.6fr' }}>
                <div>#</div><div>Banco</div><div>A&ccedil;&atilde;o</div><div>Antes</div><div>Depois</div><div>Motivo</div>
              </div>
              {(ajuste.previa.linhas || []).filter((x) => x.acao !== 'ja_correto' && x.acao !== 'ignorado').map((x) => (
                <div className="template-row" key={x.linha} style={{ gridTemplateColumns: '0.5fr 0.6fr 0.9fr 1.6fr 1.6fr 1.6fr', fontSize: 12 }}>
                  <div>{x.linha}</div>
                  <div>{String(x.banco || '').toUpperCase()}</div>
                  <div style={{ color: x.acao === 'rejeitado' ? '#e08585' : x.acao === 'atualizar' ? 'var(--green, #7ddc9a)' : 'var(--text)' }}>{x.acao}</div>
                  <div style={{ opacity: 0.75 }}>{x.antes || '-'}</div>
                  <div>{x.depois || '-'}</div>
                  <div style={{ opacity: 0.75 }}>{x.motivo}</div>
                </div>
              ))}
            </div>
            <p className="kpi-sub" style={{ marginTop: 8 }}>Linhas j&aacute; corretas e de outros bancos ficam ocultas na pr&eacute;via.</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="refresh-btn" onClick={aplicarAjuste} disabled={ajustando || !((ajuste.previa.resumo?.atualizar || 0) + (ajuste.previa.resumo?.inserir || 0))}>
                {ajustando ? 'Aplicando...' : `Aplicar ${fmtInt((ajuste.previa.resumo?.atualizar || 0) + (ajuste.previa.resumo?.inserir || 0))} alterações`}
              </button>
              <button className="reset-btn" onClick={() => setAjuste(null)} disabled={ajustando}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
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
  const revisaoCache = useRevisaoCache()
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
  // Abre sempre no mes corrente: sem filtro de data a consulta varria
  // 1M de linhas de disparochat a cada entrada na view.
  const mesAtual = presetRange('este_mes')
  const [dataInicio, setDataInicio] = useState(mesAtual.from)
  const [dataFim, setDataFim] = useState(mesAtual.to)
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

  const loadDados = useCallback(async (opts) => {
    setLoading(true)
    setError(null)
    try {
      const [kpiData, enviosData, campanhasData, conversaData, metaData, mensagemData] = await Promise.all([
        callApi('kpis', apiArgsBase, opts),
        callApi('envios', apiArgsBase, opts),
        callApi('campanhas', {
          campanha: apiArgsBase.campanha,
          origem: apiArgsBase.origem,
          meta: apiArgsBase.meta,
          tipo_envio: apiArgsBase.tipo_envio,
          mensagem: apiArgsBase.mensagem,
          date_from: apiArgsBase.date_from,
          date_to: apiArgsBase.date_to,
        }, opts),
        callApi('por_conversa', apiArgsBase, opts),
        callApi('por_meta', apiArgsBase, opts),
        callApi('por_mensagem', apiArgsBase, opts),
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
  }, [apiArgsBase, revisaoCache])

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
          <button className="reset-btn" onClick={() => { setCampanhaSel([]); setOrigemSel([]); setMetaSel([]); setTipoEnvioSel([]); setMensagemFiltroSel([]); setDataInicio(mesAtual.from); setDataFim(mesAtual.to); setHoraInicio(''); setHoraFim('') }} title="Redefinir filtros">
            &#10226; Redefinir filtros
          </button>
          <button className="refresh-btn" onClick={handleDownload} title="Baixar relat&oacute;rio filtrado em CSV">
            &#8595; Baixar
          </button>
          <button className="refresh-btn" onClick={() => loadDados({ forcar: true })} disabled={loading} title="Atualizar agora">
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

      <div className="kpi-grid kpi-grid-4">
        <div className="kpi"><p className="kpi-label">Total Leads</p><p className="kpi-value">{fmtInt(kpis?.total_leads)}</p></div>
        <div className="kpi"><p className="kpi-label">Intera&ccedil;&atilde;o %</p><p className="kpi-value">{fmtPct(kpis?.interacao_pct)}</p></div>
        <div className="kpi"><p className="kpi-label">Intera&ccedil;&atilde;o (qtd)</p><p className="kpi-value">{fmtInt(kpis?.interacao_qtd)}</p></div>
        <div className="kpi"><p className="kpi-label">Convers&atilde;o</p><p className="kpi-value accent">{fmtPct(kpis?.conversao_pct)}</p></div>
        <div className="kpi"><p className="kpi-label">Pagas</p><p className="kpi-value">{fmtInt(kpis?.pagas)}</p></div>
        <div className="kpi"><p className="kpi-label">Valor Pago</p><p className="kpi-value">{fmtMoney(kpis?.valor_pago)}</p></div>
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

// Views que aparecem como atalho na tela Geral (a própria Geral fica de fora)
const VIEWS_ATALHO = VIEWS.filter((v) => v.id !== 'inicio')

function Dashboard() {
  // Na primeira visita cai na Geral; depois disso a sessão lembra onde parou.
  const [view, setView] = useState(() => {
    try {
      const salvo = localStorage.getItem(VIEW_STORAGE_KEY)
      if (!salvo) return 'inicio'
      // 'geral' era o id antigo do dashboard de Disparos
      return salvo === 'geral' ? 'disparos' : salvo
    } catch {
      return 'inicio'
    }
  })

  const changeView = (v) => {
    setView(v)
    try { localStorage.setItem(VIEW_STORAGE_KEY, v) } catch { /* ignora */ }
  }

  const acoesVendedoras = (
    <>
      <RefinButton vendedor={null} modo="gestao" />
      <ArquivosButton dono={null} />
      <PlaybookMenuButton />
      <AIChatButton vendedor={undefined} />
    </>
  )

  return (
    <div className="app">
      <div className="app-header">
        <img src="/tiger-icon.png" alt="" className="app-logo" />
        {view !== 'inicio' && (
          <button className="voltar-inicio" onClick={() => changeView('inicio')} title="Voltar para a tela Geral">
            <span aria-hidden="true">&#8962;</span> Início
          </button>
        )}
        <ViewSwitcher view={view} setView={changeView} />
        {view === 'vendedoras' && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {acoesVendedoras}
          </div>
        )}
      </div>
      {view === 'inicio' && (
        <VisaoInicial
          views={VIEWS_ATALHO}
          onIrPara={changeView}
          onAbrirTrello={() => changeView('trello')}
          onAbrirChips={() => changeView('chips')}
        />
      )}
      {view === 'disparos' && <VisaoGeral />}
      {view === 'leilao' && <LeilaoDetalhado />}
      {view === 'produtos' && <EntradasLP />}
      {view === 'n8n' && <N8nExecucoes />}
      {view === 'vendedoras' && <VendedorasView />}
      {view === 'vendas' && <VendasView />}
      {view === 'ia' && <IATreinamento />}
      {view === 'trello' && <Trello onVoltar={() => changeView('inicio')} />}
      {view === 'chips' && <Chips onVoltar={() => changeView('inicio')} />}
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
