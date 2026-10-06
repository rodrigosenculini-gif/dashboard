import React, { useEffect, useRef, useState } from 'react'

// Qualidade dos atendimentos da VendeAI (vendedoras e IA): análise diária pelos 9 critérios
// (n8n "Qualidade - transcrição e análise de atendimentos" -> tabela crm_qualidade).

const CRM = 'https://crm.vendeaitecnologia.com.br/app/accounts/75/conversations/'
const CRITERIOS = [
  ['agilidade', 'Agilidade', 1.5], ['tempo_resposta', 'Tempo resp.', 1.5], ['texto_audio', 'Texto x áudio', 1],
  ['cordialidade', 'Cordialidade', 1], ['escrita', 'Escrita', 1], ['informacoes', 'Informações', 1],
  ['cross_sell', 'Cross-sell', 1.5], ['agradecimento', 'Agradec./indicação', 1],
]
const corNota = (n) => (n == null ? '' : n >= 9 ? 'ok' : n >= 7 ? 'bom' : n >= 5 ? 'medio' : 'ruim')
const corPct = (p) => (p == null ? '' : p >= 0.8 ? 'ok' : p >= 0.5 ? 'medio' : 'ruim')

const NOME_ACAO_TRIAGEM = {
  manter: 'Manter (VendeAI)', followup: 'Follow-up do robô', vendedora: 'Vendedora', vendedora_3k: 'Vendedora se ≥ R$ 3 mil',
  back: 'Backoffice (Hotline)', nossa_ia: 'Nossa IA', encerrar: 'Encerrar',
}
const hora = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

