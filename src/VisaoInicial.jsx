import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ResponsiveContainer, AreaChart, Area, Tooltip, XAxis } from 'recharts'
import { callApi, useRevisaoCache, TTL_MS } from './dadosCache'

const REFRESH_MS = TTL_MS

const getJson = (type, params = {}, opts) => callApi(type, params, opts)

const n = (v) => (v === null || v === undefined ? 0 : Number(v))
const fInt = (v) => n(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 })
const fMoney = (v) => n(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })
const fPct = (v) => `${n(v).toFixed(1).replace('.', ',')}%`
const fPts = (v) => `${n(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} pts`
const fHora = (d) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

function Spark({ data, cor, id }) {
  if (!data?.length) return <div className="home-spark-vazio" />
  return (
    <div className="home-spark">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={cor} stopOpacity={0.45} />
              <stop offset="100%" stopColor={cor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="dia" hide />
          <Tooltip
            cursor={{ stroke: 'var(--border)' }}
            contentStyle={{
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              borderRadius: 8, fontFamily: 'var(--font-mono)', fontSize: 11, padding: '6px 9px',
            }}
            labelStyle={{ color: 'var(--muted)', fontSize: 10.5 }}
            labelFormatter={(d) => String(d).split('-').reverse().join('/')}
            formatter={(v) => [fInt(v), '']}
          />
          <Area type="monotone" dataKey="v" stroke={cor} strokeWidth={1.6} fill={`url(#${id})`} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function Metrica({ label, valor, sub, tom, largo }) {
  // valores longos (R$ 13.692.698) encolhem em vez de estourar o cartao
  const comp = String(valor).length
  const escala = comp > 15 ? 'muito-longo' : comp > 11 ? 'longo' : ''
  return (
    <div className={`home-metrica ${largo ? 'largo' : ''}`}>
      <span className="home-metrica-label">{label}</span>
      <span className={`home-metrica-valor ${escala} ${tom || ''}`}>{valor}</span>
      {sub && <span className="home-metrica-sub">{sub}</span>}
    </div>
  )
}

function Painel({ titulo, cor, sparkId, serie, onAbrir, children, acao }) {
  return (
    <section className="home-painel">
      <header className="home-painel-top">
        <button className="home-painel-titulo" onClick={onAbrir} title={`Abrir ${titulo}`}>
          <span className="home-painel-marca" style={{ background: cor }} />
          {titulo}
          <span className="home-painel-seta" aria-hidden="true">&rsaquo;</span>
        </button>
        {acao}
      </header>
      <Spark data={serie} cor={cor} id={sparkId} />
      <div className="home-metricas">{children}</div>
    </section>
  )
}

export default function VisaoInicial({ onIrPara, onAbrirTrello, onAbrirChips, views, acoes }) {
  const [dados, setDados] = useState(null)
  const [erro, setErro] = useState(null)
  const [carregando, setCarregando] = useState(true)
  const [atualizadoEm, setAtualizadoEm] = useState(null)
  // ranking das vendedoras: valor ou pontos
  const [modo, setModo] = useState('valor')

  const revisaoCache = useRevisaoCache()

  const carregar = useCallback(async (opts) => {
    setCarregando(true)
    setErro(null)
    try {
      setDados(await getJson('home', {}, opts))
      setAtualizadoEm(new Date())
    } catch (e) {
      setErro(e.message || 'Não foi possível carregar os indicadores.')
    } finally {
      setCarregando(false)
    }
  }, [revisaoCache])

  useEffect(() => { carregar() }, [carregar])
  useEffect(() => {
    const id = setInterval(carregar, REFRESH_MS)
    return () => clearInterval(id)
  }, [carregar])

  const d = dados || {}
  const disp = d.disparos || {}
  const ent = d.entradas || {}
  const vdd = d.vendedoras || {}
  const vnd = d.vendas || {}
  const emPontos = modo === 'ponto'

  const ranking = useMemo(() => {
    const lista = [...(vdd.ranking || [])]
    lista.sort((a, b) => n(emPontos ? b.pontos : b.valor) - n(emPontos ? a.pontos : a.valor))
    return lista.slice(0, 5)
  }, [vdd.ranking, emPontos])

  const topo = n(emPontos ? ranking[0]?.pontos : ranking[0]?.valor) || 1
  const diaLabel = d.dia ? String(d.dia).split('-').reverse().join('/') : ''

  return (
    <>
      <div className="topbar">
        <h1><span className="pulse" /> Geral &mdash; Hotline</h1>
        <div className="topbar-right">
          <span className="status-line">
            {carregando ? 'atualizando...' : atualizadoEm ? `KPIs de hoje (${diaLabel}) · gráficos do mês · atualizado às ${fHora(atualizadoEm)}` : ''}
          </span>
          <button className="refresh-btn" onClick={() => carregar({ forcar: true })} disabled={carregando} title="Atualizar agora">
            &#8635; Atualizar
          </button>
          {acoes}
        </div>
      </div>

      {erro && <div className="state-msg error">Erro: {erro}</div>}

      <nav className="home-atalhos" aria-label="Ir para uma view">
        {views.map((v) => (
          <button key={v.id} className="home-atalho" onClick={() => onIrPara(v.id)}>{v.label}</button>
        ))}
      </nav>

      <div className="home-blocos">
        <button className="home-bloco home-bloco-trello" onClick={onAbrirTrello}>
          <span className="home-bloco-icone" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <path d="M8 7v7M16 7v4" />
            </svg>
          </span>
          <span className="home-bloco-texto">
            <strong>Trello</strong>
            <small>Tarefas e andamento do projeto</small>
          </span>
        </button>

        <button className="home-bloco home-bloco-chips" onClick={onAbrirChips}>
          <span className="home-bloco-icone" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <rect x="5" y="5" width="14" height="14" rx="2.5" />
              <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
              <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
            </svg>
          </span>
          <span className="home-bloco-texto">
            <strong>Chips</strong>
            <small>WhatsApp, conexões e recargas</small>
          </span>
        </button>
      </div>

      <div className="home-grid">
        <Painel titulo="Disparos" cor="var(--rose)" sparkId="sparkDisparos"
                serie={disp.serie} onAbrir={() => onIrPara('disparos')}>
          <Metrica label="Total leads" valor={fInt(disp.total_leads)} />
          <Metrica label="Interação" valor={fPct(disp.interacao_pct)} />
          <Metrica label="Conversão" valor={fPct(disp.conversao_pct)} tom="destaque" />
          <Metrica label="Pagas" valor={fInt(disp.pagas)} />
          <Metrica label="Valor pago" valor={fMoney(disp.valor_pago)} largo />
        </Painel>

        <Painel titulo="Entrada de leads" cor="var(--gold)" sparkId="sparkEntradas"
                serie={ent.serie} onAbrir={() => onIrPara('produtos')}>
          <Metrica label="Entradas" valor={fInt(ent.total)} />
          <Metrica label="Interação" valor={fPct(ent.interacao_pct)} />
          <Metrica label="Aprovados" valor={fPct(ent.aprovados_pct)} sub="de quem interagiu" />
          <Metrica label="Pagas" valor={fInt(ent.pagas_qtd)} />
          <Metrica label="Conv. aprovados" valor={fPct(ent.conversao_aprovados_pct)} tom="destaque" />
          <Metrica label="Valor" valor={fMoney(ent.valor)} largo />
        </Painel>

        <Painel titulo="Vendedoras" cor="var(--lime)" sparkId="sparkVendedoras"
                serie={(vdd.serie || []).map((x) => ({ dia: x.dia, v: emPontos ? x.pontos : x.v }))}
                onAbrir={() => onIrPara('vendedoras')}
                acao={
                  <div className="home-toggle" role="group" aria-label="Ver por">
                    <button className={!emPontos ? 'on' : ''} onClick={() => setModo('valor')}>Valor</button>
                    <button className={emPontos ? 'on' : ''} onClick={() => setModo('ponto')}>Pontos</button>
                  </div>
                }>
          <div className="home-ranking">
            {ranking.length === 0 && <p className="home-vazio">Nenhuma venda registrada hoje ainda.</p>}
            {ranking.map((r, i) => {
              const v = n(emPontos ? r.pontos : r.valor)
              return (
                <div key={r.vendedor} className="home-rank-linha">
                  <span className="home-rank-pos">{i + 1}</span>
                  <span className="home-rank-nome" title={r.vendedor}>{r.vendedor}</span>
                  <span className="home-rank-barra"><i style={{ width: `${Math.max(4, (v / topo) * 100)}%` }} /></span>
                  <span className="home-rank-valor">{emPontos ? fPts(v) : fMoney(v)}</span>
                </div>
              )
            })}
          </div>
          <Metrica label="Total do dia" valor={emPontos ? fPts(vdd.pontos_total) : fMoney(vdd.valor_total)}
                   sub={`${fInt(vdd.qtd_total)} vendas`} />
          <Metrica label="Fatia das vendas"
                   valor={fPct(emPontos ? vdd.pct_do_total_ponto : vdd.pct_do_total_valor)} tom="destaque" />
          <Metrica label="Projeção diária"
                   valor={emPontos ? fPts(vdd.pontos_projecao_diaria) : fMoney(vdd.projecao_diaria)} />
          <Metrica label="Projeção semanal"
                   valor={emPontos ? fPts(vdd.pontos_projecao_semanal) : fMoney(vdd.projecao_semanal)} largo />
          <Metrica label="Projeção do mês"
                   valor={emPontos ? fPts(vdd.pontos_projecao_mes) : fMoney(vdd.projecao_mes)} largo />
        </Painel>

        <Painel titulo="Vendas" cor="var(--gold)" sparkId="sparkVendas"
                serie={vnd.serie} onAbrir={() => onIrPara('vendas')}>
          <Metrica label="Pontos" valor={fPts(vnd.pontos_total)} tom="destaque" />
          <Metrica label="Qtd total" valor={fInt(vnd.qtd_total)} />
          <Metrica label="Projeção diária" valor={fPts(vnd.projecao_diaria_pontos)} />
          <Metrica label="Projeção do mês" valor={fPts(vnd.pontos_projecao_mes)} largo />
          <Metrica label="Proj. diária em valor" valor={fMoney(vnd.projecao_diaria_valor)} largo />
          <Metrica label="CLT" valor={fPts(vnd.clt_pontos)} sub={`${fInt(vnd.clt_qtd)} vendas`} largo />
          <Metrica label="FGTS" valor={fPts(vnd.fgts_pontos)} sub={`${fInt(vnd.fgts_qtd)} vendas`} largo />
        </Painel>
      </div>
    </>
  )
}
