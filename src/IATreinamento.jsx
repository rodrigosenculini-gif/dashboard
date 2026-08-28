import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  BarChart, Bar, ComposedChart, Line, ResponsiveContainer,
  Tooltip, XAxis, YAxis, Legend, CartesianGrid,
} from 'recharts'

const CRITERIOS = [
  { key: 'agilidade',          label: 'Agilidade 1ª resposta', max: 1.0 },
  { key: 'tempo_resposta',     label: 'Tempo de resposta',     max: 1.0 },
  { key: 'informacoes',        label: 'Informações',           max: 1.0 },
  { key: 'fluxograma',         label: 'Fluxograma',            max: 1.0 },
  { key: 'cross_sell',         label: 'Cross sell',            max: 1.0 },
  { key: 'cordialidade',       label: 'Cordialidade',          max: 0.75 },
  { key: 'escrita',            label: 'Escrita',               max: 0.75 },
  { key: 'follow_up',          label: 'Follow up',             max: 0.75 },
  { key: 'controle_situacao',  label: 'Controle da situação',  max: 0.75 },
  { key: 'cliente_alto_valor', label: 'Cliente alto valor',    max: 0.5 },
  { key: 'agradecimento',      label: 'Agradecimento',         max: 0.5 },
  { key: 'extra',              label: 'Extra',                 max: 1.0 },
]

const FASE_LABEL = {
  1: 'Início / contextualização',
  2: 'Vendedora na trilha',
  3: 'Perto do especialista',
  4: 'Especialista',
  5: 'Batendo a meta',
}

