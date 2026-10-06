import React, { useEffect, useState } from 'react'
import { DateRangeFilter, presetRange } from './App'

// Nossa IA (Fase 3) em modo sombra: nas transferências da IA da VendeAI (resimulação, limite de iterações,
// objeção) ela decide o que faria, sem enviar nada. Aqui: o que decidiu, o custo e o que aconteceu de verdade
// (RPC dashboard_nossa_ia).

const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0)
const usd = (v) => `US$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`
const NOME_ACAO = { responder: 'Responder', simular: 'Ressimular', passar_vendedora: 'Passar p/ vendedora', encerrar: 'Encerrar', aguardar: 'Aguardar', erro: 'Erro' }
const NOME_REAL = { ia_vendeai: 'IA VendeAI', humano: 'Pessoa', ninguem: 'Ninguém' }
const hora = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const link = (id) => `https://crm.vendeaitecnologia.com.br/app/accounts/75/conversations/${id}`

export default function NossaIA() {
  const [de, setDe] = useState(() => presetRange('esta_semana').from)
  const [ate, setAte] = useState(() => presetRange('esta_semana').to)
  const [d, setD] = useState(null)
  const [erro, setErro] = useState(null)
  const [filtro, setFiltro] = useState('')
  useEffect(() => {
    if (!de || !ate) return
    setD(null); setErro(null)
    fetch(`/api/dashboard?type=nossa_ia&de=${de}&ate=${ate}`).then((r) => r.json())
      .then((x) => { const v = x?.data ?? x; if (v && 'turnos' in v) setD(v); else setErro(x?.error || 'falha') })
      .catch((e) => setErro(e.message))
  }, [de, ate])

  const topo = (
    <div className="rq-topo rq-periodo">
      <p className="section-label">Nossa IA · modo sombra (decide, mas não envia)</p>
      <DateRangeFilter dataInicio={de} setDataInicio={setDe} dataFim={ate} setDataFim={setAte} />
    </div>
  )
  if (erro) return <div className="rq ri">{topo}<div className="state-msg error">Erro: {erro}</div></div>
  if (!d) return <div className="rq ri">{topo}<div className="home-vazio">carregando...</div></div>

  const ultimos = (d.ultimos || []).filter((u) => !filtro || u.acao === filtro)
  return (
    <div className="rq ri">
      {topo}
      <p className="home-vazio ri-aviso">Em cada transferência da IA da VendeAI, a nossa IA lê a conversa e decide: responder, ressimular, passar para a vendedora,
        aguardar ou encerrar. Nada é enviado ao cliente. "Concorda" compara a decisão com quem respondeu de verdade
        (responder/ressimular = a IA da VendeAI seguiu; passar = uma pessoa respondeu).</p>

      <div className="kpi-grid">
        <div className="kpi"><p className="kpi-label">Conversas</p><p className="kpi-value">{d.conversas}</p></div>
        <div className="kpi"><p className="kpi-label">Decisões</p><p className="kpi-value">{d.turnos}</p></div>
        <div className="kpi"><p className="kpi-label">Concorda com o real</p><p className="kpi-value accent">{pct(d.concorda, d.com_real)}%</p>
          <p className="kpi-sub">{d.concorda} de {d.com_real} com resposta real</p></div>
        <div className="kpi"><p className="kpi-label">Custo no período</p><p className="kpi-value">{usd(d.custo)}</p>
          <p className="kpi-sub">{d.turnos ? usd(d.custo / d.turnos) : '—'} por decisão · {d.erros} erro(s)</p></div>
      </div>

      <section className="panel table-panel">
        <p className="section-label">Decisão x o que aconteceu de verdade</p>
        <div className="scroll-table">
          <table className="robo-desemp">
            <thead><tr><th>Nossa IA decidiu</th><th>Qtd</th><th>IA VendeAI respondeu</th><th>Pessoa respondeu</th><th>Ninguém respondeu</th></tr></thead>
            <tbody>{(d.acoes || []).map((a) => (
              <tr key={a.acao}><td>{NOME_ACAO[a.acao] ?? a.acao}</td><td>{a.qtd}</td><td>{a.real_ia}</td><td>{a.real_humano}</td><td>{a.real_ninguem}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      <section className="panel table-panel">
        <p className="section-label">Por motivo da transferência</p>
        <div className="scroll-table">
          <table className="robo-desemp">
            <thead><tr><th>Motivo</th><th>Conversas</th><th>Decisões</th><th>Responder</th><th>Ressimular</th><th>Vendedora</th><th>Outros</th><th>Custo</th></tr></thead>
            <tbody>{(d.motivos || []).map((m) => (
              <tr key={m.motivo}><td>{m.motivo}</td><td>{m.sessoes}</td><td>{m.turnos}</td><td>{m.responder}</td><td>{m.simular}</td>
                <td>{m.vendedora}</td><td>{m.outros}</td><td>{usd(m.custo)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      <section className="panel table-panel">
        <div className="rq-topo">
          <p className="section-label">Últimas decisões</p>
          <select className="ni-filtro" value={filtro} onChange={(e) => setFiltro(e.target.value)}>
            <option value="">Todas</option>
            {Object.entries(NOME_ACAO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="ni-lista">
          {ultimos.map((u, i) => (
            <div key={i} className="ni-item">
              <div className="ni-cab">
                <a href={link(u.conversation_id)} target="_blank" rel="noreferrer">#{u.conversation_id}</a>
                <span>{hora(u.em)}</span><span className="ni-mot">{u.motivo}</span>
                <span className={`ni-acao ni-${u.acao}`}>{NOME_ACAO[u.acao] ?? u.acao}</span>
                {u.concorda != null && <span className={u.concorda ? 'ni-ok' : 'ni-nao'}>{u.concorda ? '✓ concorda' : '✗ diferente'}</span>}
              </div>
              <p className="ni-cli"><b>Cliente:</b> {u.entrada}</p>
              {u.texto && <p className="ni-nos"><b>Nossa IA diria:</b> {u.texto}</p>}
              <p className="ni-porque">{u.porque}{u.confianca != null ? ` (confiança ${Math.round(u.confianca * 100)}%)` : ''}</p>
              {u.real_quem && <p className="ni-real"><b>{u.real_quem} respondeu:</b> {u.real_resposta}</p>}
            </div>
          ))}
          {!ultimos.length && <p className="home-vazio">nenhuma decisão no período</p>}
        </div>
      </section>
    </div>
  )
}
