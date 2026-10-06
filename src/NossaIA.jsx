import React, { useEffect, useState } from 'react'
import { DateRangeFilter, presetRange } from './App'

// Nossa IA (Fase 3) em modo sombra: nas transferências da IA da VendeAI (resimulação, limite de iterações,
// objeção) ela decide o que faria, sem enviar nada. Aqui: o que decidiu, o custo e o que aconteceu de verdade
// (RPC dashboard_nossa_ia).

const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0)
const usd = (v) => `US$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`
const NOME_ACAO = { responder: 'Responder', simular: 'Ressimular', passar_vendedora: 'Passar p/ vendedora', encerrar: 'Encerrar', aguardar: 'Aguardar', erro: 'Erro' }
const NOME_REAL = { ia_vendeai: 'IA VendeAI', humano: 'Pessoa', ninguem: 'Ninguém' }
// IA da VendeAI calada (robô v68+): motivo pela nota privada da IA e para onde o caso foi
const NOME_GRUPO = { simulando: 'Simulação em andamento', nao_autorizou: 'Não autorizou (C6)', proposta_andamento: 'Proposta em andamento',
  tabela: 'Tabela selecionada', instabilidade: 'Instabilidade do banco', outro: 'Outro motivo', sem_nota: 'Sem nota' }
const NOME_DESTINO = { ia_vendeai: 'IA VendeAI voltou', hotline: 'Hotline', vendedora: 'Vendedora', aguardando: 'Aguardando',
  robo_hotline: 'Hotline', ninguem: 'Ninguém', encerrado: 'Encerrado', outro: 'Outro' }
const hora = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const link = (id) => `https://crm.vendeaitecnologia.com.br/app/accounts/75/conversations/${id}`

// Cliente escreveu e a IA da VendeAI não respondeu: por motivo, quantas vezes ela voltou sozinha, quantas foram
// para a Hotline/vendedora e se alguém respondeu depois. Base para decidir quem fica com cada motivo.
function IaCalada({ ic }) {
  const grupos = ic.grupos || []
  return (
    <section className="panel table-panel">
      <p className="section-label">IA da VendeAI calada · cliente esperando ({ic.casos} casos)</p>
      <p className="home-vazio ri-aviso">O robô espera um tempo por motivo (simulação em andamento 25 min; não autorizou e outros 20 min) antes de passar.
        "IA voltou" = a IA da VendeAI respondeu dentro desse prazo. Urgentes (ticket alto, ofertado, assinatura, pendência) vão para a vendedora.</p>
      <div className="scroll-table">
        <table className="robo-desemp">
          <thead><tr><th>Motivo (nota da IA)</th><th>Casos</th><th>IA voltou</th><th>Hotline</th><th>Hotline respondeu</th>
            <th>Vendedora</th><th>Vendedora respondeu</th><th>Aguardando</th><th>Outros</th></tr></thead>
          <tbody>{grupos.map((g) => (
            <tr key={g.grupo}>
              <td>{NOME_GRUPO[g.grupo] ?? g.grupo}</td><td>{g.casos}</td>
              <td>{g.ia_voltou}{g.ia_min != null ? ` (~${g.ia_min} min)` : ''}</td>
              <td>{g.hotline}</td><td>{g.hotline ? `${g.hotline_resp}${g.hotline_min != null ? ` (~${g.hotline_min} min)` : ''}` : '—'}</td>
              <td>{g.vendedora}</td><td>{g.vendedora ? g.vendedora_resp : '—'}</td>
              <td>{g.aguardando}</td><td>{g.outros}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="ni-lista">
        {(ic.ultimos || []).slice(0, 20).map((u) => (
          <div key={`${u.conversation_id}-${u.em}`} className="ni-item">
            <div className="ni-cab">
              <a href={link(u.conversation_id)} target="_blank" rel="noreferrer">#{u.conversation_id}</a>
              <span>{hora(u.em)}</span><span className="ni-mot">{NOME_GRUPO[u.grupo] ?? u.grupo}</span>
              <span className="ni-acao">{NOME_DESTINO[u.destino] ?? u.destino}{u.min_resp != null ? ` em ${u.min_resp} min` : ''}</span>
              {u.resp_min != null && <span className="ni-ok">respondido {u.resp_min} min depois</span>}
            </div>
            {u.nota && <p className="ni-porque">{u.nota}</p>}
            {u.motivo_fim && <p className="ni-real">Robô: {u.motivo_fim}</p>}
          </div>
        ))}
      </div>
    </section>
  )
}

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
        aguardar ou encerrar. Nada é enviado ao cliente. "Concorda" compara a decisão com o que foi feito de verdade antes de o
        cliente escrever de novo: ressimular = mandaram nova simulação (R$ + parcelas); passar = uma pessoa assumiu; responder = responderam
        sem simular; aguardar = ninguém respondeu.</p>

      <div className="kpi-grid">
        <div className="kpi"><p className="kpi-label">Conversas</p><p className="kpi-value">{d.conversas}</p></div>
        <div className="kpi"><p className="kpi-label">Decisões</p><p className="kpi-value">{d.turnos}</p></div>
        <div className="kpi"><p className="kpi-label">Concorda com o real</p><p className="kpi-value accent">{pct(d.concorda, d.com_real)}%</p>
          <p className="kpi-sub">{d.concorda} de {d.com_real} com resposta real</p></div>
        <div className="kpi"><p className="kpi-label">Custo no período</p><p className="kpi-value">{usd(d.custo)}</p>
          <p className="kpi-sub">{d.turnos ? usd(d.custo / d.turnos) : '—'} por decisão · {d.erros} erro(s)</p></div>
      </div>

      {d.ia_calada && <IaCalada ic={d.ia_calada} />}

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