async function iaGet(type, params = {}) {
  const qs = new URLSearchParams({ type, ...params })
  const res = await fetch(`/api/ia?${qs.toString()}`)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Erro ao buscar ${type}`)
  return data
}

async function iaPost(type, body) {
  const res = await fetch(`/api/ia?type=${type}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Erro ao enviar ${type}`)
  return data
}

const fmtDataHora = (v) =>
  v ? new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—'
const fmtDia = (v) =>
  v ? new Date(v).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : ''
const nota = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(2).replace('.', ','))

/* ------------------------------------------------------------------ */
/* Overlay genérico                                                    */
/* ------------------------------------------------------------------ */

function Overlay({ titulo, subtitulo, onClose, children, largura = 980 }) {
  return (
    <div className="ia-overlay-backdrop" onClick={onClose}>
      <div
        className="ia-overlay"
        style={{ maxWidth: largura }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ia-overlay-head">
          <div>
            <div className="ia-overlay-title">{titulo}</div>
            {subtitulo && <div className="ia-overlay-sub">{subtitulo}</div>}
          </div>
          <button className="ia-btn ia-btn-ghost" onClick={onClose}>Fechar ✕</button>
        </div>
        <div className="ia-overlay-body">{children}</div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 1. Programar início do simulado no Chatwoot                         */
/* ------------------------------------------------------------------ */

function ProgramarOverlay({ vendedores, onClose, onSalvo }) {
  const [vendedor, setVendedor] = useState(vendedores[0]?.vendedor || '')
  const [quando, setQuando] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [msg, setMsg] = useState('')

  const atual = vendedores.find((v) => v.vendedor === vendedor)

  async function salvar() {
    if (!vendedor || !quando) { setMsg('Escolha a vendedora e a data/hora.'); return }
    setSalvando(true); setMsg('')
    try {
      await iaPost('agendar', {
        vendedor,
        inicio: new Date(quando).toISOString(),
        agendado_por: 'dashboard-geral',
      })
      setMsg(`Simulado de ${vendedor} programado para ${fmtDataHora(quando)}.`)
      onSalvo?.()
    } catch (e) { setMsg(e.message) } finally { setSalvando(false) }
  }

  async function pausar() {
    setSalvando(true); setMsg('')
    try {
      await iaPost('pausar', { vendedor })
      setMsg(`${vendedor} pausada. Nenhum atendimento simulado será disparado.`)
      onSalvo?.()
    } catch (e) { setMsg(e.message) } finally { setSalvando(false) }
  }

  return (
    <Overlay
      titulo="Programar início — IA no Chatwoot"
      subtitulo="A vendedora só entra no simulado depois da data/hora marcada aqui. Ela não sabe que é teste."
      onClose={onClose}
      largura={620}
    >
      <div className="ia-form">
        <label className="ia-field">
          <span>Vendedora</span>
          <select value={vendedor} onChange={(e) => setVendedor(e.target.value)}>
            {vendedores.map((v) => (
              <option key={v.vendedor} value={v.vendedor}>{v.vendedor}</option>
            ))}
          </select>
        </label>

        {atual && (
          <div className="ia-inline-status">
            <span className={`ia-tag ${atual.status === 'ativo' ? 'ok' : 'off'}`}>
              {atual.status}
            </span>
            <span>Ciclo {atual.ciclo} · Fase {atual.fase} — {FASE_LABEL[atual.fase]}</span>
            <span>mínimo {nota(atual.nota_minima)} · {atual.atendimentos_necessarios} atend.</span>
            <span>agendado: {fmtDataHora(atual.inicio_agendado)}</span>
          </div>
        )}

        <label className="ia-field">
          <span>Começar em</span>
          <input type="datetime-local" value={quando} onChange={(e) => setQuando(e.target.value)} />
        </label>

        <div className="ia-actions">
          <button className="ia-btn ia-btn-primary" onClick={salvar} disabled={salvando}>
            {salvando ? 'Salvando…' : 'Programar'}
          </button>
          <button className="ia-btn ia-btn-ghost" onClick={pausar} disabled={salvando}>
            Pausar esta vendedora
          </button>
        </div>

        {msg && <div className="ia-msg">{msg}</div>}

        <p className="ia-hint">
          O orquestrador roda de 10 em 10 minutos e só considera vendedoras com início
          programado e já vencido. O disparo tem fator aleatório — não cai sempre no
          mesmo horário.
        </p>
      </div>
    </Overlay>
  )
}

/* ------------------------------------------------------------------ */
/* 2. Stats de critérios                                               */
/* ------------------------------------------------------------------ */

function CriteriosOverlay({ vendedor, onClose }) {
  const [criterios, setCriterios] = useState([])
  const [atendimentos, setAtendimentos] = useState([])
  const [fases, setFases] = useState([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState('')

  useEffect(() => {
    let vivo = true
    setLoading(true); setErro('')
    Promise.all([
      iaGet('criterios', { vendedor }),
      iaGet('atendimentos', { vendedor }),
      iaGet('fases', { vendedor }),
    ])
      .then(([c, a, f]) => {
        if (!vivo) return
        setCriterios(c.data || []); setAtendimentos(a.data || []); setFases(f.data || [])
      })
      .catch((e) => vivo && setErro(e.message))
      .finally(() => vivo && setLoading(false))
    return () => { vivo = false }
  }, [vendedor])

  const barras = useMemo(() => {
    if (!criterios.length) return []
    return CRITERIOS.map((c) => {
      const soma = criterios.reduce((s, r) => s + Number(r[c.key] || 0), 0)
      const media = soma / criterios.length
      return {
        criterio: c.label,
        media: Math.round(media * 100) / 100,
        maximo: c.max,
        aproveitamento: Math.round((media / c.max) * 100),
      }
    })
  }, [criterios])

  const avaliados = atendimentos.filter((a) => a.status === 'avaliado')
  const mediaGeral = avaliados.length
    ? avaliados.reduce((s, a) => s + Number(a.nota_final || 0), 0) / avaliados.length
    : null
  const pior = [...barras].sort((a, b) => a.aproveitamento - b.aproveitamento)[0]
  const melhor = [...barras].sort((a, b) => b.aproveitamento - a.aproveitamento)[0]

  return (
    <Overlay
      titulo={`Critérios — ${vendedor || 'todas as vendedoras'}`}
      subtitulo="Médias dos atendimentos simulados já avaliados. Escala total 10,00."
      onClose={onClose}
    >
      {loading && <div className="ia-msg">Carregando…</div>}
      {erro && <div className="ia-msg ia-erro">{erro}</div>}

      {!loading && !erro && (
        <>
          <div className="ia-kpis">
            <div className="ia-kpi"><span>Atendimentos avaliados</span><strong>{avaliados.length}</strong></div>
            <div className="ia-kpi"><span>Nota média</span><strong>{nota(mediaGeral)}</strong></div>
            <div className="ia-kpi"><span>Critério mais forte</span><strong>{melhor?.criterio || '—'}</strong></div>
            <div className="ia-kpi ia-kpi-alerta"><span>Critério mais fraco</span><strong>{pior?.criterio || '—'}</strong></div>
          </div>

          {barras.length > 0 && (
            <div className="ia-chart">
              <ResponsiveContainer width="100%" height={380}>
                <BarChart data={barras} layout="vertical" margin={{ left: 130, right: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                  <XAxis type="number" domain={[0, 100]} unit="%" />
                  <YAxis type="category" dataKey="criterio" width={130} tick={{ fontSize: 12 }} />
                  <Tooltip
                    formatter={(v, n, p) =>
                      [`${v}% (${nota(p.payload.media)} de ${nota(p.payload.maximo)})`, 'Aproveitamento']}
                  />
                  <Bar dataKey="aproveitamento" name="Aproveitamento" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <h4 className="ia-h4">Resultado por fase</h4>
          <div className="ia-tabela-wrap">
            <table className="ia-tabela">
              <thead>
                <tr>
                  <th>Vendedora</th><th>Ciclo</th><th>Fase</th><th>Atend.</th>
                  <th>Média</th><th>Mínimo</th><th>Resultado</th><th>Critérios fracos</th>
                </tr>
              </thead>
              <tbody>
                {fases.length === 0 && (
                  <tr><td colSpan={8} className="ia-vazio">Nenhuma fase concluída ainda.</td></tr>
                )}
                {fases.map((f) => (
                  <tr key={`${f.vendedor}-${f.ciclo}-${f.fase}-${f.created_at}`}>
                    <td>{f.vendedor}</td><td>{f.ciclo}</td><td>{f.fase}</td>
                    <td>{f.qtd_atendimentos}</td><td>{nota(f.media_nota)}</td><td>{nota(f.nota_minima)}</td>
                    <td>
                      <span className={`ia-tag ${f.aprovado ? 'ok' : 'off'}`}>
                        {f.aprovado ? 'aprovada' : 'refazer'}
                      </span>
                      {f.aprovado && f.atendimentos_abaixo_minimo?.length > 0 && (
                        <span className="ia-tag warn" title="Passou pela média, mas teve atendimento abaixo do mínimo">
                          pela média
                        </span>
                      )}
                    </td>
                    <td className="ia-td-obs">{f.criterios_fracos || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4 className="ia-h4">Últimos atendimentos simulados</h4>
          <div className="ia-tabela-wrap">
            <table className="ia-tabela">
              <thead>
                <tr>
                  <th>Data</th><th>Vendedora</th><th>Ciclo/Fase</th><th>Cenário</th>
                  <th>Entrada</th><th>Turnos</th><th>Nota</th><th>Classificação</th><th>Conversa</th>
                </tr>
              </thead>
              <tbody>
                {atendimentos.length === 0 && (
                  <tr><td colSpan={9} className="ia-vazio">Nenhum atendimento simulado ainda.</td></tr>
                )}
                {atendimentos.slice(0, 40).map((a) => (
                  <tr key={a.id}>
                    <td>{fmtDataHora(a.created_at)}</td>
                    <td>{a.vendedor}</td>
                    <td>C{a.ciclo} · F{a.fase}</td>
                    <td>{a.cenario_fluxograma}</td>
                    <td>{a.roteiro_entrada}</td>
                    <td>{a.turnos}</td>
                    <td>{nota(a.nota_final)}</td>
                    <td>
                      <span className={`ia-tag ${a.atingiu_minimo ? 'ok' : a.status === 'avaliado' ? 'off' : 'warn'}`}>
                        {a.classificacao || a.status}
                      </span>
                    </td>
                    <td>
                      {a.conversation ? (
                        <a
                          href={`https://crm.vendeaitecnologia.com.br/app/accounts/75/conversations/${a.conversation}`}
                          target="_blank" rel="noreferrer"
                        >abrir</a>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Overlay>
  )
}

