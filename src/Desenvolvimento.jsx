import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, ReferenceLine, CartesianGrid,
} from 'recharts'
import './Desenvolvimento.css'

// Desenvolvimento (15/10): programa de treinamentos fora da mesa (13 encontros, 19/10/2026 a 22/01/2027).
// Quem anota (Rodrigo ou RH) lança, durante o encontro, as notas de cada vendedora; daqui saem os
// gráficos por pessoa (cruzados com a qualidade dos atendimentos em crm_qualidade) e por formato.
// Dados: RPCs dashboard_dev_* (leitura) e dev_salvar_* (gravação) no Supabase. Só o perfil geral vê.

async function getJson(type, params = {}) {
  const qs = new URLSearchParams({ type, ...params })
  const r = await fetch(`/api/dashboard?${qs}`)
  const d = await r.json()
  if (!r.ok) throw new Error(d?.error || 'falha ao carregar')
  return d
}
async function post(type, body) {
  const r = await fetch(`/api/dashboard?type=${type}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const d = await r.json()
  if (!r.ok) throw new Error(d?.error || 'falha')
  if (d && d.ok === false) throw new Error(d.erro || 'não salvou')
  return d
}

const hojeSP = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)
const dt = (s) => new Date(`${String(s).slice(0, 10)}T12:00:00`)
const fmtData = (s) => (s ? dt(s).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '—')
const fmtDiaSemana = (s) => (s ? dt(s).toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '') : '')
const pct = (x) => (x == null ? '—' : `${Math.round(Number(x) * 100)}%`)
const num = (x, casas = 1) => (x == null ? '—' : Number(x).toFixed(casas).replace('.', ','))

const COMPETENCIAS = [
  ['confianca', 'Confiança'], ['calma_foco', 'Calma e foco'], ['escuta', 'Escuta'],
  ['clareza', 'Clareza'], ['criatividade', 'Criatividade'], ['iniciativa', 'Iniciativa'],
]
// paleta categórica validada no fundo escuro do dash (ordem fixa: a cor segue a competência)
const COR_COMP = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300']
const TEATRO_CRITERIOS = [
  ['escutou', 'Escutou'], ['objecao_real', 'Objeção real'], ['solucao', 'Solução'],
  ['proximo_passo', 'Próximo passo'], ['postura', 'Postura'],
]
const FASES = [
  ['destravar', 'Destravar', 'Semanas 1–4: confiança, timidez e medo de errar'],
  ['converter', 'Converter', 'Semanas 5–9: objeção, solução e fechamento'],
  ['evoluir', 'Evoluir', 'Semanas 10–13: autonomia e veteranos como mestres'],
]
const STATUS = [['planejado', 'Planejado'], ['feito', 'Feito'], ['adiado', 'Adiado'], ['cancelado', 'Cancelado']]
const NOME_STATUS = Object.fromEntries(STATUS)
const PESSOAS_ANOTACAO = ['Rodrigo', 'RH', 'Apoio']
const MARCOS = [['D30', '2026-11-18', 'Fim do Destravar'], ['D60', '2026-12-18', 'Fim do Converter'], ['D90', '2027-01-22', 'Encerramento']]
const TOOLTIP_STYLE = { background: '#1b2620', border: '1px solid #263029', borderRadius: 8, fontFamily: 'IBM Plex Mono', fontSize: 12 }

const ANOTADOR_KEY = 'dv_anotador'
const lerAnotador = () => { try { return localStorage.getItem(ANOTADOR_KEY) || '' } catch { return '' } }
const gravarAnotador = (v) => { try { localStorage.setItem(ANOTADOR_KEY, v || '') } catch { /* ignora */ } }

const nomeCurto = (n) => {
  const s = String(n || '').replace(/[._]/g, ' ').trim()
  const p = s.split(/\s+/)[0] || s
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
}
const descEncontro = (e) => [
  e.formato_nome, e.nivel ? `nível ${e.nivel}` : null, e.turma ? `turma ${e.turma}` : null,
].filter(Boolean).join(' · ')

// ---------------------------------------------------------------- controles pequenos
function Segmentado({ opcoes, valor, onChange, rotulo }) {
  return (
    <div className="dv-seg" role="group" aria-label={rotulo}>
      {opcoes.map(([v, l]) => (
        <button key={String(v)} type="button" className={`dv-seg-op ${valor === v ? 'on' : ''}`}
                aria-pressed={valor === v} onClick={() => onChange(valor === v ? undefined : v)}>{l}</button>
      ))}
    </div>
  )
}

function Nota15({ valor, onChange, rotulo }) {
  return (
    <div className="dv-nota" role="group" aria-label={rotulo}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" className={`dv-nota-b ${valor === n ? 'on' : ''} ${valor && n <= valor ? 'ate' : ''}`}
                aria-pressed={valor === n} onClick={() => onChange(valor === n ? undefined : n)}>{n}</button>
      ))}
    </div>
  )
}

function Contador({ valor, onChange, rotulo }) {
  const v = Number.isFinite(Number(valor)) && valor !== undefined && valor !== null ? Number(valor) : null
  return (
    <div className="dv-cont">
      <span className="dv-cont-rot">{rotulo}</span>
      <div className="dv-cont-ctrl">
        <button type="button" onClick={() => onChange(Math.max(0, (v ?? 0) - 1))} aria-label={`menos ${rotulo}`}>−</button>
        <span className="dv-cont-v">{v ?? '—'}</span>
        <button type="button" onClick={() => onChange((v ?? 0) + 1)} aria-label={`mais ${rotulo}`}>+</button>
      </div>
    </div>
  )
}

const SIM_NAO = [[true, 'Sim'], [false, 'Não']]

function Campo({ rotulo, children }) {
  return <div className="dv-campo"><span className="dv-campo-rot">{rotulo}</span>{children}</div>
}

// ---------------------------------------------------------------- bloco específico do formato
function deltaTeatro(esp) {
  const ds = TEATRO_CRITERIOS.map(([k]) => {
    const a = esp?.ida?.[k]; const b = esp?.refaz?.[k]
    return a != null && b != null ? b - a : null
  }).filter((x) => x != null)
  return ds.length ? ds.reduce((s, x) => s + x, 0) / ds.length : null
}

function Especificos({ formato, esp, set }) {
  const muda = (k, v) => {
    const novo = { ...esp }
    if (v === undefined || v === '' || v === null) delete novo[k]; else novo[k] = v
    set(novo)
  }
  const texto = (k, ph) => (
    <input type="text" className="dv-input" value={esp[k] || ''} placeholder={ph} onChange={(e) => muda(k, e.target.value)} />
  )
  switch (formato) {
    case 'teatro': {
      const mudaTeatro = (lado, k, v) => {
        const parte = { ...(esp[lado] || {}) }
        if (v === undefined) delete parte[k]; else parte[k] = v
        muda(lado, parte)
      }
      const d = deltaTeatro(esp)
      return (
        <div className="dv-esp">
          <Campo rotulo="Card do cliente">
            <select className="dv-input dv-select-curto" value={esp.card ?? ''} onChange={(e) => muda('card', e.target.value ? Number(e.target.value) : undefined)}>
              <option value="">—</option>
              {Array.from({ length: 15 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>Card {n}</option>)}
            </select>
          </Campo>
          <div className="dv-teatro">
            <div className="dv-teatro-cab"><span /><span>Ida</span><span>Refaz</span></div>
            {TEATRO_CRITERIOS.map(([k, l]) => (
              <div key={k} className="dv-teatro-lin">
                <span className="dv-teatro-rot">{l}</span>
                <Nota15 rotulo={`${l} ida`} valor={esp.ida?.[k]} onChange={(v) => mudaTeatro('ida', k, v)} />
                <Nota15 rotulo={`${l} refaz`} valor={esp.refaz?.[k]} onChange={(v) => mudaTeatro('refaz', k, v)} />
              </div>
            ))}
          </div>
          <p className={`dv-delta ${d == null ? '' : d > 0 ? 'sobe' : d < 0 ? 'cai' : ''}`}>
            Evolução ida → refaz: {d == null ? 'preencha ida e refaz no mesmo critério' : `${d > 0 ? '+' : ''}${num(d, 1)} ponto${Math.abs(d) === 1 ? '' : 's'} em média`}
          </p>
        </div>
      )
    }
    case 'palco':
      return (
        <div className="dv-esp">
          <Campo rotulo="Exposição"><Segmentado rotulo="Exposição" opcoes={[['grupo', 'Grupo'], ['dupla', 'Dupla'], ['solo', 'Solo']]} valor={esp.exposicao} onChange={(v) => muda('exposicao', v)} /></Campo>
          <Campo rotulo="Travou?"><Segmentado rotulo="Travou" opcoes={SIM_NAO} valor={esp.travou} onChange={(v) => muda('travou', v)} /></Campo>
          <Campo rotulo="Recuperou?"><Segmentado rotulo="Recuperou" opcoes={SIM_NAO} valor={esp.recuperou} onChange={(v) => muda('recuperou', v)} /></Campo>
        </div>
      )
    case 'pele':
      return (
        <div className="dv-esp">
          <Campo rotulo="Plaquinha"><Segmentado rotulo="Plaquinha" opcoes={[['confiaria', 'Confiaria'], ['talvez', 'Talvez'], ['bloquearia', 'Bloquearia']]} valor={esp.plaquinha} onChange={(v) => muda('plaquinha', v)} /></Campo>
          <Campo rotulo="Momento em que desistiria">{texto('momento_desistencia', 'ex.: quando pediu o documento sem explicar')}</Campo>
        </div>
      )
    case 'passa':
      return (
        <div className="dv-esp dv-esp-cont">
          <Contador rotulo="Tentativas" valor={esp.tentativas} onChange={(v) => muda('tentativas', v)} />
          <Contador rotulo="Acertos" valor={esp.acertos} onChange={(v) => muda('acertos', v)} />
          <Contador rotulo="Apertou a campainha" valor={esp.apertou_campainha} onChange={(v) => muda('apertou_campainha', v)} />
        </div>
      )
    case 'tribunal':
      return (
        <div className="dv-esp">
          <Campo rotulo="Lado"><Segmentado rotulo="Lado" opcoes={[['defesa', 'Defesa do cliente'], ['acusacao', 'Vendedores']]} valor={esp.lado} onChange={(v) => muda('lado', v)} /></Campo>
          <Campo rotulo="Argumento vencedor">{texto('argumento_vencedor', 'o argumento que mais pesou')}</Campo>
        </div>
      )
    case 'jornada':
      return (
        <div className="dv-esp dv-esp-cont">
          <Contador rotulo="Acertos de produto" valor={esp.acertos_produto} onChange={(v) => muda('acertos_produto', v)} />
          <Contador rotulo="Perguntas de produto" valor={esp.perguntas_produto} onChange={(v) => muda('perguntas_produto', v)} />
          <Contador rotulo="Combos" valor={esp.combos} onChange={(v) => muda('combos', v)} />
        </div>
      )
    case 'detetives':
      return (
        <div className="dv-esp">
          <Campo rotulo="Achou o momento em que a venda se perdeu?"><Segmentado rotulo="Achou o momento" opcoes={SIM_NAO} valor={esp.achou_momento} onChange={(v) => muda('achou_momento', v)} /></Campo>
        </div>
      )
    case 'roda':
      return (
        <div className="dv-esp">
          <Campo rotulo="Foi anfitriã(o)?"><Segmentado rotulo="Anfitrião" opcoes={SIM_NAO} valor={esp.anfitriao} onChange={(v) => muda('anfitriao', v)} /></Campo>
          <Campo rotulo="Aprendizado que trouxe">{texto('aprendizado', 'o que compartilhou com o time')}</Campo>
        </div>
      )
    default:
      return null
  }
}

// ---------------------------------------------------------------- card de uma vendedora (autosave)
function CardVendedora({ inicial, formato, anotador, onSalvo }) {
  const [p, setP] = useState(inicial)
  const [estado, setEstado] = useState(inicial.salvo ? 'salvo' : 'novo') // novo | pendente | salvando | salvo | erro
  const [erro, setErro] = useState(null)
  const timer = useRef(null)
  const ultimo = useRef(inicial)
  const anotRef = useRef(anotador)
  anotRef.current = anotador

  const salvar = useCallback(async () => {
    timer.current = null
    const x = ultimo.current
    setEstado('salvando')
    try {
      await post('dev_salvar_participacao', {
        encontro_id: x.encontro_id, vendedor: x.vendedor, agent_id: x.agent_id, presente: x.presente,
        notas: x.notas || {}, especificos: x.especificos || {}, observacao: x.observacao || '',
        compromisso: x.compromisso || '', lancado_por: anotRef.current || null,
      })
      if (ultimo.current === x) { setEstado('salvo'); setErro(null) }
      onSalvo?.()
    } catch (e) {
      setEstado('erro'); setErro(e.message)
    }
  }, [onSalvo])

  // grava o que ficou pendente ao sair da tela / trocar de encontro
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); salvar() } }, [salvar])

  const mudar = (patch, espera = 700) => {
    const novo = { ...ultimo.current, ...patch }
    ultimo.current = novo
    setP(novo)
    setEstado('pendente')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(salvar, espera)
  }
  const setNota = (k, v) => {
    const notas = { ...(ultimo.current.notas || {}) }
    if (v === undefined) delete notas[k]; else notas[k] = v
    mudar({ notas })
  }
  const nNotas = Object.keys(p.notas || {}).length
  const rotEstado = { novo: 'sem lançamento', pendente: 'editando…', salvando: 'salvando…', salvo: 'salvo', erro: 'erro ao salvar' }[estado]

  return (
    <article className={`dv-card ${p.presente ? '' : 'ausente'}`}>
      <header className="dv-card-topo">
        <div>
          <h4>{p.vendedor}</h4>
          <span className="dv-card-sub">{p.presente ? `${nNotas}/6 competências` : 'ausente'}</span>
        </div>
        <div className="dv-card-dir">
          <span className={`dv-salvo ${estado}`} title={erro || undefined}>{rotEstado}</span>
          <button type="button" className={`dv-presenca ${p.presente ? 'on' : ''}`} aria-pressed={p.presente}
                  onClick={() => mudar({ presente: !p.presente }, 200)}>
            {p.presente ? 'Presente' : 'Faltou'}
          </button>
        </div>
      </header>
      {estado === 'erro' && <p className="dv-erro-card">Não salvou: {erro}. <button type="button" className="dv-link" onClick={salvar}>Tentar de novo</button></p>}
      {p.presente && (
        <>
          <div className="dv-comps">
            {COMPETENCIAS.map(([k, l]) => (
              <div key={k} className="dv-comp">
                <span className="dv-comp-rot">{l}</span>
                <Nota15 rotulo={l} valor={p.notas?.[k]} onChange={(v) => setNota(k, v)} />
              </div>
            ))}
          </div>
          <Especificos formato={formato} esp={p.especificos || {}} set={(especificos) => mudar({ especificos })} />
        </>
      )}
      <div className="dv-textos">
        <label className="dv-campo">
          <span className="dv-campo-rot">Observação</span>
          <textarea className="dv-input" rows={2} value={p.observacao || ''} onChange={(e) => mudar({ observacao: e.target.value }, 1200)}
                    placeholder="o que chamou atenção hoje" />
        </label>
        <label className="dv-campo">
          <span className="dv-campo-rot">Compromisso · o que leva para a mesa</span>
          <textarea className="dv-input" rows={2} value={p.compromisso || ''} onChange={(e) => mudar({ compromisso: e.target.value }, 1200)}
                    placeholder="ex.: perguntar o objetivo antes de simular" />
        </label>
      </div>
      {p.lancado_por && <p className="dv-card-por">lançado por {p.lancado_por}</p>}
    </article>
  )
}

// ---------------------------------------------------------------- aba Lançar
function Lancar({ encontros, encontroId, setEncontroId, onMudou }) {
  const [d, setD] = useState(null)
  const [erro, setErro] = useState(null)
  const [carregando, setCarregando] = useState(false)
  const [cab, setCab] = useState({ condutor: '', anotador: '' })
  const [cabEstado, setCabEstado] = useState('')
  const anotRef = useRef(null)

  useEffect(() => {
    if (!encontroId) return
    let vivo = true
    setCarregando(true); setErro(null)
    getJson('dev_encontro', { id: String(encontroId) })
      .then((r) => {
        if (!vivo) return
        if (r?.ok === false) throw new Error(r.erro)
        setD(r)
        setCab({ condutor: r.encontro?.condutor || '', anotador: r.encontro?.anotador || lerAnotador() })
      })
      .catch((e) => vivo && setErro(e.message))
      .finally(() => vivo && setCarregando(false))
    return () => { vivo = false }
  }, [encontroId])

  const salvarCab = async (patch) => {
    const novo = { ...cab, ...patch }
    setCab(novo)
    if (patch.anotador !== undefined) gravarAnotador(patch.anotador)
    setCabEstado('salvando…')
    try {
      await post('dev_salvar_encontro', { id: encontroId, ...patch })
      setCabEstado('salvo'); onMudou?.()
    } catch (e) { setCabEstado(`erro: ${e.message}`) }
  }
  const marcarFeito = async () => {
    setCabEstado('salvando…')
    try {
      const r = await post('dev_salvar_encontro', { id: encontroId, status: 'feito' })
      setD((x) => ({ ...x, encontro: { ...x.encontro, status: r.encontro?.status } }))
      setCabEstado('encontro marcado como feito'); onMudou?.()
    } catch (e) { setCabEstado(`erro: ${e.message}`) }
  }

  const e = d?.encontro
  const parts = d?.participacoes || []
  return (
    <div className="dv-lancar">
      <section className="panel dv-lancar-cab">
        <label className="dv-campo">
          <span className="dv-campo-rot">Encontro</span>
          <select className="dv-input" value={encontroId || ''} onChange={(ev) => setEncontroId(Number(ev.target.value) || null)}>
            <option value="">Escolha o encontro…</option>
            {encontros.map((x) => (
              <option key={x.id} value={x.id}>
                {fmtData(x.data)} · {x.titulo}{x.turma ? ` · turma ${x.turma}` : ''}{x.status !== 'planejado' ? ` (${NOME_STATUS[x.status].toLowerCase()})` : ''}
              </option>
            ))}
          </select>
        </label>
        {e && (
          <>
            <p className="dv-lancar-desc">{descEncontro(e)}{e.formato_descricao ? ` — ${e.formato_descricao}` : ''}</p>
            <div className="dv-lancar-pessoas">
              <label className="dv-campo">
                <span className="dv-campo-rot">Condutor</span>
                <input className="dv-input" list="dv-pessoas" value={cab.condutor} placeholder="Rodrigo, RH…"
                       onChange={(ev) => setCab({ ...cab, condutor: ev.target.value })}
                       onBlur={(ev) => ev.target.value !== (e.condutor || '') && salvarCab({ condutor: ev.target.value })} />
              </label>
              <label className="dv-campo">
                <span className="dv-campo-rot">Quem está anotando</span>
                <input ref={anotRef} className="dv-input" list="dv-pessoas" value={cab.anotador} placeholder="Rodrigo, RH, Apoio…"
                       onChange={(ev) => setCab({ ...cab, anotador: ev.target.value })}
                       onBlur={(ev) => salvarCab({ anotador: ev.target.value })} />
              </label>
              <datalist id="dv-pessoas">{PESSOAS_ANOTACAO.map((x) => <option key={x} value={x} />)}</datalist>
              <div className="dv-lancar-botoes">
                <button type="button" className="reset-btn" onClick={() => { setCab({ ...cab, anotador: '' }); anotRef.current?.focus() }}>
                  Trocar anotador
                </button>
                {e.status !== 'feito' && <button type="button" className="reset-btn dv-btn-ok" onClick={marcarFeito}>Marcar como feito</button>}
              </div>
            </div>
            {cabEstado && <p className="dv-cab-estado">{cabEstado}</p>}
            {!cab.anotador && <p className="dv-aviso">Informe quem está anotando: o nome vai junto com cada lançamento.</p>}
          </>
        )}
      </section>
      {!encontroId && <p className="dv-vazio">Escolha um encontro para lançar presença, notas das 6 competências e o compromisso de cada vendedora. Cada card salva sozinho.</p>}
      {erro && <div className="state-msg error">Erro: {erro}</div>}
      {carregando && !d && <div className="state-msg">Carregando encontro…</div>}
      {e && (
        <div className="dv-cards">
          {parts.map((p) => (
            <CardVendedora key={`${e.id}-${p.vendedor}`} inicial={p} formato={e.formato_id} anotador={cab.anotador} onSalvo={onMudou} />
          ))}
          {!parts.length && <p className="dv-vazio">Nenhuma vendedora ativa encontrada no cadastro do robô (robo_fu_vendedoras).</p>}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- aba Agenda
function Agenda({ resumo, onStatus, onLancar }) {
  const enc = resumo.encontros || []
  const t = resumo.time || {}
  const hoje = hojeSP()
  const proximo = enc.find((e) => e.data >= hoje && e.status !== 'cancelado' && e.status !== 'feito')
  return (
    <>
      <div className="kpi-grid kpi-grid-3 dv-kpis">
        <div className="kpi"><p className="kpi-label">Encontros feitos</p><p className="kpi-value">{t.encontros_feitos ?? 0}<span className="dv-kpi-de"> / {t.encontros_total ?? enc.length}</span></p></div>
        <div className="kpi"><p className="kpi-label">Presença média (encontros feitos)</p><p className="kpi-value accent">{pct(t.presenca_pct)}</p></div>
        <div className="kpi"><p className="kpi-label">Próximo encontro</p><p className="kpi-value dv-kpi-prox">{proximo ? `${fmtData(proximo.data)} · ${proximo.formato_nome}` : '—'}</p></div>
      </div>
      {FASES.map(([fase, nome, sub]) => {
        const lista = enc.filter((e) => e.fase === fase)
        if (!lista.length) return null
        return (
          <section key={fase} className="panel dv-fase">
            <p className="section-label"><span className={`dv-chip-fase ${fase}`}>{nome}</span> {sub}</p>
            <div className="dv-agenda">
              {lista.map((e) => (
                <div key={e.id} className={`dv-ag-lin ${e.status} ${e.data === hoje ? 'hoje' : ''}`}>
                  <div className="dv-ag-data">
                    <b>{fmtData(e.data)}</b><span>{fmtDiaSemana(e.data)} · sem. {e.semana ?? '—'}</span>
                  </div>
                  <div className="dv-ag-info">
                    <span className="dv-ag-tit">{e.titulo}</span>
                    <span className="dv-ag-sub">
                      {descEncontro(e)}
                      {e.lancados > 0 && ` · ${e.presentes}/${e.lancados} presentes`}
                      {e.condutor && ` · conduz ${e.condutor}`}
                    </span>
                  </div>
                  <div className="dv-ag-acoes">
                    <span className={`dv-status ${e.status}`}>{NOME_STATUS[e.status]}</span>
                    <select className="dv-input dv-ag-sel" aria-label="Mudar status" value={e.status} onChange={(ev) => onStatus(e.id, ev.target.value)}>
                      {STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <button type="button" className="reset-btn dv-btn-ok" onClick={() => onLancar(e.id)}>Lançar</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )
      })}
      {!enc.length && <p className="dv-vazio">Nenhum encontro cadastrado ainda. Os 13 encontros do programa aparecem aqui, separados por fase.</p>}
    </>
  )
}

// ---------------------------------------------------------------- aba Pessoa
function Pessoa({ vendedores, vendedor, setVendedor }) {
  const [d, setD] = useState(null)
  const [erro, setErro] = useState(null)
  const [carregando, setCarregando] = useState(false)
  const [oculta, setOculta] = useState({})

  useEffect(() => {
    if (!vendedor) return
    let vivo = true
    setCarregando(true); setErro(null)
    getJson('dev_pessoa', { vendedor })
      .then((r) => vivo && setD(r))
      .catch((e) => vivo && setErro(e.message))
      .finally(() => vivo && setCarregando(false))
    return () => { vivo = false }
  }, [vendedor])

  const serie = useMemo(() => (d?.serie || []).filter((s) => s.presente).map((s) => ({
    rotulo: `${fmtData(s.data)} ${s.formato_nome || ''}`.trim(),
    ...Object.fromEntries(COMPETENCIAS.map(([k]) => [k, s.notas?.[k] ?? null])),
  })), [d])
  const teatro = useMemo(() => (d?.serie || []).filter((s) => s.formato_id === 'teatro' && s.presente).map((s) => {
    const media = (lado) => {
      const v = TEATRO_CRITERIOS.map(([k]) => s.especificos?.[lado]?.[k]).filter((x) => x != null)
      return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null
    }
    return { rotulo: `${fmtData(s.data)} nível ${s.nivel ?? ''}`, ida: media('ida'), refaz: media('refaz') }
  }).filter((x) => x.ida != null || x.refaz != null), [d])
  const semanal = useMemo(() => (d?.atendimento_semanal || []).map((w) => ({
    t: dt(w.semana).getTime(),
    n: w.n,
    nota: w.nota_media != null ? Number(w.nota_media) : null,
    primeira: w.pct_primeira_resposta_ate_2min != null ? Math.round(w.pct_primeira_resposta_ate_2min * 100) : null,
    cross: w.pct_cross_sell != null ? Math.round(w.pct_cross_sell * 100) : null,
  })), [d])
  const datasEncontros = useMemo(() => [...new Set((d?.serie || []).filter((s) => s.presente).map((s) => dt(s.data).getTime()))], [d])
  const fmtEixo = (t) => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
  const linhasRef = datasEncontros.map((t) => (
    <ReferenceLine key={t} x={t} stroke="#8a978f" strokeDasharray="3 4" strokeOpacity={0.7} />
  ))
  const eixoTempo = (
    <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={fmtEixo}
           tick={{ fill: '#8a978f', fontSize: 11 }} stroke="#263029" />
  )
  const legendaClick = (o) => setOculta((x) => ({ ...x, [o.dataKey]: !x[o.dataKey] }))

  return (
    <>
      <section className="panel dv-pessoa-sel">
        <label className="dv-campo">
          <span className="dv-campo-rot">Vendedora</span>
          <select className="dv-input" value={vendedor || ''} onChange={(e) => setVendedor(e.target.value || null)}>
            <option value="">Escolha…</option>
            {vendedores.map((v) => <option key={v.nome_dash} value={v.nome_dash}>{v.nome_dash}</option>)}
          </select>
        </label>
      </section>
      {!vendedor && <p className="dv-vazio">Escolha uma vendedora para ver a evolução das 6 competências a cada encontro, o Teatro (ida → refaz) e, ao lado, como andou o atendimento real dela por semana.</p>}
      {erro && <div className="state-msg error">Erro: {erro}</div>}
      {carregando && !d && <div className="state-msg">Carregando…</div>}
      {vendedor && d && (
        <>
          <section className="panel dv-graf">
            <p className="section-label">Competências por encontro (1 a 5) · clique na legenda para esconder uma linha</p>
            {serie.length ? (
              <div className="dv-graf-area">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={serie} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
                    <CartesianGrid stroke="#263029" vertical={false} />
                    <XAxis dataKey="rotulo" tick={{ fill: '#8a978f', fontSize: 11 }} stroke="#263029" interval="preserveStartEnd" />
                    <YAxis domain={[1, 5]} ticks={[1, 2, 3, 4, 5]} tick={{ fill: '#8a978f', fontSize: 11 }} stroke="#263029" />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 12, cursor: 'pointer' }} onClick={legendaClick} />
                    {COMPETENCIAS.map(([k, l], i) => (
                      <Line key={k} type="monotone" dataKey={k} name={l} stroke={COR_COMP[i]} strokeWidth={2}
                            dot={{ r: 4 }} activeDot={{ r: 5 }} connectNulls hide={!!oculta[k]} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : <p className="dv-vazio">Ainda não há notas lançadas para {nomeCurto(vendedor)}. Depois do primeiro encontro, cada competência vira uma linha aqui.</p>}
          </section>

          {teatro.length > 0 && (
            <section className="panel dv-graf">
              <p className="section-label">Teatro do Cliente · média dos 5 critérios na ida e no refaz</p>
              <div className="dv-graf-area dv-graf-baixo">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={teatro} margin={{ top: 8, right: 12, bottom: 4, left: -18 }} barGap={2}>
                    <CartesianGrid stroke="#263029" vertical={false} />
                    <XAxis dataKey="rotulo" tick={{ fill: '#8a978f', fontSize: 11 }} stroke="#263029" />
                    <YAxis domain={[0, 5]} ticks={[0, 1, 2, 3, 4, 5]} tick={{ fill: '#8a978f', fontSize: 11 }} stroke="#263029" />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(255,255,255,.04)' }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="ida" name="Ida" fill={COR_COMP[0]} radius={[4, 4, 0, 0]} maxBarSize={28} />
                    <Bar dataKey="refaz" name="Refaz" fill={COR_COMP[1]} radius={[4, 4, 0, 0]} maxBarSize={28} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}

          <section className="panel dv-graf">
            <p className="section-label">Atendimento real por semana (qualidade dos atendimentos no CRM) · linhas tracejadas = encontros</p>
            {semanal.length ? (
              <div className="dv-graf-duplo">
                <div>
                  <p className="dv-graf-tit">Nota média (0 a 10,5)</p>
                  <div className="dv-graf-area dv-graf-baixo">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={semanal} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
                        <CartesianGrid stroke="#263029" vertical={false} />
                        {eixoTempo}
                        <YAxis domain={[0, 10.5]} tick={{ fill: '#8a978f', fontSize: 11 }} stroke="#263029" />
                        <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(t) => `Semana de ${fmtEixo(t)}`}
                                 formatter={(v, n, it) => [`${num(v, 2)} (${it.payload.n} atend.)`, n]} />
                        {linhasRef}
                        <Line type="monotone" dataKey="nota" name="Nota média" stroke={COR_COMP[0]} strokeWidth={2} dot={{ r: 4 }} connectNulls />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                <div>
                  <p className="dv-graf-tit">% 1ª resposta em até 2 min e % cross-sell</p>
                  <div className="dv-graf-area dv-graf-baixo">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={semanal} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
                        <CartesianGrid stroke="#263029" vertical={false} />
                        {eixoTempo}
                        <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fill: '#8a978f', fontSize: 11 }} stroke="#263029" />
                        <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(t) => `Semana de ${fmtEixo(t)}`} formatter={(v, n) => [`${v}%`, n]} />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        {linhasRef}
                        <Line type="monotone" dataKey="primeira" name="1ª resposta ≤ 2 min" stroke={COR_COMP[1]} strokeWidth={2} dot={{ r: 4 }} connectNulls />
                        <Line type="monotone" dataKey="cross" name="Cross-sell" stroke={COR_COMP[2]} strokeWidth={2} dot={{ r: 4 }} connectNulls />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            ) : <p className="dv-vazio">Sem atendimentos avaliados desde 01/10 para {nomeCurto(vendedor)}. Quando a análise de qualidade avaliar conversas dela, a nota média semanal aparece aqui.</p>}
          </section>

          <section className="panel dv-graf">
            <p className="section-label">Compromissos · o que levou para a mesa</p>
            {(d.compromissos || []).length ? (
              <ul className="dv-comp-lista">
                {d.compromissos.map((c, i) => (
                  <li key={i}><span className="dv-comp-data">{fmtData(c.data)} · {c.formato}</span><span>{c.compromisso}</span></li>
                ))}
              </ul>
            ) : <p className="dv-vazio">Nenhum compromisso registrado ainda. No fim de cada encontro, anote no card dela o que ela leva para a mesa.</p>}
          </section>
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------- aba Formatos
function Medias({ medias }) {
  return (
    <div className="dv-medias">
      {COMPETENCIAS.map(([k, l], i) => {
        const v = medias?.[k]
        return (
          <div key={k} className="dv-media">
            <span className="dv-media-rot">{l}</span>
            <span className="dv-media-barra"><i style={{ width: v != null ? `${(Number(v) / 5) * 100}%` : 0, background: COR_COMP[i] }} /></span>
            <span className="dv-media-v">{v != null ? num(v, 1) : '—'}</span>
          </div>
        )
      })}
    </div>
  )
}

function Formatos({ versao }) {
  const [d, setD] = useState(null)
  const [erro, setErro] = useState(null)
  useEffect(() => {
    getJson('dev_formatos').then(setD).catch((e) => setErro(e.message))
  }, [versao])
  if (erro) return <div className="state-msg error">Erro: {erro}</div>
  if (!d) return <div className="state-msg">Carregando formatos…</div>
  const algum = d.some((f) => f.participacoes > 0)
  return (
    <>
      {!algum && <p className="dv-vazio">Quando os encontros forem lançados, cada formato mostra aqui quantas vezes aconteceu e a média das competências das vendedoras presentes. No Teatro, aparece também quanto subiram do ida para o refaz.</p>}
      <div className="dv-formatos">
        {d.map((f) => (
          <section key={f.id} className="panel dv-fmt">
            <header>
              <h4>{f.nome}</h4>
              <span className="dv-fmt-cont">{f.encontros_feitos}/{f.encontros_total} feitos</span>
            </header>
            <p className="dv-fmt-desc">{f.descricao}{f.modo === 'turmas' ? ' · em turmas A/B/C' : ''}</p>
            <p className="dv-fmt-part">{f.participacoes} participaç{f.participacoes === 1 ? 'ão' : 'ões'} com presença</p>
            <Medias medias={f.medias} />
            {f.id === 'teatro' && (
              <p className={`dv-delta ${f.delta_teatro > 0 ? 'sobe' : f.delta_teatro < 0 ? 'cai' : ''}`}>
                Ida → refaz: {f.delta_teatro == null ? 'sem dados ainda' : `${f.delta_teatro > 0 ? '+' : ''}${num(f.delta_teatro, 2)} em média`}
              </p>
            )}
          </section>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- aba Marcos
function Marcos({ resumo, onSalvo }) {
  const vazio = { id: null, marco: 'D30', vendedor: '', resumo: '', decisoes: '' }
  const [f, setF] = useState(vazio)
  const [estado, setEstado] = useState('')
  const marcos = resumo.marcos || []
  const vendedores = resumo.vendedores || []
  const salvar = async (ev) => {
    ev.preventDefault()
    if (!f.resumo.trim() && !f.decisoes.trim()) { setEstado('Escreva o resumo ou as decisões.'); return }
    setEstado('salvando…')
    try {
      const data = MARCOS.find(([m]) => m === f.marco)?.[1]
      await post('dev_salvar_marco', { ...f, data, vendedor: f.vendedor || null })
      setEstado('salvo'); setF(vazio); onSalvo?.()
    } catch (e) { setEstado(`erro: ${e.message}`) }
  }
  return (
    <>
      <div className="dv-marcos-topo">
        {MARCOS.map(([m, data, sub]) => {
          const n = marcos.filter((x) => x.marco === m).length
          const passou = data <= hojeSP()
          return (
            <div key={m} className={`kpi dv-marco-kpi ${passou ? 'passou' : ''}`}>
              <p className="kpi-label">{m} · {sub}</p>
              <p className="kpi-value">{fmtData(data)}</p>
              <p className="dv-marco-n">{n ? `${n} registro${n > 1 ? 's' : ''}` : 'sem registro'}</p>
            </div>
          )
        })}
      </div>
      <form className="panel dv-marco-form" onSubmit={salvar}>
        <p className="section-label">{f.id ? 'Editando registro' : 'Novo registro de marco'}</p>
        <div className="dv-marco-linha">
          <label className="dv-campo">
            <span className="dv-campo-rot">Marco</span>
            <select className="dv-input" value={f.marco} onChange={(e) => setF({ ...f, marco: e.target.value })} disabled={!!f.id}>
              {MARCOS.map(([m, data]) => <option key={m} value={m}>{m} · {fmtData(data)}</option>)}
            </select>
          </label>
          <label className="dv-campo">
            <span className="dv-campo-rot">Sobre quem</span>
            <select className="dv-input" value={f.vendedor} onChange={(e) => setF({ ...f, vendedor: e.target.value })}>
              <option value="">Time todo</option>
              {vendedores.map((v) => <option key={v.nome_dash} value={v.nome_dash}>{v.nome_dash}</option>)}
            </select>
          </label>
        </div>
        <label className="dv-campo">
          <span className="dv-campo-rot">Resumo</span>
          <textarea className="dv-input" rows={3} value={f.resumo} onChange={(e) => setF({ ...f, resumo: e.target.value })}
                    placeholder="como chegou neste marco: o que evoluiu, o que travou" />
        </label>
        <label className="dv-campo">
          <span className="dv-campo-rot">Decisões</span>
          <textarea className="dv-input" rows={3} value={f.decisoes} onChange={(e) => setF({ ...f, decisoes: e.target.value })}
                    placeholder="o que muda daqui para frente (formato, foco, acompanhamento)" />
        </label>
        <div className="dv-lancar-botoes">
          <button type="submit" className="reset-btn dv-btn-ok">{f.id ? 'Salvar alterações' : 'Salvar marco'}</button>
          {f.id && <button type="button" className="reset-btn" onClick={() => { setF(vazio); setEstado('') }}>Cancelar edição</button>}
          {estado && <span className="dv-cab-estado">{estado}</span>}
        </div>
      </form>
      {MARCOS.map(([m]) => {
        const lista = marcos.filter((x) => x.marco === m)
        if (!lista.length) return null
        return (
          <section key={m} className="panel dv-marco-lista">
            <p className="section-label">{m}</p>
            {lista.map((x) => (
              <div key={x.id} className="dv-marco-item">
                <div className="dv-marco-item-topo">
                  <b>{x.vendedor || 'Time todo'}</b>
                  <button type="button" className="dv-link" onClick={() => setF({ id: x.id, marco: x.marco, vendedor: x.vendedor || '', resumo: x.resumo || '', decisoes: x.decisoes || '' })}>Editar</button>
                </div>
                {x.resumo && <p><span className="dv-campo-rot">Resumo</span>{x.resumo}</p>}
                {x.decisoes && <p><span className="dv-campo-rot">Decisões</span>{x.decisoes}</p>}
              </div>
            ))}
          </section>
        )
      })}
      {!marcos.length && <p className="dv-vazio">Nenhum marco registrado. Em 18/11 (D30), 18/12 (D60) e 22/01 (D90), registre aqui o resumo e as decisões para o time e para cada vendedora.</p>}
    </>
  )
}

// ---------------------------------------------------------------- tela
const ABAS = [['agenda', 'Agenda'], ['lancar', 'Lançar'], ['pessoa', 'Pessoa'], ['formatos', 'Formatos'], ['marcos', 'Marcos']]
const ABA_KEY = 'dv_aba'

export default function Desenvolvimento() {
  const [aba, setAba] = useState(() => { try { return sessionStorage.getItem(ABA_KEY) || 'agenda' } catch { return 'agenda' } })
  const [resumo, setResumo] = useState(null)
  const [erro, setErro] = useState(null)
  const [versao, setVersao] = useState(0)
  const [encontroId, setEncontroId] = useState(null)
  const [vendedor, setVendedor] = useState(null)

  const trocarAba = (a) => { setAba(a); try { sessionStorage.setItem(ABA_KEY, a) } catch { /* ignora */ } }
  const carregar = useCallback(() => {
    getJson('dev_resumo').then((r) => { setResumo(r); setErro(null) }).catch((e) => setErro(e.message))
  }, [])
  useEffect(() => { carregar() }, [carregar, versao])
  const mudou = useCallback(() => setVersao((v) => v + 1), [])

  // Lançar abre por padrão no encontro de hoje (ou o próximo não feito)
  useEffect(() => {
    if (encontroId || !resumo?.encontros?.length) return
    const hoje = hojeSP()
    const e = resumo.encontros.find((x) => x.data === hoje && x.status !== 'cancelado')
      || resumo.encontros.find((x) => x.data >= hoje && x.status === 'planejado')
    if (e) setEncontroId(e.id)
  }, [resumo, encontroId])

  const mudarStatus = async (id, status) => {
    setResumo((r) => ({ ...r, encontros: r.encontros.map((e) => (e.id === id ? { ...e, status } : e)) }))
    try { await post('dev_salvar_encontro', { id, status }); mudou() } catch (e) { setErro(e.message); mudou() }
  }

  return (
    <div className="dv">
      <div className="dv-topo">
        <div>
          <h2>Desenvolvimento</h2>
          <p className="dv-sub">Programa de treinamentos fora da mesa · 19/10/2026 a 22/01/2027 · 13 encontros semanais + Roda quinzenal</p>
        </div>
        <button type="button" className="reset-btn" onClick={mudou}>Atualizar</button>
      </div>
      <nav className="dv-abas" aria-label="Seções do Desenvolvimento">
        {ABAS.map(([id, l]) => (
          <button key={id} type="button" className={`dv-aba ${aba === id ? 'on' : ''}`} aria-current={aba === id ? 'page' : undefined}
                  onClick={() => trocarAba(id)}>{l}</button>
        ))}
      </nav>
      {erro && <div className="state-msg error">Erro: {erro}</div>}
      {!resumo && !erro && <div className="state-msg">Carregando…</div>}
      {resumo && (
        <>
          {aba === 'agenda' && <Agenda resumo={resumo} onStatus={mudarStatus} onLancar={(id) => { setEncontroId(id); trocarAba('lancar') }} />}
          {aba === 'lancar' && <Lancar encontros={resumo.encontros || []} encontroId={encontroId} setEncontroId={setEncontroId} onMudou={mudou} />}
          {aba === 'pessoa' && <Pessoa vendedores={resumo.vendedores || []} vendedor={vendedor} setVendedor={setVendedor} />}
          {aba === 'formatos' && <Formatos versao={versao} />}
          {aba === 'marcos' && <Marcos resumo={resumo} onSalvo={mudou} />}
        </>
      )}
    </div>
  )
}
