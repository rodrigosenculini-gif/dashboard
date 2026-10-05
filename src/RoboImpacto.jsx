import React, { useEffect, useState } from 'react'

// Impacto do robô de follow-up na conversão: antes x depois, resposta ao áudio do robô e o que acontece
// quando ele passa o atendimento para a vendedora (RPC dashboard_robo_impacto).

const pct = (a, b, c = 1) => (b ? ((100 * a) / b).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c }) : '—')
const NOME_CASO = { ticket_alto: 'Ticket alto', ofertado: 'Ofertado', cliente_sumiu: 'Cliente sumiu', assinatura: 'Assinatura', pendencia: 'Pendência' }
const NOME_VIGIA = { 'vendedora escreveu': 'Vendedora escreveu em até 20 min', 'devolvido para a IA': 'Voltou para a IA (vendedora não escreveu)', urgente_com_vendedora: 'Ficou com ela como URGENTE (venda depende dela)' }

// colunas por dia de uma taxa; dias com robô em azul, antes em cinza
function Serie({ serie, inicio, campo, titulo, so_completo }) {
  const dias = serie.filter((d) => !so_completo || d.pago_completo)
  const v = dias.map((d) => (d.leads ? (100 * d[campo]) / d.leads : 0))
  const max = Math.max(...v, 0.01)
  return (
    <div className="ri-serie">
      <p className="section-label robo-sub">{titulo}</p>
      <div className="ri-cols">
        {dias.map((d, i) => (
          <div key={d.dia} className="ri-col-w" title={`${new Date(d.dia + 'T12:00').toLocaleDateString('pt-BR')} · ${v[i].toFixed(2)}% (${d[campo]} de ${d.leads} leads)`}>
            <div className={`ri-col ${d.dia >= inicio ? 'ri-robo' : ''}`} style={{ height: `${(v[i] / max) * 100}%` }} />
            <span className="ri-col-lbl">{d.dia.slice(8, 10)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function RoboImpacto() {
  const [dias, setDias] = useState(7)
  const [d, setD] = useState(null)
  const [erro, setErro] = useState(null)
  useEffect(() => {
    setD(null)
    fetch(`/api/dashboard?type=robo_impacto&dias=${dias}`).then((r) => r.json())
      .then((x) => { const v = x?.data ?? x; if (v?.serie) setD(v); else setErro(x?.error || 'falha') })
      .catch((e) => setErro(e.message))
  }, [dias])
  if (erro) return <div className="state-msg error">Erro: {erro}</div>
  if (!d) return <div className="home-vazio">calculando impacto...</div>

  const p = d.passagens || {}, ia = d.ia_calado || {}
  const audTot = (d.audio || []).reduce((s, a) => s + a.n, 0), audResp = (d.audio || []).reduce((s, a) => s + a.respondeu, 0)
  const seg = [['Vendedora escreveu', p.vend_escreveu, 'ri-s1'], ['Outra pessoa escreveu', p.outra_escreveu, 'ri-s2'],
    ['Ninguém escreveu · cliente calado', p.ninguem_calado, 'ri-s3'], ['Ninguém escreveu · cliente mandou msg', p.ninguem_cliente_msg, 'ri-s4']]
  const comp = [['Ficou com a IA (cliente calado 30 min)', ia.digitou, ia.total, 'ri-cinza'],
    ['Passado para vendedora (todos)', p.dig_total, p.total, 'ri-laranja'],
    ['…em que a vendedora escreveu', p.dig_vend_escreveu, p.vend_escreveu, 'ri-azul'],
    ['…em que ninguém escreveu', p.dig_ninguem, (p.ninguem_calado || 0) + (p.ninguem_cliente_msg || 0), 'ri-vermelho']]
  const maxComp = Math.max(...comp.map(([, a, b]) => (b ? a / b : 0)), 0.001)
  const vig = d.vigia || {}, vigTot = Object.values(vig).reduce((s, n) => s + n, 0)

  return (
    <div className="rq ri">
      <div className="rq-topo rq-periodo">
        <p className="section-label">Impacto do robô · passagens, resposta e conversão</p>
        <div className="rq-dias">
          {[1, 7, 30].map((n) => <button key={n} className={`reset-btn ${dias === n ? 'rc-on' : ''}`} onClick={() => setDias(n)}>{n === 1 ? 'Hoje' : `${n} dias`}</button>)}
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi"><p className="kpi-label">Passados para vendedora</p><p className="kpi-value">{p.total ?? 0}</p></div>
        <div className="kpi"><p className="kpi-label">Ninguém escreveu depois</p>
          <p className={`kpi-value ${p.total && (p.ninguem_calado + p.ninguem_cliente_msg) / p.total > 0.3 ? 'alerta' : ''}`}>{pct((p.ninguem_calado || 0) + (p.ninguem_cliente_msg || 0), p.total, 0)}%</p></div>
        <div className="kpi"><p className="kpi-label">Digitou · vendedora escreveu</p><p className="kpi-value accent">{pct(p.dig_vend_escreveu, p.vend_escreveu)}%</p></div>
        <div className="kpi"><p className="kpi-label">Digitou · ficou com a IA</p><p className="kpi-value">{pct(ia.digitou, ia.total)}%</p></div>
        <div className="kpi"><p className="kpi-label">Cliente respondeu ao áudio</p><p className="kpi-value">{pct(audResp, audTot, 0)}%<small> de {audTot}</small></p></div>
      </div>

      <section className="panel">
        <p className="section-label">Antes x depois · todos os leads da VendeAI (azul = com robô, desde {new Date(d.inicio_robo + 'T12:00').toLocaleDateString('pt-BR')})</p>
        <div className="rq-graficos">
          <Serie serie={d.serie} inicio={d.inicio_robo} campo="digitadas" titulo="% dos leads com proposta digitada, por dia" />
          <Serie serie={d.serie} inicio={d.inicio_robo} campo="pagas_2d" titulo="% dos leads pagos em até 2 dias (dias completos)" so_completo />
        </div>
        <p className="home-vazio">Variação de dia para dia é normal (dia da semana, tabelas dos bancos); compare semanas, não dias isolados.</p>
      </section>

      <section className="panel">
        <p className="section-label">O que aconteceu depois que o robô passou para a vendedora · {p.total ?? 0} atendimentos</p>
        <div className="ri-stack">
          {seg.map(([l, n, cls]) => n ? <div key={l} className={`ri-seg ${cls}`} style={{ flex: n }} title={`${l}: ${n} (${pct(n, p.total, 0)}%)`} /> : null)}
        </div>
        <div className="rq-legenda ri-leg">
          {seg.map(([l, n, cls]) => <span key={l}><i className={`rq-cor ${cls}`} />{l} · {n ?? 0} ({pct(n, p.total, 0)}%)</span>)}
        </div>

        <p className="section-label robo-sub">Comparação justa · % que virou proposta digitada (cliente calado há 30 min)</p>
        {comp.map(([l, a, b, cls]) => (
          <div key={l} className="rq-crit ri-comp" title={`${l}: ${a ?? 0} de ${b ?? 0}`}>
            <span className="rq-crit-nome">{l}</span>
            <div className="rq-barra-linha">
              <div className={`rq-barra ${cls}`} style={{ width: `${b ? Math.max(((a / b) / maxComp) * 85, 1) : 0}%` }} />
              <span className="rq-barra-val">{pct(a, b)}% · {a ?? 0}/{b ?? 0}</span>
            </div>
          </div>
        ))}
      </section>

      <section className="panel table-panel">
        <p className="section-label">Por vendedora · atendimentos passados pelo robô</p>
        <div className="scroll-table">
          <table className="robo-desemp">
            <thead><tr><th>Vendedora</th><th>Recebeu</th><th>Não escreveu</th><th>Tempo até escrever (mediana)</th><th>Digitou</th><th>Pagou</th></tr></thead>
            <tbody>
              {(d.por_vendedora || []).map((v) => {
                const t = v.recebeu ? v.nao_escreveu / v.recebeu : 0
                return (
                  <tr key={v.vendedora}>
                    <td>{v.vendedora}</td><td>{v.recebeu}</td>
                    <td className={`robo-taxa ${t > 0.5 ? 'ruim' : t > 0.25 ? 'medio' : 'ok'}`}>{pct(v.nao_escreveu, v.recebeu, 0)}% ({v.nao_escreveu})</td>
                    <td>{v.mediana_min != null ? `${v.mediana_min} min` : '—'}</td><td>{v.digitou} ({pct(v.digitou, v.recebeu)}%)</td><td>{v.pagou}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {!(d.por_vendedora || []).length && <p className="home-vazio">Nenhuma passagem no período.</p>}
        </div>
      </section>

      <div className="rq-graficos">
        <section className="panel table-panel">
          <p className="section-label">Áudio do robô · o cliente respondeu?</p>
          <table className="robo-desemp">
            <thead><tr><th>Caso</th><th>Clientes</th><th>Respondeu</th><th>Digitou depois</th></tr></thead>
            <tbody>
              {(d.audio || []).map((a) => (
                <tr key={a.caso}><td>{NOME_CASO[a.caso] || a.caso}</td><td>{a.n}</td><td>{pct(a.respondeu, a.n, 0)}%</td><td>{pct(a.digitou, a.n)}%</td></tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="panel table-panel">
          <p className="section-label">Vigia de 20 min depois da passagem (desde 05/10, 20h)</p>
          <table className="robo-desemp">
            <tbody>
              {Object.entries(vig).map(([k, n]) => <tr key={k}><td>{NOME_VIGIA[k] || k}</td><td>{n}</td><td>{pct(n, vigTot, 0)}%</td></tr>)}
            </tbody>
          </table>
          {!vigTot && <p className="home-vazio">Ainda sem casos (começa a contar na próxima passagem).</p>}
        </section>
      </div>
    </div>
  )
}