// derivações da IA da VendeAI para humano e o que a nossa triagem fez/faria
function Triagem({ dias }) {
  const [d, setD] = useState(null)
  useEffect(() => {
    fetch(`/api/dashboard?type=robo_triagem&dias=${dias}`).then((r) => r.json()).then((x) => setD(x?.data ?? x)).catch(() => {})
  }, [dias])
  if (!d?.por_motivo) return null
  return (
    <section className="panel table-panel">
      <p className="section-label">
        Triagem · transferências da IA da VendeAI para humano · {d.modo === 'ativo' || !d.em_previa?.length
          ? 'agindo em todos os motivos'
          : `agindo em ${d.n_motivos - d.em_previa.length} de ${d.n_motivos} motivos · só registra: ${d.em_previa.join(', ')}`}
      </p>
      <div className="scroll-table">
        <table className="robo-desemp">
          <thead><tr><th>Motivo (VendeAI)</th><th>Qtd.</th><th title="a VendeAI deixou sem dono / mandou para vendas">Sem dono / vendas</th><th>Nossa ação</th></tr></thead>
          <tbody>
            {d.por_motivo.map((m) => (
              <tr key={`${m.motivo}-${m.acao}`}>
                <td>{m.motivo || '—'}</td><td>{m.n}</td><td>{m.sem_dono} / {m.vendas}</td><td>{NOME_ACAO_TRIAGEM[m.acao] || m.acao}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!d.por_motivo.length && <p className="home-vazio">Nenhuma transferência no período.</p>}
      </div>
      {d.ultimas.length > 0 && <>
        <p className="section-label robo-sub">Últimas</p>
        <div className="rq-lista">
          {d.ultimas.map((u) => (
            <div key={u.id} className="robo-acao">
              <span className="robo-acao-hora">{hora(u.em)}</span>
              <span className="robo-acao-tipo">{u.motivo}</span>
              <a href={CRM + u.conversation_id} target="_blank" rel="noreferrer">#{u.conversation_id}</a>
              <span className="robo-acao-det">{u.etapa}{u.destino_vendeai ? ` · VendeAI: ${u.destino_vendeai}` : ''} · {u.status}: {u.resultado || NOME_ACAO_TRIAGEM[u.acao] || u.acao}</span>
            </div>
          ))}
        </div>
      </>}
    </section>
  )
}

// etiquetas colocadas à mão (tratativa, followup1/2, retomar, nova_simulação): quem colocou, quem fez,
// o que venceu sem atendimento (o robô retoma) e o que ainda está no prazo
const NOME_STATUS = { aguardando: 'no prazo', vencido: 'venceu — robô retoma', feito: 'feito', removida: 'removida' }
function Manuais({ dias }) {
  const [d, setD] = useState(null)
  useEffect(() => {
    fetch(`/api/dashboard?type=robo_manuais&dias=${dias}`).then((r) => r.json()).then((x) => setD(x?.data ?? x)).catch(() => {})
  }, [dias])
  if (!d?.por_etiqueta) return null
  const prazos = d.prazos || {}
  return (
    <section className="panel table-panel">
      <p className="section-label">Etiquetas manuais · colocadas pela equipe (não pelo robô) · no prazo a pessoa faz; vencida, o robô retoma</p>
      <div className="scroll-table">
        <table className="robo-desemp">
          <thead><tr><th>Etiqueta</th><th>Prazo</th><th>Qtd.</th><th>Feito</th><th>No prazo</th><th>Venceu</th><th>Removida</th><th>Tempo médio</th></tr></thead>
          <tbody>
            {d.por_etiqueta.map((e) => (
              <tr key={e.etiqueta}>
                <td>{e.etiqueta}</td><td>{prazos[e.etiqueta] ?? '—'} min</td><td>{e.n}</td>
                <td className="robo-taxa ok">{e.feito}</td><td>{e.aguardando}</td>
                <td className={`robo-taxa ${e.vencido ? 'ruim' : ''}`}>{e.vencido}</td><td>{e.removida}</td>
                <td>{e.media_min != null ? `${e.media_min} min` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!d.por_etiqueta.length && <p className="home-vazio">Nenhuma etiqueta manual no período.</p>}
      </div>
      {d.por_pessoa.length > 0 && <>
        <p className="section-label robo-sub">Por responsável pelo atendimento</p>
        <div className="scroll-table">
          <table className="robo-desemp">
            <thead><tr><th>Com quem estava</th><th>Qtd.</th><th>Feito</th><th>No prazo</th><th>Venceu</th><th>Tempo médio</th></tr></thead>
            <tbody>
              {d.por_pessoa.map((p) => (
                <tr key={p.dono}>
                  <td>{p.dono}</td><td>{p.n}</td><td className="robo-taxa ok">{p.feito}</td><td>{p.aguardando}</td>
                  <td className={`robo-taxa ${p.vencido ? 'ruim' : ''}`}>{p.vencido}</td><td>{p.media_min != null ? `${p.media_min} min` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>}
      {d.por_autor?.length > 0 && <>
        <p className="section-label robo-sub">Quem colocou</p>
        <div className="rq-lista">
          {d.por_autor.map((a) => (
            <div key={a.autor} className="robo-acao">
              <span className="robo-acao-tipo">{a.autor}</span>
              <span className="robo-acao-det">{a.n} · {Object.entries(a.etiquetas || {}).map(([k, v]) => `${k} ${v}`).join(' · ')}</span>
            </div>
          ))}
        </div>
      </>}
      {d.pendentes.length > 0 && <>
        <p className="section-label robo-sub">Abertas (no prazo ou vencidas)</p>
        <div className="rq-lista">{d.pendentes.map((p) => (
          <div key={`${p.conversation_id}-${p.etiqueta}`} className="robo-acao">
            <span className="robo-acao-hora">{hora(p.em)}</span>
            <span className="robo-acao-tipo">{p.etiqueta}</span>
            <a href={CRM + p.conversation_id} target="_blank" rel="noreferrer">#{p.conversation_id}</a>
            <span className="robo-acao-det">{NOME_STATUS[p.status] || p.status} · por {p.por || '?'} · com {p.dono || 'sem dono'}</span>
          </div>
        ))}</div>
      </>}
      {d.feitos?.length > 0 && <>
        <p className="section-label robo-sub">Feitos recentemente</p>
        <div className="rq-lista">{d.feitos.map((p) => (
          <div key={`${p.conversation_id}-${p.etiqueta}-${p.feito_em}`} className="robo-acao">
            <span className="robo-acao-hora">{hora(p.feito_em)}</span>
            <span className="robo-acao-tipo">{p.etiqueta}</span>
            <a href={CRM + p.conversation_id} target="_blank" rel="noreferrer">#{p.conversation_id}</a>
            <span className="robo-acao-det">por {p.por || '?'} · feito por {p.quem_fez || '?'} em {Math.round((new Date(p.feito_em) - new Date(p.em)) / 60000)} min</span>
          </div>
        ))}</div>
      </>}
    </section>
  )
}

// visão geral da equipe (todas as vendedoras juntas, ponderado pelo nº de atendimentos) x IA da VendeAI
const fmt = (n, c = 1) => (n == null || Number.isNaN(n) ? '—' : n.toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c }))
function Visao({ d }) {
  const eq = d.ranking.filter((r) => r.avaliado !== 'ia')
  const ia = d.ranking.find((r) => r.avaliado === 'ia')
  const nEq = eq.reduce((s, r) => s + r.n, 0)
  if (!nEq && !ia) return null
  const mediaEq = nEq ? eq.reduce((s, r) => s + Number(r.media) * r.n, 0) / nEq : null
  const ruimEq = nEq ? eq.reduce((s, r) => s + r.ruim, 0) / nEq : null
  const bomEq = nEq ? eq.reduce((s, r) => s + r.excelente + r.bom, 0) / nEq : null
  // % do máximo em cada critério: equipe (média ponderada) e IA
  const crit = CRITERIOS.map(([k, nome, max]) => {
    const com = eq.filter((r) => r.criterios?.[k] != null)
    const n = com.reduce((s, r) => s + r.n, 0)
    const e = n ? com.reduce((s, r) => s + Number(r.criterios[k]) * r.n, 0) / n / max : null
    const i = ia?.criterios?.[k] != null ? Number(ia.criterios[k]) / max : null
    return { k, nome, e, i }
  })
  const comEq = crit.filter((c) => c.e != null).sort((a, b) => a.e - b.e)
  const pior = comEq[0], melhor = comEq.at(-1)
  const dias = d.por_dia || []
  return (
    <section className="panel">
      <p className="section-label">Visão geral · todas as vendedoras juntas x IA da VendeAI</p>
      <div className="kpi-grid rq-kpis">
        <div className="kpi"><p className="kpi-label">Nota média da equipe</p>
          <p className={`kpi-value robo-taxa ${corNota(mediaEq)}`}>{fmt(mediaEq)}<small> / 10,5 · {nEq} atend.</small></p></div>
        <div className="kpi"><p className="kpi-label">Nota média da IA da VendeAI</p>
          <p className={`kpi-value robo-taxa ${corNota(ia ? Number(ia.media) : null)}`}>{ia ? fmt(Number(ia.media)) : '—'}<small> / 10,5 · {ia?.n ?? 0} atend.</small></p></div>
        <div className="kpi"><p className="kpi-label">Equipe: excelente ou bom</p>
          <p className="kpi-value">{bomEq == null ? '—' : `${Math.round(bomEq * 100)}%`}</p></div>
        <div className="kpi"><p className="kpi-label">Equipe: necessita melhoria</p>
          <p className={`kpi-value ${ruimEq > 0.5 ? 'alerta' : ''}`}>{ruimEq == null ? '—' : `${Math.round(ruimEq * 100)}%`}</p></div>
        <div className="kpi"><p className="kpi-label">Ponto mais fraco da equipe</p>
          <p className="kpi-value rq-kpi-txt">{pior ? `${pior.nome} · ${Math.round(pior.e * 100)}%` : '—'}</p></div>
        <div className="kpi"><p className="kpi-label">Ponto mais forte da equipe</p>
          <p className="kpi-value rq-kpi-txt">{melhor ? `${melhor.nome} · ${Math.round(melhor.e * 100)}%` : '—'}</p></div>
      </div>

      <div className="rq-graficos">
        <div className="rq-graf">
          <p className="section-label robo-sub">Critérios · % da nota máxima</p>
          <div className="rq-legenda">
            <span><i className="rq-cor rq-eq" />Equipe</span><span><i className="rq-cor rq-ia" />IA da VendeAI</span>
          </div>
          {crit.map((c) => (
            <div key={c.k} className="rq-crit">
              <span className="rq-crit-nome">{c.nome}</span>
              <div className="rq-barras">
                {[['eq', 'Equipe', c.e], ['ia', 'IA da VendeAI', c.i]].map(([cls, quem, v]) => (
                  <div key={cls} className="rq-barra-linha" title={`${c.nome} · ${quem}: ${v == null ? 'sem dado' : `${Math.round(v * 100)}%`}`}>
                    <div className={`rq-barra rq-${cls}`} style={{ width: `${v == null ? 0 : Math.max(v * 100, 1)}%` }} />
                    <span className="rq-barra-val">{v == null ? '—' : `${Math.round(v * 100)}%`}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="rq-graf">
          <p className="section-label robo-sub">Nota média por dia</p>
          <div className="rq-legenda">
            <span><i className="rq-cor rq-eq" />Equipe</span><span><i className="rq-cor rq-ia" />IA da VendeAI</span>
          </div>
          {dias.length < 2
            ? <p className="home-vazio">A evolução aparece a partir do 2º dia de análises{dias[0] ? ` (hoje: equipe ${fmt(Number(dias[0].equipe))}, IA ${fmt(Number(dias[0].ia))})` : ''}.</p>
            : <div className="rq-dias-graf">
                {dias.map((x) => (
                  <div key={x.dia} className="rq-dia">
                    <div className="rq-dia-barras">
                      {[['eq', 'Equipe', x.equipe, x.n_equipe], ['ia', 'IA da VendeAI', x.ia, x.n_ia]].map(([cls, quem, v, n]) => (
                        <div key={cls} className={`rq-col rq-${cls}`} style={{ height: `${v == null ? 0 : (Number(v) / 10.5) * 100}%` }}
                             title={`${new Date(x.dia + 'T12:00').toLocaleDateString('pt-BR')} · ${quem}: ${fmt(Number(v))} (${n} atend.)`} />
                      ))}
                    </div>
                    <span className="rq-dia-lbl">{new Date(x.dia + 'T12:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</span>
                  </div>
                ))}
              </div>}
        </div>
      </div>
    </section>
  )
}

// destaques da equipe: em cada critério, quem foi melhor (pódio de 3); só entra quem tem o mínimo de atendimentos
const MIN_ATEND = 3
function Destaques({ d }) {
  const eq = d.ranking.filter((r) => r.avaliado !== 'ia' && r.n >= MIN_ATEND)
  if (eq.length < 2) return null
  const cards = [
    { k: 'media', nome: 'Nota geral', val: (r) => Number(r.media) / 10.5, txt: (r) => fmt(Number(r.media)) },
    ...CRITERIOS.map(([k, nome, max]) => ({ k, nome, val: (r) => (r.criterios?.[k] == null ? null : Number(r.criterios[k]) / max) })),
  ].map((c) => ({ ...c, podio: eq.filter((r) => c.val(r) != null).sort((a, b) => c.val(b) - c.val(a) || b.n - a.n).slice(0, 3) }))
    .filter((c) => c.podio.length)
  const pctTxt = (c, r) => (c.txt ? c.txt(r) : `${Math.round(c.val(r) * 100)}%`)
  return (
    <section className="panel">
      <p className="section-label">Destaques da equipe · quem se saiu melhor em cada critério (mín. {MIN_ATEND} atendimentos no período)</p>
      <div className="rq-destaques">
        {cards.map((c) => (
          <div key={c.k} className="rq-dest">
            <span className="rq-dest-crit">{c.nome}</span>
            <span className="rq-dest-nome">🏆 {c.podio[0].nome}</span>
            <span className={`rq-dest-val robo-taxa ${c.k === 'media' ? corNota(Number(c.podio[0].media)) : corPct(c.val(c.podio[0]))}`}>{pctTxt(c, c.podio[0])}</span>
            {c.podio.slice(1).map((r, i) => (
              <span key={r.avaliado_id} className="rq-dest-outro">{i + 2}º {r.nome} · {pctTxt(c, r)}</span>
            ))}
          </div>
        ))}
      </div>
    </section>
  )
}

export default function RoboQualidade() {
  const [dias, setDias] = useState(7)
  const [d, setD] = useState(null)
  const [erro, setErro] = useState(null)
  const [sel, setSel] = useState(null) // avaliado_id escolhido
  const analisesRef = useRef(null)
  // clique na linha: filtra as análises dela e rola até a lista
  const escolher = (id) => {
    setSel((x) => (x === id ? null : id))
    if (sel !== id) setTimeout(() => analisesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  useEffect(() => {
    setD(null)
    fetch(`/api/dashboard?type=robo_qualidade&dias=${dias}`).then((r) => r.json())
      .then((x) => { const v = x?.data ?? x; if (v?.ranking) setD(v); else setErro(x?.error || 'falha') })
      .catch((e) => setErro(e.message))
  }, [dias])

  if (erro) return <div className="state-msg error">Erro: {erro}</div>
  if (!d) return <div className="home-vazio">carregando qualidade...</div>

  const fila = d.fila || {}
  const ultimas = (d.ultimas || []).filter((u) => sel == null || u.avaliado_id === sel || (sel === 1 && u.avaliado === 'ia'))
  return (
    <div className="rq">
      <div className="kpi-grid">
        <div className="kpi"><p className="kpi-label">Mensagens capturadas hoje</p><p className="kpi-value">{d.captura?.mensagens_hoje ?? 0}</p></div>
        <div className="kpi"><p className="kpi-label">Atendimentos analisados</p><p className="kpi-value accent">{fila.ok ?? 0}</p></div>
        <div className="kpi"><p className="kpi-label">Na fila</p><p className="kpi-value">{(fila.pendente ?? 0) + (fila.processando ?? 0)}</p></div>
        <div className="kpi"><p className="kpi-label">Áudios/imagens transcritos (24h)</p><p className="kpi-value">{d.transcricao?.ok ?? 0}<small> / {Object.values(d.transcricao || {}).reduce((s, n) => s + n, 0)}</small></p></div>
        <div className="kpi"><p className="kpi-label">Erros de análise</p><p className={`kpi-value ${fila.erro ? 'alerta' : ''}`}>{fila.erro ?? 0}</p></div>
      </div>

      <div className="rq-topo rq-periodo">
        <p className="section-label">Período</p>
        <div className="rq-dias">
          {[1, 7, 30].map((n) => <button key={n} className={`reset-btn ${dias === n ? 'rc-on' : ''}`} onClick={() => setDias(n)}>{n === 1 ? 'Hoje' : `${n} dias`}</button>)}
        </div>
      </div>

      <Visao d={d} />
      <Destaques d={d} />

      <section className="panel table-panel">
        <div className="rq-topo">
          <p className="section-label">Notas por vendedora e IA · 9 critérios, máx. 10,5 · clique para ver os atendimentos</p>
        </div>
        <div className="scroll-table">
          <table className="robo-desemp">
            <thead><tr>
              <th>Avaliado</th><th>Atend.</th><th>Média</th><th title="Excelente / Bom / Regular / Necessita melhoria">Exc/Bom/Reg/Ruim</th>
              {CRITERIOS.map(([k, n, max]) => <th key={k} title={`média da nota (máx. ${max})`}>{n}</th>)}
            </tr></thead>
            <tbody>
              {d.ranking.map((r) => (
                <tr key={`${r.avaliado}-${r.avaliado_id}`} className={`rq-linha ${sel === r.avaliado_id ? 'on' : ''}`}
                    onClick={() => escolher(r.avaliado_id)}>
                  <td>{r.avaliado === 'ia' ? '🤖 ' : ''}{r.nome}</td>
                  <td>{r.n}</td>
                  <td className={`robo-taxa ${corNota(Number(r.media))}`}>{r.media}</td>
                  <td>{r.excelente}/{r.bom}/{r.regular}/{r.ruim}</td>
                  {CRITERIOS.map(([k, , max]) => {
                    const v = r.criterios?.[k]
                    return <td key={k} className={`robo-taxa ${corPct(v == null ? null : v / max)}`}>{v == null ? '—' : `${Math.round((v / max) * 100)}%`}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {!d.ranking.length && <p className="home-vazio">Nenhum atendimento analisado no período ainda. A análise roda depois que o atendimento fica 4h parado (ou no dia seguinte).</p>}
        </div>
      </section>

      <section className="panel table-panel" ref={analisesRef}>
        <div className="rq-topo">
          <p className="section-label">
            Últimas análises{sel != null ? ` · ${d.ranking.find((r) => r.avaliado_id === sel)?.nome ?? ''} (${ultimas.length})` : ''} · clique para abrir
          </p>
          {sel != null && <button className="reset-btn" onClick={() => setSel(null)}>Ver todas</button>}
        </div>
        <div className="rq-cards rq-lista">
          {ultimas.map((u) => (
            <details key={u.id} className="rq-card">
              <summary>
                <span className={`rq-nota ${corNota(Number(u.pontuacao))}`}>{u.pontuacao}</span>
                <span className="rq-quem">{u.avaliado === 'ia' ? '🤖 ' : ''}{u.avaliado_nome}</span>
                <span className="rq-cli">{u.cliente_nome || 'cliente'} · {new Date(u.dia + 'T12:00').toLocaleDateString('pt-BR')}</span>
                <a href={CRM + u.conversation_id} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>#{u.conversation_id}</a>
              </summary>
              {u.oportunidades && <p><b>Melhorar:</b> {u.oportunidades}</p>}
              {u.falhas && u.falhas !== 'Nenhuma falha relevante' && <p className="rq-falha"><b>Falhas:</b> {u.falhas}</p>}
              {u.pontos_fortes && <p><b>Pontos fortes:</b> {u.pontos_fortes}</p>}
              {u.observacao && <p className="rq-obs">{u.observacao}</p>}
            </details>
          ))}
          {!ultimas.length && <p className="home-vazio">Nada por aqui ainda.</p>}
        </div>
      </section>

      <Triagem dias={dias} />
      <Manuais dias={dias} />
    </div>
  )
}
