import React, { useEffect, useState } from 'react'

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
        Triagem · transferências da IA da VendeAI para humano · {d.modo === 'ativo' ? 'agindo' : 'em prévia (só registra o que faria)'}
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
        {d.ultimas.map((u) => (
          <div key={u.id} className="robo-acao">
            <span className="robo-acao-hora">{hora(u.em)}</span>
            <span className="robo-acao-tipo">{u.motivo}</span>
            <a href={CRM + u.conversation_id} target="_blank" rel="noreferrer">#{u.conversation_id}</a>
            <span className="robo-acao-det">{u.etapa}{u.destino_vendeai ? ` · VendeAI: ${u.destino_vendeai}` : ''} · {u.status}: {u.resultado || NOME_ACAO_TRIAGEM[u.acao] || u.acao}</span>
          </div>
        ))}
      </>}
    </section>
  )
}

export default function RoboQualidade() {
  const [dias, setDias] = useState(7)
  const [d, setD] = useState(null)
  const [erro, setErro] = useState(null)
  const [sel, setSel] = useState(null) // avaliado_id escolhido

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

      <section className="panel table-panel">
        <div className="rq-topo">
          <p className="section-label">Notas por vendedora e IA · 9 critérios, máx. 10,5 · clique para ver os atendimentos</p>
          <div className="rq-dias">
            {[1, 7, 30].map((n) => <button key={n} className={`reset-btn ${dias === n ? 'rc-on' : ''}`} onClick={() => setDias(n)}>{n === 1 ? 'Hoje' : `${n} dias`}</button>)}
          </div>
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
                    onClick={() => setSel((x) => (x === r.avaliado_id ? null : r.avaliado_id))}>
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

      <Triagem dias={dias} />

      <section className="panel table-panel">
        <p className="section-label">Últimas análises{sel != null ? ' · filtrado' : ''}</p>
        <div className="rq-cards">
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
    </div>
  )
}