/* ------------------------------------------------------------------ */
/* 3. Treinamento IA × Trilha do especialista                          */
/* ------------------------------------------------------------------ */

function TrilhaOverlay({ vendedor, onClose }) {
  const [serie, setSerie] = useState([])
  const [resumo, setResumo] = useState([])
  const [treinos, setTreinos] = useState([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState('')

  useEffect(() => {
    let vivo = true
    setLoading(true); setErro('')
    Promise.all([iaGet('trilha', { vendedor }), iaGet('treinos', { vendedor })])
      .then(([t, s]) => {
        if (!vivo) return
        setSerie(t.data || []); setResumo(t.resumo || []); setTreinos(s.data || [])
      })
      .catch((e) => vivo && setErro(e.message))
      .finally(() => vivo && setLoading(false))
    return () => { vivo = false }
  }, [vendedor])

  // uma linha por dia, com as duas fontes lado a lado
  const dados = useMemo(() => {
    const mapa = new Map()
    for (const r of serie) {
      const dia = String(r.dia).slice(0, 10)
      if (!mapa.has(dia)) mapa.set(dia, { dia, pct_trilha: null, nota_treino: null, respostas: 0, sessoes: 0 })
      const linha = mapa.get(dia)
      if (r.fonte === 'trilha') {
        linha.pct_trilha = r.indicador === null ? null : Number(r.indicador)
        linha.respostas = Number(r.eventos || 0)
      } else {
        linha.nota_treino = r.indicador === null ? null : Number(r.indicador)
        linha.sessoes = Number(r.eventos || 0)
      }
    }
    return [...mapa.values()].sort((a, b) => a.dia.localeCompare(b.dia))
  }, [serie])

  const totalTrilha = resumo.reduce((s, r) => s + Number(r.respostas || 0), 0)
  const acertoTrilha = resumo.length
    ? resumo.reduce((s, r) => s + Number(r.pct_acerto || 0), 0) / resumo.length
    : null
  const encerrados = treinos.filter((t) => t.status === 'encerrada')
  const mediaTreino = encerrados.length
    ? encerrados.reduce((s, t) => s + Number(t.nota_final || 0), 0) / encerrados.length
    : null

  return (
    <Overlay
      titulo={`Treinamento IA × Trilha — ${vendedor || 'todas as vendedoras'}`}
      subtitulo="Nota média da IA de treinamento e % de acerto da trilha do especialista na mesma linha do tempo."
      onClose={onClose}
    >
      {loading && <div className="ia-msg">Carregando…</div>}
      {erro && <div className="ia-msg ia-erro">{erro}</div>}

      {!loading && !erro && (
        <>
          <div className="ia-kpis">
            <div className="ia-kpi"><span>Sessões de treino</span><strong>{encerrados.length}</strong></div>
            <div className="ia-kpi"><span>Nota média no treino</span><strong>{nota(mediaTreino)}</strong></div>
            <div className="ia-kpi"><span>Respostas na trilha</span><strong>{totalTrilha}</strong></div>
            <div className="ia-kpi">
              <span>Acerto na trilha</span>
              <strong>{acertoTrilha === null ? '—' : `${acertoTrilha.toFixed(1).replace('.', ',')}%`}</strong>
            </div>
          </div>

          <div className="ia-chart">
            <ResponsiveContainer width="100%" height={340}>
              <ComposedChart data={dados} margin={{ left: 8, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                <XAxis dataKey="dia" tickFormatter={fmtDia} />
                <YAxis yAxisId="nota" domain={[0, 10]} label={{ value: 'Nota IA', angle: -90, position: 'insideLeft' }} />
                <YAxis yAxisId="pct" orientation="right" domain={[0, 100]} unit="%" />
                <Tooltip labelFormatter={fmtDia} />
                <Legend />
                <Bar yAxisId="pct" dataKey="pct_trilha" name="Acerto trilha (%)" radius={[4, 4, 0, 0]} />
                <Line yAxisId="nota" type="monotone" dataKey="nota_treino" name="Nota treino IA" strokeWidth={2} dot />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <h4 className="ia-h4">Sessões de treinamento</h4>
          <div className="ia-tabela-wrap">
            <table className="ia-tabela">
              <thead>
                <tr>
                  <th>Início</th><th>Vendedora</th><th>Ciclo/Fase</th><th>Turnos</th>
                  <th>Nota</th><th>Mínimo</th><th>Classificação</th><th>Resumo</th>
                </tr>
              </thead>
              <tbody>
                {treinos.length === 0 && (
                  <tr><td colSpan={8} className="ia-vazio">Nenhuma sessão de treinamento ainda.</td></tr>
                )}
                {treinos.map((t) => (
                  <tr key={t.id}>
                    <td>{fmtDataHora(t.created_at)}</td>
                    <td>{t.vendedor}</td>
                    <td>C{t.ciclo} · F{t.fase}</td>
                    <td>{t.turnos}</td>
                    <td>{nota(t.nota_final ?? t.nota_parcial)}</td>
                    <td>{nota(t.nota_minima)}</td>
                    <td>
                      <span className={`ia-tag ${t.atingiu_minimo ? 'ok' : t.status === 'encerrada' ? 'off' : 'warn'}`}>
                        {t.classificacao || t.status}
                      </span>
                    </td>
                    <td className="ia-td-obs">{t.resumo_final || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Overlay>
  )
}

/* ------------------------------------------------------------------ */
/* View principal                                                      */
/* ------------------------------------------------------------------ */

export default function IATreinamento() {
  const [vendedores, setVendedores] = useState([])
  const [filtro, setFiltro] = useState('todos')
  const [overlay, setOverlay] = useState(null) // 'programar' | 'criterios' | 'trilha'
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState('')

  const carregar = useCallback(() => {
    setLoading(true); setErro('')
    iaGet('vendedores')
      .then((r) => setVendedores(r.data || []))
      .catch((e) => setErro(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { carregar() }, [carregar])

  const vendedorFiltro = filtro === 'todos' ? '' : filtro
  const ativas = vendedores.filter((v) => v.status === 'ativo')

  return (
    <div className="ia-view">
      <div className="ia-head">
        <div>
          <h2 className="ia-titulo">IA — Treinamento e Avaliação</h2>
          <p className="ia-sub">
            Atendimento simulado no Chatwoot (a vendedora não sabe) e treinamento no dashboard
            (ela sabe). 12 critérios, escala 10,00.
          </p>
        </div>
        <button className="ia-btn ia-btn-ghost" onClick={carregar}>↻ Atualizar</button>
      </div>

      <div className="ia-barra">
        <label className="ia-field ia-field-inline">
          <span>Vendedora</span>
          <select value={filtro} onChange={(e) => setFiltro(e.target.value)}>
            <option value="todos">Todas</option>
            {vendedores.map((v) => (
              <option key={v.vendedor} value={v.vendedor}>{v.vendedor}</option>
            ))}
          </select>
        </label>

        <div className="ia-botoes">
          <button className="ia-btn ia-btn-primary" onClick={() => setOverlay('programar')}>
            🗓 Programar início (Chatwoot)
          </button>
          <button className="ia-btn" onClick={() => setOverlay('criterios')}>
            📊 Stats de critérios
          </button>
          <button className="ia-btn" onClick={() => setOverlay('trilha')}>
            📈 Treinamento × Trilha
          </button>
        </div>
      </div>

      {loading && <div className="ia-msg">Carregando…</div>}
      {erro && <div className="ia-msg ia-erro">{erro}</div>}

      {!loading && !erro && (
        <>
          <div className="ia-kpis">
            <div className="ia-kpi"><span>Vendedoras cadastradas</span><strong>{vendedores.length}</strong></div>
            <div className="ia-kpi"><span>Em simulado ativo</span><strong>{ativas.length}</strong></div>
            <div className="ia-kpi">
              <span>Próximo início</span>
              <strong>
                {fmtDataHora(
                  vendedores
                    .map((v) => v.inicio_agendado)
                    .filter(Boolean)
                    .sort()[0]
                )}
              </strong>
            </div>
          </div>

          <div className="ia-tabela-wrap">
            <table className="ia-tabela">
              <thead>
                <tr>
                  <th>Vendedora</th><th>Status</th><th>Ciclo</th><th>Fase</th>
                  <th>Progresso</th><th>Média da fase</th><th>Mínimo</th><th>Início programado</th>
                </tr>
              </thead>
              <tbody>
                {vendedores.length === 0 && (
                  <tr><td colSpan={8} className="ia-vazio">Nenhuma vendedora cadastrada no simulado.</td></tr>
                )}
                {vendedores.map((v) => (
                  <tr key={v.vendedor}>
                    <td>{v.vendedor}</td>
                    <td><span className={`ia-tag ${v.status === 'ativo' ? 'ok' : 'off'}`}>{v.status}</span></td>
                    <td>{v.ciclo}</td>
                    <td>{v.fase} — {FASE_LABEL[v.fase]}</td>
                    <td>{v.atendimentos_concluidos}/{v.atendimentos_necessarios}</td>
                    <td>{nota(v.media_fase)}</td>
                    <td>{nota(v.nota_minima)}</td>
                    <td>{fmtDataHora(v.inicio_agendado)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {overlay === 'programar' && (
        <ProgramarOverlay
          vendedores={vendedores}
          onClose={() => setOverlay(null)}
          onSalvo={carregar}
        />
      )}
      {overlay === 'criterios' && (
        <CriteriosOverlay vendedor={vendedorFiltro} onClose={() => setOverlay(null)} />
      )}
      {overlay === 'trilha' && (
        <TrilhaOverlay vendedor={vendedorFiltro} onClose={() => setOverlay(null)} />
      )}
    </div>
  )
}
