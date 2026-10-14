import React, { useCallback, useEffect, useState } from 'react'

// Aba "Backoffice" do Robô follow-up: quem está trabalhando agora, dinheiro parado, o que cada vendedora deixou
// sem ação depois do lembrete (e o que fez depois da cobrança) e a prévia da distribuição por desempenho.
// Dados: dashboard_robo_backoffice(). Ações (cobrar / passar) vão para a fila robo_fu_bo_acoes (edge fn robo-backoffice).

const CRM = 'https://crm.vendeaitecnologia.com.br/app/accounts/75/conversations/'
const STATUS = {
  online: ['on', 'online'], travada: ['ruim', 'travada (5+ sem resposta)'], ausente: ['ruim', 'ausente (não responde)'],
  parada: ['', 'computador parado'], offline: ['', 'offline'],
}
const FAIXA = { 'em dia': 'ok', boa: 'ok', media: 'medio', fraca: 'ruim', travada: 'ruim' }
const NOME_CASO = { ticket_alto: 'Ticket alto', ofertado: 'Ofertado', assinatura: 'Assinatura', pendencia: 'Pendência', cliente_sumiu: 'Cliente' }
const fmtMin = (m) => (m == null ? '—' : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`)
const hora = (t) => (t ? new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—')
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—')

async function acao(conversation_id, tipo) {
  const r = await fetch('/api/dashboard?type=bo_acao', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id, acao: tipo, quem: 'dashboard' }),
  })
  const d = await r.json()
  return d?.r ?? d
}

export default function RoboBackoffice() {
  const [d, setD] = useState(null)
  const [erro, setErro] = useState(null)
  const [verCobranca, setVerCobranca] = useState(false)
  const [feito, setFeito] = useState({}) // conversa -> resultado da ação pedida aqui

  const carregar = useCallback(() => {
    fetch('/api/dashboard?type=robo_backoffice').then((r) => r.json())
      .then((x) => { setD(x?.data ?? x); setErro(null) }).catch((e) => setErro(e.message))
  }, [])
  useEffect(() => { carregar(); const t = setInterval(carregar, 60_000); return () => clearInterval(t) }, [carregar])

  const pedir = async (conv, tipo) => {
    setFeito((f) => ({ ...f, [conv]: '...' }))
    const r = await acao(conv, tipo).catch(() => null)
    setFeito((f) => ({ ...f, [conv]: r?.ok ? (tipo === 'cobrar' ? 'cobrada' : 'passando...') : (r?.erro || 'falhou') }))
    setTimeout(carregar, 4000)
  }

  if (erro) return <div className="state-msg error">Erro: {erro}</div>
  if (!d) return <div className="home-vazio">carregando...</div>
  const painel = d.painel || []
  const alertas = d.alertas || []
  const reinc = d.reincidencia || []
  const hoje = reinc.filter((r) => r.dia === reinc[0]?.dia)
  const semana = Object.values(reinc.reduce((m, r) => {
    const x = m[r.vendedora] || (m[r.vendedora] = { vendedora: r.vendedora, lembretes: 0, nao_fez: 0, cobrados: 0, fez_depois: 0, dias: 0 })
    x.lembretes += r.lembretes; x.nao_fez += r.nao_fez; x.cobrados += r.cobrados; x.fez_depois += r.fez_depois; x.dias++
    return m
  }, {})).sort((a, b) => b.nao_fez / (b.lembretes || 1) - a.nao_fez / (a.lembretes || 1))

  return (
    <>
      <div className="kpi-grid">
        <div className="kpi"><p className="kpi-label">Online agora</p><p className="kpi-value">{painel.filter((v) => ['online', 'travada', 'ausente'].includes(v.status)).length}</p></div>
        <div className="kpi"><p className="kpi-label">Travadas / ausentes</p><p className="kpi-value alerta">{painel.filter((v) => ['travada', 'ausente'].includes(v.status)).length}</p></div>
        <div className="kpi"><p className="kpi-label">Propostas paradas</p><p className="kpi-value aviso">{alertas.filter((a) => a.tipo === 'proposta parada').length}</p></div>
        <div className="kpi"><p className="kpi-label">Clientes esperando +30 min</p><p className="kpi-value aviso">{alertas.filter((a) => a.tipo === 'cliente esperando').length}</p></div>
        <div className="kpi"><p className="kpi-label">Lembretes sem ação hoje</p><p className="kpi-value">{(d.cobranca || []).length}</p></div>
      </div>

      <section className="panel table-panel">
        <p className="section-label">Vendedoras agora · última hora · prévia da distribuição por desempenho</p>
        <div className="scroll-table">
          <table className="robo-desemp">
            <thead><tr>
              <th>Vendedora</th><th>Situação</th><th>Pendentes</th><th>Hora: recebeu / respondeu / em 10 min</th>
              <th>Última resposta</th><th title="dos últimos 8 atendimentos, fração respondida em até 10 min">Nota</th>
              <th title="o que a distribuição por desempenho daria a cada 10 min (prévia, ainda não aplicada)">Cota prévia</th>
              <th>Sem ação hoje</th>
            </tr></thead>
            <tbody>
              {painel.map((v) => {
                const [cls, txt] = STATUS[v.status] || ['', v.status]
                return (
                  <tr key={v.agent_id} className={['parada', 'offline'].includes(v.status) ? 'off' : ''}>
                    <td><span className={`robo-dot ${v.status === 'online' ? 'on' : ''}`} /> {v.nome}</td>
                    <td className={`robo-taxa ${cls}`}>{txt}{['parada', 'offline'].includes(v.status) ? ` · ${fmtMin(v.visto_min)}` : ''}</td>
                    <td>{v.pendentes}</td>
                    <td>{v.recebeu_hora} / {v.respondeu_hora} / {v.em10_hora}</td>
                    <td>{v.ultima_resp_min == null ? '—' : `há ${fmtMin(v.ultima_resp_min)}`}</td>
                    <td className={`robo-taxa ${FAIXA[v.faixa] || ''}`}>{v.score == null ? '—' : `${Math.round(v.score * 100)}% · ${v.faixa}`}</td>
                    <td>{v.cota_10min ?? '—'}</td>
                    <td>{v.nao_fez_hoje}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel table-panel">
        <p className="section-label">Dinheiro parado · proposta sem ninguém da equipe escrever há +3h e cliente esperando resposta há +30 min</p>
        <div className="scroll-table">
          {alertas.map((a) => (
            <div key={`${a.tipo}-${a.conversation_id}`} className="robo-acao">
              <span className="robo-acao-hora">{fmtMin(a.desde_min)}</span>
              <span className="robo-acao-tipo">{a.tipo}</span>
              <a href={CRM + a.conversation_id} target="_blank" rel="noreferrer">#{a.conversation_id}</a>
              <span className="robo-acao-det">
                {[a.vendedora || 'sem dono', NOME_CASO[a.caso] || a.caso, a.detalhe].filter(Boolean).join(' · ')}
                {' '}
                {feito[a.conversation_id]
                  ? <b>{feito[a.conversation_id]}</b>
                  : <>
                      {a.vendedora && <button className="reset-btn" onClick={() => pedir(a.conversation_id, 'cobrar')}>Cobrar</button>}
                      <button className="reset-btn" onClick={() => pedir(a.conversation_id, 'passar')}>Passar para outra</button>
                    </>}
              </span>
            </div>
          ))}
          {!alertas.length && <p className="home-vazio">Nada parado agora.</p>}
        </div>
      </section>

      <div className="robo-grid">
        <section className="panel table-panel">
          <p className="section-label">Reincidência · últimos 7 dias (lembrete do robô conferido 30 min depois)</p>
          <div className="scroll-table">
            <table className="robo-desemp">
              <thead><tr><th>Vendedora</th><th>Lembretes</th><th>Sem ação</th><th>Cobrados</th><th>Fez depois da cobrança</th><th>Hoje sem ação</th></tr></thead>
              <tbody>
                {semana.map((s) => {
                  const h = hoje.find((x) => x.vendedora === s.vendedora)
                  return (
                    <tr key={s.vendedora}>
                      <td>{s.vendedora}</td><td>{s.lembretes}</td>
                      <td className={`robo-taxa ${s.nao_fez / (s.lembretes || 1) > 0.5 ? 'ruim' : s.nao_fez / (s.lembretes || 1) > 0.3 ? 'medio' : 'ok'}`}>
                        {s.nao_fez} ({pct(s.nao_fez, s.lembretes)})</td>
                      <td>{s.cobrados}</td><td>{s.fez_depois} ({pct(s.fez_depois, s.cobrados)})</td>
                      <td>{h ? `${h.nao_fez} de ${h.lembretes}` : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel table-panel">
          <p className="section-label">Prévia da distribuição por desempenho · hoje (não aplicada) · leitura {hora(d.previa_em)}</p>
          <div className="scroll-table">
            <table className="robo-desemp">
              <thead><tr><th>Vendedora</th><th>Faixa agora</th><th>Cota agora</th><th>Cota somada no dia</th><th>Recebeu no dia</th><th title="leituras de 10 min em que estaria freada">Freada</th></tr></thead>
              <tbody>
                {(d.previa || []).map((p) => (
                  <tr key={p.vendedora}>
                    <td>{p.vendedora}</td>
                    <td className={`robo-taxa ${FAIXA[p.faixa] || ''}`}>{p.faixa}{p.score != null ? ` · ${Math.round(p.score * 100)}%` : ''}</td>
                    <td>{p.cota_agora}</td><td>{p.cota_dia ?? 0}</td><td>{p.recebeu_dia ?? 0}</td>
                    <td>{p.leituras_freada ? `${p.leituras_freada}x` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!(d.previa || []).length && <p className="home-vazio">A prévia começa a registrar às 8h (a cada 10 min).</p>}
          </div>
        </section>
      </div>

      <section className="panel table-panel">
        <p className="section-label">
          <button type="button" className="reset-btn" onClick={() => setVerCobranca((x) => !x)}>
            {verCobranca ? '▾' : '▸'} Lembretes sem ação hoje ({(d.cobranca || []).length})
          </button>
        </p>
        {verCobranca && <div className="scroll-table">
          {(d.cobranca || []).map((c, i) => (
            <div key={i} className="robo-acao">
              <span className="robo-acao-hora">{hora(c.criado_em)}</span>
              <span className="robo-acao-tipo">{c.vendedora}</span>
              <a href={CRM + c.conversation_id} target="_blank" rel="noreferrer">#{c.conversation_id}</a>
              <span className="robo-acao-det">{c.tipo} · {c.titulo}{c.viu ? ' · viu' : ''}{c.pendente_ainda ? ' · ainda com ela' : ''}</span>
            </div>
          ))}
        </div>}
      </section>

      <section className="panel table-panel">
        <p className="section-label">Ações do backoffice (cobrar / passar)</p>
        {(d.acoes || []).map((a) => (
          <div key={a.id} className={`robo-acao ${String(a.resultado || '').startsWith('erro') ? 'falha' : ''}`}>
            <span className="robo-acao-hora">{hora(a.em)}</span>
            <span className="robo-acao-tipo">{a.acao}{a.quem ? ` · ${a.quem}` : ''}</span>
            <a href={CRM + a.conversation_id} target="_blank" rel="noreferrer">#{a.conversation_id}</a>
            <span className="robo-acao-det">{a.resultado || 'na fila'}</span>
          </div>
        ))}
        {!(d.acoes || []).length && <p className="home-vazio">Nenhuma ação ainda.</p>}
        <p className="home-vazio">Ligações: entram aqui quando o discador da Embratel estiver ligado (ligou ou não ligou, ligações efetivas por vendedora).</p>
      </section>
    </>
  )
}
