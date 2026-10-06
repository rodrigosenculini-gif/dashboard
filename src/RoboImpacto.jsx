import React, { useEffect, useState } from 'react'
import { DateRangeFilter, presetRange } from './App'

// Impacto do robô de follow-up na conversão: antes x depois, resposta ao áudio do robô e o que acontece
// quando ele passa o atendimento para a vendedora (RPC dashboard_robo_impacto / dashboard_robo_impacto_periodo).

const pct = (a, b, c = 1) => (b ? ((100 * a) / b).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c }) : '—')
const num = (v, c = 2) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c }))
const NOME_CASO = { ticket_alto: 'Ticket alto', ofertado: 'Ofertado', cliente_sumiu: 'Cliente sumiu', assinatura: 'Assinatura', pendencia: 'Pendência' }
const NOME_VIGIA = { 'vendedora escreveu': 'Vendedora escreveu em até 20 min', 'devolvido para a IA': 'Voltou para a IA (vendedora não escreveu)', urgente_com_vendedora: 'Ficou com ela como URGENTE (venda depende dela)' }
const br = (iso) => (iso ? new Date(iso.slice(0, 10) + 'T12:00').toLocaleDateString('pt-BR') : '')

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
          <div key={d.dia} className="ri-col-w" title={`${br(d.dia)} · ${v[i].toFixed(2)}% (${d[campo]} de ${d.leads} leads)`}>
            <div className={`ri-col ${d.dia >= inicio ? 'ri-robo' : ''}`} style={{ height: `${(v[i] / max) * 100}%` }} />
            <span className="ri-col-lbl">{d.dia.slice(8, 10)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// tudo o que cada vendedora recebeu, de qualquer origem (VendeAI, robô/Hotline, colega, ela mesma)
function AtendimentoGeral({ de, ate }) {
  const [d, setD] = useState(null)
  useEffect(() => {
    if (!de || !ate) return
    setD(null)
    fetch(`/api/dashboard?type=vendedoras_atendimento&de=${de}&ate=${ate}`).then((r) => r.json())
      .then((x) => setD(x?.data ?? x)).catch(() => setD({ por_vendedora: [] }))
  }, [de, ate])
  const lista = d?.por_vendedora || []
  return (
    <section className="panel table-panel">
      <p className="section-label">Por vendedora · tudo o que ela recebeu (qualquer origem){d?.desde ? ` · desde ${new Date(d.desde).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}</p>
      {!d ? <p className="home-vazio">carregando...</p> : (
        <div className="scroll-table">
          <table className="robo-desemp">
            <thead><tr>
              <th>Vendedora</th><th>Recebeu</th>
              <th title="Distribuição automática da VendeAI (política) ou a IA da VendeAI passou">VendeAI</th>
              <th title="Robô de follow-up ou alguém no login Hotline">Robô/Hotline</th>
              <th title="Uma colega passou para ela">Colega</th><th title="Ela mesma pegou a conversa">Ela mesma</th>
              <th>Não escreveu</th>
              <th title="O cliente mandou mensagem depois, ela não escreveu e a conversa continuou com ela">↳ cliente sem resposta</th>
              <th title="Ela devolveu para a IA da VendeAI sem escrever">↳ devolveu à IA</th>
              <th title="Saiu dela (outra pessoa, IA ou robô) antes de ela escrever">↳ saiu antes</th>
              <th>Tempo até escrever (mediana)</th><th>Digitou</th>
            </tr></thead>
            <tbody>
              {lista.map((v) => {
                const t = v.recebeu ? v.nao_escreveu / v.recebeu : 0
                return (
                  <tr key={v.vendedora}>
                    <td>{v.vendedora}</td><td>{v.recebeu}</td><td>{v.de_vendeai}</td><td>{v.do_robo}</td><td>{v.de_colega}</td><td>{v.ela_mesma}</td>
                    <td className={`robo-taxa ${t > 0.5 ? 'ruim' : t > 0.25 ? 'medio' : 'ok'}`}>{pct(v.nao_escreveu, v.recebeu, 0)}% ({v.nao_escreveu})</td>
                    <td className={v.cliente_sem_resposta ? 'robo-taxa ruim' : ''}>{v.cliente_sem_resposta}</td>
                    <td>{v.devolveu_ia}</td><td>{v.saiu_antes}</td>
                    <td>{v.mediana_min != null ? `${v.mediana_min} min` : '—'}</td><td>{v.digitou} ({pct(v.digitou, v.recebeu)}%)</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {!lista.length && <p className="home-vazio">Nenhuma atribuição no período.</p>}
          <p className="home-vazio">Atribuições que duraram menos de 2 min sem ela escrever não contam (a VendeAI distribui o lead novo e a IA dela pega de volta no mesmo segundo).</p>
        </div>
      )}
    </section>
  )
}

export default function RoboImpacto() {
  // filtro de datas padrão do painel; abre sempre na semana atual
  const [de, setDe] = useState(() => presetRange('esta_semana').from)
  const [ate, setAte] = useState(() => presetRange('esta_semana').to)
  const [d, setD] = useState(null)
  const [erro, setErro] = useState(null)
  useEffect(() => {
    if (!de || !ate) return // calendário no meio da escolha (1º clique) ou limpo
    setD(null); setErro(null)
    fetch(`/api/dashboard?type=robo_impacto&de=${de}&ate=${ate}`).then((r) => r.json())
      .then((x) => { const v = x?.data ?? x; if (v?.serie) setD(v); else setErro(x?.error || 'falha') })
      .catch((e) => setErro(e.message))
  }, [de, ate])

  const topo = (
    <div className="rq-topo rq-periodo">
      <p className="section-label">Impacto do robô · passagens, resposta e conversão</p>
      <DateRangeFilter dataInicio={de} setDataInicio={setDe} dataFim={ate} setDataFim={setAte} />
    </div>
  )
  if (erro) return <div className="rq ri">{topo}<div className="state-msg error">Erro: {erro}</div></div>
  if (!d) return <div className="rq ri">{topo}<div className="home-vazio">calculando impacto...</div></div>

  const p = d.passagens || {}, ia = d.ia_calado || {}
  const ninguem = (p.ninguem_calado || 0) + (p.ninguem_cliente_msg || 0)
  const audTot = (d.audio || []).reduce((s, a) => s + a.n, 0), audResp = (d.audio || []).reduce((s, a) => s + a.respondeu, 0)
  const seg = [['Vendedora escreveu', p.vend_escreveu, 'ri-s1'], ['Outra pessoa escreveu', p.outra_escreveu, 'ri-s2'],
    ['Ninguém escreveu · cliente calado', p.ninguem_calado, 'ri-s3'], ['Ninguém escreveu · cliente mandou msg', p.ninguem_cliente_msg, 'ri-s4']]
  const comp = [['Ficou com a IA (cliente calado 30 min)', ia.digitou, ia.total, 'ri-cinza'],
    ['Passado para vendedora (todos)', p.dig_total, p.total, 'ri-laranja'],
    ['…em que a vendedora escreveu', p.dig_vend_escreveu, p.vend_escreveu, 'ri-azul'],
    ['…em que ninguém escreveu', p.dig_ninguem, ninguem, 'ri-vermelho']]
  const maxComp = Math.max(...comp.map(([, a, b]) => (b ? a / b : 0)), 0.001)
  const vig = d.vigia || {}, vigTot = Object.values(vig).reduce((s, n) => s + n, 0)
  const med = Object.fromEntries((d.medias || []).map((m) => [m.periodo, m]))
  const antes = med['antes do robô'], depois = med['com robô']
  const cortado = d.msgs_desde && d.de && d.msgs_desde.slice(0, 10) > d.de

  return (
    <div className="rq ri">
      {topo}
      {cortado && <p className="home-vazio ri-aviso">Passagens, quem escreveu, devolveu ou digitou depois são medidos a partir de {br(d.captura_desde)} 11h, quando a captura das mensagens ficou completa. Antes disso as mensagens não estão gravadas e tudo apareceria como "não escreveu".</p>}

      <div className="kpi-grid">
        <div className="kpi"><p className="kpi-label">Passados para vendedora</p><p className="kpi-value">{p.total ?? 0}</p></div>
        <div className="kpi"><p className="kpi-label">Ninguém escreveu depois</p>
          <p className={`kpi-value ${p.total && ninguem / p.total > 0.3 ? 'alerta' : ''}`}>{pct(ninguem, p.total, 0)}%</p></div>
        <div className="kpi"><p className="kpi-label">Digitou · vendedora escreveu</p><p className="kpi-value accent">{pct(p.dig_vend_escreveu, p.vend_escreveu)}%</p></div>
        <div className="kpi"><p className="kpi-label">Digitou · ficou com a IA</p><p className="kpi-value">{pct(ia.digitou, ia.total)}%</p></div>
        <div className="kpi"><p className="kpi-label">Cliente respondeu ao áudio</p><p className="kpi-value">{pct(audResp, audTot, 0)}%<small> de {audTot}</small></p></div>
      </div>

      <section className="panel">
        <p className="section-label">Antes x depois · todos os leads da VendeAI (azul = com robô, desde {br(d.inicio_robo)})</p>
        {antes && depois && (
          <div className="ri-medias">
            <div><span className="ri-medias-t">Antes do robô · {antes.dias} dias</span><b>{num(antes.pct_digitadas)}%</b> com proposta digitada · <b>{num(antes.pct_pagas_2d)}%</b> pagos em 2 dias</div>
            <div className="ri-medias-robo"><span className="ri-medias-t">Com robô · {depois.dias} dias</span><b>{num(depois.pct_digitadas)}%</b> com proposta digitada · <b>{num(depois.pct_pagas_2d)}%</b> pagos em 2 dias</div>
          </div>
        )}
        <div className="rq-graficos">
          <Serie serie={d.serie} inicio={d.inicio_robo} campo="digitadas" titulo="% dos leads do dia com proposta digitada" />
          <Serie serie={d.serie} inicio={d.inicio_robo} campo="pagas_2d" titulo="% dos leads do dia pagos em até 2 dias (só dias já fechados)" so_completo />
        </div>
        <p className="home-vazio">Cada coluna é um dia: clientes com proposta digitada naquele dia ÷ leads novos que chegaram naquele dia. Compare as médias acima (vários dias juntos), não dias isolados: fim de semana e tabela dos bancos mudam muito de um dia para o outro.</p>
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
        <p className="section-label">Por vendedora · só o que o robô passou para ela</p>
        <div className="scroll-table">
          <table className="robo-desemp">
            <thead><tr><th>Vendedora</th><th title="Atendimentos atribuídos a ela por qualquer origem (VendeAI, robô, colegas) — referência">Recebeu ao todo</th>
              <th title="Atendimentos que o robô passou para ela (base das colunas seguintes)">Recebeu do robô</th><th>Não escreveu</th>
              <th title="Ela mesma devolveu para a IA da VendeAI sem escrever">↳ ela devolveu à IA</th>
              <th title="O robô tirou dela ou devolveu à IA antes de ela escrever">↳ robô tirou</th>
              <th>Tempo até escrever (mediana)</th><th>Digitou</th><th>Pagou</th></tr></thead>
            <tbody>
              {(d.por_vendedora || []).map((v) => {
                const t = v.recebeu ? v.nao_escreveu / v.recebeu : 0
                return (
                  <tr key={v.vendedora}>
                    <td>{v.vendedora}</td><td>{v.recebeu_total ?? '—'}</td><td>{v.recebeu}</td>
                    <td className={`robo-taxa ${t > 0.5 ? 'ruim' : t > 0.25 ? 'medio' : 'ok'}`}>{pct(v.nao_escreveu, v.recebeu, 0)}% ({v.nao_escreveu})</td>
                    <td>{v.devolveu_ia || 0}</td><td>{v.robo_tirou || 0}</td>
                    <td>{v.mediana_min != null ? `${v.mediana_min} min` : '—'}</td><td>{v.digitou} ({pct(v.digitou, v.recebeu)}%)</td><td>{v.pagou}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {!(d.por_vendedora || []).length && <p className="home-vazio">Nenhuma passagem no período.</p>}
        </div>
      </section>

      <AtendimentoGeral de={de} ate={ate} />

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
          <p className="section-label">Vigia de 20 min depois da passagem</p>
          <table className="robo-desemp">
            <tbody>
              {Object.entries(vig).map(([k, n]) => <tr key={k}><td>{NOME_VIGIA[k] || k}</td><td>{n}</td><td>{pct(n, vigTot, 0)}%</td></tr>)}
            </tbody>
          </table>
          {!vigTot && <p className="home-vazio">Sem casos no período.</p>}
        </section>
      </div>
    </div>
  )
}
