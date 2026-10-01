import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend } from 'recharts'
import { callApi, useRevisaoCache } from './dadosCache'
import './IAAnalises.css'

// View "IA — Análises" (etapa 7 do projeto da IA): como a IA de atendimento está
// convertendo. Tudo vem de public.ia_analises (migração 158) por /api/dashboard?type=ia_analises.
// Coorte: conversas que COMEÇARAM no período; só produção (sem a caixa de teste e
// os telefones de teste), a não ser que "incluir testes" esteja marcado.

const hojeSP = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10)
const diasAtras = (n) => new Date(Date.now() - 3 * 3600000 - n * 86400000).toISOString().slice(0, 10)
const inicioMes = () => hojeSP().slice(0, 8) + '01'
const fmtDia = (d) => (d ? String(d).slice(8, 10) + '/' + String(d).slice(5, 7) : '')
const fmtInt = (n) => (n ?? 0).toLocaleString('pt-BR')
const usd = (v, casas = 2) => 'US$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0)
function minutos(m) {
  if (m === null || m === undefined) return '—'
  const v = Number(m)
  if (v < 1) return `${Math.round(v * 60)} s`
  if (v < 60) return `${Math.round(v)} min`
  const h = Math.floor(v / 60), r = Math.round(v % 60)
  return r ? `${h} h ${r} min` : `${h} h`
}
const segundos = (s) => (s === null || s === undefined ? '—' : s < 60 ? `${s} s` : minutos(s / 60))
const NOME_BANCO = { 'NOVO SAQUE': 'Novo Saque', 'PRESENÇA': 'Presença', SOMA: 'Soma', FACTA: 'Facta', 'SEMPRE FACIL': 'Sempre Fácil', C6: 'C6' }
const NOME_CORTE = { fgts: 'FGTS', clt: 'CLT', lp: 'Página (LP)', chat: 'Conversa no chat', flow: 'WhatsApp Flow', flow_oferta: 'Flow com a oferta' }
const nomeCorte = (k) => NOME_CORTE[k] || k

const PERIODOS = [
  ['7', 'Últimos 7 dias', () => [diasAtras(6), hojeSP()]],
  ['30', 'Últimos 30 dias', () => [diasAtras(29), hojeSP()]],
  ['mes', 'Este mês', () => [inicioMes(), hojeSP()]],
]

// frases automáticas: onde mais se perde, banco com mais falha, tempo de resposta
function leituras(d) {
  const f = d.funil || [], out = []
  const total = f[0]?.n || 0
  if (!total) return ['Nenhuma conversa começou neste período.']
  const pago = f.find((x) => x.etapa === 'pago')?.n || 0
  out.push(`Das ${fmtInt(total)} conversas, ${fmtInt(f.find((x) => x.etapa === 'oferta')?.n || 0)} receberam oferta e ${fmtInt(pago)} ${pago === 1 ? 'virou contrato pago' : 'viraram contratos pagos'} (${pct(pago, total)}%).`)
  let pior = null
  for (let i = 1; i < f.length; i++) {
    const perda = f[i - 1].n - f[i].n
    if (f[i - 1].n > 0 && perda > 0 && (!pior || perda > pior.perda)) pior = { de: f[i - 1], para: f[i], perda }
  }
  if (pior) out.push(`A maior perda é entre "${pior.de.nome}" e "${pior.para.nome}": ${fmtInt(pior.perda)} de ${fmtInt(pior.de.n)} (${pct(pior.perda, pior.de.n)}%) param ali.`)
  const par = (d.paradas || []).filter((p) => !['em andamento'].includes(p.motivo))[0]
  if (par) out.push(`Motivo mais comum de parada: ${par.motivo} (${par.etapa.toLowerCase()}), em ${fmtInt(par.n)} ${par.n === 1 ? 'conversa' : 'conversas'}.`)
  const bancoRuim = (d.bancos || []).filter((b) => b.chamadas >= 10).map((b) => ({ ...b, taxa: b.falhas / b.chamadas }))
    .sort((a, b) => b.taxa - a.taxa)[0]
  if (bancoRuim && bancoRuim.taxa >= 0.1) out.push(`${NOME_BANCO[bancoRuim.banco] || bancoRuim.banco} (${bancoRuim.produto.toUpperCase()}) teve ${pct(bancoRuim.falhas, bancoRuim.chamadas)}% de falhas do próprio banco nas chamadas.`)
  const t = d.tempos || {}
  if (t.resposta_ia_s !== null && t.resposta_ia_s !== undefined) out.push(`A IA responde o cliente em ${segundos(t.resposta_ia_s)} na metade dos casos (90% em até ${segundos(t.resposta_ia_p90_s)}).`)
  const l = d.equipe?.lembretes
  if (l?.enviados) out.push(`${pct(l.responderam, l.enviados)}% dos lembretes tiveram resposta do cliente em até 24 h (${fmtInt(l.responderam)} de ${fmtInt(l.enviados)}).`)
  return out
}

function Funil({ funil }) {
  const total = funil[0]?.n || 0
  return (
    <div className="iaa-funil">
      {funil.map((x, i) => {
        const ant = i ? funil[i - 1].n : null
        return (
          <div key={x.etapa} className="iaa-funil-linha">
            <span className="iaa-funil-nome">{x.nome}</span>
            <span className="iaa-funil-barra"><i style={{ width: `${total ? Math.max(2, (100 * x.n) / total) : 0}%` }} /></span>
            <span className="iaa-funil-n">{fmtInt(x.n)}</span>
            <span className="iaa-funil-pct">{pct(x.n, total)}%</span>
            <span className="iaa-funil-queda">{ant !== null && ant > x.n ? `−${fmtInt(ant - x.n)} (${pct(ant - x.n, ant)}%)` : ''}</span>
          </div>
        )
      })}
    </div>
  )
}

function Paradas({ paradas }) {
  const porEtapa = useMemo(() => {
    const g = {}
    for (const p of paradas) (g[p.etapa] = g[p.etapa] || []).push(p)
    return Object.entries(g).map(([etapa, l]) => ({ etapa, l, n: l.reduce((s, x) => s + x.n, 0) })).sort((a, b) => b.n - a.n)
  }, [paradas])
  const max = Math.max(1, ...porEtapa.map((e) => e.n))
  if (!porEtapa.length) return <p className="home-vazio">Ninguém parou no meio do caminho neste período.</p>
  return (
    <div className="iaa-paradas">
      {porEtapa.map((e) => (
        <div key={e.etapa} className="iaa-parada">
          <div className="iaa-parada-top"><b>{e.etapa}</b><span>{fmtInt(e.n)}</span></div>
          <div className="iaa-parada-barra">
            {e.l.map((x) => <i key={x.motivo} className={`m-${x.motivo.replace(/\W+/g, '-')}`} style={{ width: `${(100 * x.n) / max}%` }} title={`${x.motivo}: ${x.n}`} />)}
          </div>
          <div className="iaa-parada-motivos">{e.l.map((x) => <span key={x.motivo}>{x.motivo} <em>{x.n}</em></span>)}</div>
        </div>
      ))}
    </div>
  )
}

// embutido: dentro do Painel (IAConfiguracao.jsx), sem a barra de título própria
export default function IAAnalises({ onVoltar, embutido }) {
  const [periodo, setPeriodo] = useState('30')
  const [de, setDe] = useState(diasAtras(29))
  const [ate, setAte] = useState(hojeSP())
  const [produto, setProduto] = useState('')
  const [testes, setTestes] = useState(false)
  const [corte, setCorte] = useState('produto')
  const [d, setD] = useState(null)
  const [erro, setErro] = useState('')
  const [carregando, setCarregando] = useState(false)
  const revisao = useRevisaoCache()

  const carregar = useCallback(async (opts) => {
    setCarregando(true); setErro('')
    try {
      setD(await callApi('ia_analises', { date_from: de, date_to: ate, produto, testes: testes ? '1' : '0' }, opts))
    } catch (e) { setErro(e.message || 'Não foi possível carregar.') }
    finally { setCarregando(false) }
  }, [de, ate, produto, testes, revisao]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { carregar() }, [carregar])

  const escolherPeriodo = (k) => {
    const p = PERIODOS.find((x) => x[0] === k)
    setPeriodo(k)
    if (p) { const [a, b] = p[2](); setDe(a); setAte(b) }
  }

  const funil = d?.funil || []
  const total = funil[0]?.n || 0
  const n = (et) => funil.find((x) => x.etapa === et)?.n || 0
  const cortes = (d?.cortes || []).filter((c) => c.tipo === corte)

  return (
    <>
      {!embutido && (
        <div className="topbar">
          <h1><span className="pulse" /> IA &mdash; Análises</h1>
          <div className="topbar-right">
            <span className="status-line">{carregando ? 'carregando…' : ''}</span>
            {onVoltar && <button className="reset-btn" onClick={onVoltar}>&#8592; Início</button>}
            <button className="refresh-btn" onClick={() => carregar({ forcar: true })} disabled={carregando}>&#8635; Atualizar</button>
          </div>
        </div>
      )}

      <div className="iaa-filtros">
        <div className="chip-opcoes">
          {PERIODOS.map(([k, t]) => <button key={k} className={`chip-opcao ${periodo === k ? 'on' : ''}`} onClick={() => escolherPeriodo(k)}>{t}</button>)}
          <span className="iaa-datas">
            <input type="date" className="chip-input" value={de} max={ate} onChange={(e) => { setPeriodo(''); setDe(e.target.value) }} />
            <span>até</span>
            <input type="date" className="chip-input" value={ate} min={de} onChange={(e) => { setPeriodo(''); setAte(e.target.value) }} />
          </span>
        </div>
        <div className="chip-opcoes">
          {[['', 'Todos os produtos'], ['fgts', 'FGTS'], ['clt', 'CLT']].map(([k, t]) => (
            <button key={k} className={`chip-opcao ${produto === k ? 'on' : ''}`} onClick={() => setProduto(k)}>{t}</button>
          ))}
          <button className={`chip-opcao ${testes ? 'on' : ''}`} onClick={() => setTestes((x) => !x)}
                  title="Inclui a caixa de teste e os telefones de teste">{testes ? '✓ ' : ''}Incluir testes</button>
          {embutido && (
            <button className="refresh-btn" onClick={() => carregar({ forcar: true })} disabled={carregando}>
              &#8635; {carregando ? 'Carregando…' : 'Atualizar'}
            </button>
          )}
        </div>
      </div>

      {erro && <div className="state-msg error">Erro: {erro}</div>}
      {!d && !erro && <div className="state-msg">Carregando…</div>}

      {d && (
        <>
          <div className="kpi-grid iaa-kpis">
            <div className="kpi"><p className="kpi-label">Conversas</p><p className="kpi-value">{fmtInt(total)}</p><small>começaram no período</small></div>
            <div className="kpi"><p className="kpi-label">Receberam oferta</p><p className="kpi-value">{fmtInt(n('oferta'))}</p><small>{pct(n('oferta'), total)}% das conversas</small></div>
            <div className="kpi"><p className="kpi-label">Contratos pagos</p><p className="kpi-value accent">{fmtInt(n('pago'))}</p><small>{pct(n('pago'), total)}% das conversas · {pct(n('pago'), n('oferta'))}% das ofertas</small></div>
            <div className="kpi"><p className="kpi-label">Até a oferta</p><p className="kpi-value">{minutos(d.tempos?.ate_oferta_min)}</p><small>mediana, desde a 1ª mensagem</small></div>
            <div className="kpi"><p className="kpi-label">Resposta da IA</p><p className="kpi-value">{segundos(d.tempos?.resposta_ia_s)}</p><small>mediana · 90% em até {segundos(d.tempos?.resposta_ia_p90_s)}</small></div>
            <div className="kpi"><p className="kpi-label">Custo do modelo</p><p className="kpi-value">{usd(d.custo?.usd)}</p><small>{d.custo?.usd_por_conversa != null ? `${usd(d.custo.usd_por_conversa, 4)} por conversa` : '—'}</small></div>
          </div>

          <section className="panel iaa-bloco iaa-leitura">
            <p className="section-label">O que os números dizem</p>
            <ul>{leituras(d).map((t, i) => <li key={i}>{t}</li>)}</ul>
          </section>

          <div className="iaa-duas">
            <section className="panel iaa-bloco">
              <p className="section-label">Funil · até onde cada conversa chegou</p>
              <Funil funil={funil} />
              <p className="iaa-nota">% sobre as conversas; em vermelho, quantas pararam desde a etapa anterior.</p>
            </section>
            <section className="panel iaa-bloco">
              <p className="section-label">Onde param e por quê · quem não chegou ao pagamento</p>
              <Paradas paradas={d.paradas || []} />
            </section>
          </div>

          <section className="panel iaa-bloco">
            <p className="section-label">Por banco · conversas consultadas</p>
            <div className="iaa-tabela-wrap">
              <table className="iaa-tabela">
                <thead><tr><th>Banco</th><th>Produto</th><th>Conversas consultadas</th><th>Com oferta</th><th>Situação do cliente</th><th>Falha do banco</th><th>Propostas</th><th>Tempo médio</th></tr></thead>
                <tbody>
                  {(d.bancos || []).map((b) => (
                    <tr key={b.produto + b.banco}>
                      <td><b>{NOME_BANCO[b.banco] || b.banco}</b></td>
                      <td>{(b.produto || '').toUpperCase()}</td>
                      <td>{fmtInt(b.atendimentos)}</td>
                      <td>{fmtInt(b.com_oferta)} <em>{pct(b.com_oferta, b.atendimentos)}%</em></td>
                      <td>{fmtInt(b.cliente)} <em>de {fmtInt(b.chamadas)} chamadas</em></td>
                      <td className={b.chamadas && b.falhas / b.chamadas >= 0.1 ? 'iaa-ruim' : ''}>{fmtInt(b.falhas)} <em>{pct(b.falhas, b.chamadas)}%</em></td>
                      <td>{fmtInt(b.digitadas)}</td>
                      <td>{b.latencia_ms ? `${(b.latencia_ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s` : '—'}</td>
                    </tr>
                  ))}
                  {!(d.bancos || []).length && <tr><td colSpan={8} className="home-vazio">Nenhuma consulta no período.</td></tr>}
                </tbody>
              </table>
            </div>
            <p className="iaa-nota">"Situação do cliente" = sem saldo, não autorizou, fora da política, celular já usado… (normal do negócio). "Falha do banco" = instabilidade, limite de consultas, banco fora do ar.</p>
          </section>

          <div className="iaa-duas">
            <section className="panel iaa-bloco">
              <div className="iaa-cab">
                <p className="section-label">Comparar</p>
                <div className="chip-opcoes">
                  {[['produto', 'Produto'], ['jornada', 'Jornada'], ['campanha', 'Campanha']].map(([k, t]) => (
                    <button key={k} className={`chip-opcao ${corte === k ? 'on' : ''}`} onClick={() => setCorte(k)}>{t}</button>
                  ))}
                </div>
              </div>
              <table className="iaa-tabela">
                <thead><tr><th></th><th>Conversas</th><th>Oferta</th><th>Aceite</th><th>Pago</th></tr></thead>
                <tbody>
                  {cortes.map((c) => (
                    <tr key={c.chave}>
                      <td><b>{nomeCorte(c.chave)}</b></td>
                      <td>{fmtInt(c.conversas)}</td>
                      <td>{fmtInt(c.ofertas)} <em>{pct(c.ofertas, c.conversas)}%</em></td>
                      <td>{fmtInt(c.aceites)} <em>{pct(c.aceites, c.conversas)}%</em></td>
                      <td>{fmtInt(c.pagos)} <em>{pct(c.pagos, c.conversas)}%</em></td>
                    </tr>
                  ))}
                  {!cortes.length && <tr><td colSpan={5} className="home-vazio">Sem dados.</td></tr>}
                </tbody>
              </table>
            </section>
            <section className="panel iaa-bloco">
              <p className="section-label">Equipe e lembretes</p>
              <ul className="iaa-lista">
                <li><span>Passaram para a equipe</span><b>{fmtInt(d.equipe?.derivados)}</b></li>
                {(d.equipe?.motivos || []).map((m) => <li key={m.motivo} className="iaa-sub"><span>{m.motivo}</span><b>{fmtInt(m.n)}</b></li>)}
                <li><span>Clientes sem resposta da vendedora (escalada)</span><b>{fmtInt(d.equipe?.escaladas?.total)}</b></li>
                <li className="iaa-sub"><span>a vendedora resolveu</span><b>{fmtInt(d.equipe?.escaladas?.resolvidas_pela_vendedora)}</b></li>
                <li className="iaa-sub"><span>a IA assumiu</span><b>{fmtInt(d.equipe?.escaladas?.ia_assumiu)}</b></li>
                <li className="iaa-sub"><span>supervisor chamado</span><b>{fmtInt(d.equipe?.escaladas?.supervisor)}</b></li>
                <li><span>Lembretes enviados ao cliente</span><b>{fmtInt(d.equipe?.lembretes?.enviados)}</b></li>
                <li className="iaa-sub"><span>o cliente respondeu em até 24 h</span><b>{fmtInt(d.equipe?.lembretes?.responderam)} · {pct(d.equipe?.lembretes?.responderam, d.equipe?.lembretes?.enviados)}%</b></li>
                <li><span>Tempo até a proposta ir ao banco</span><b>{minutos(d.tempos?.ate_digitacao_min)}</b></li>
                <li><span>Chamadas ao modelo</span><b>{fmtInt(d.custo?.chamadas)}{d.custo?.usd_por_pago != null ? ` · ${usd(d.custo.usd_por_pago, 3)} por contrato pago` : ''}</b></li>
              </ul>
            </section>
          </div>

          <section className="panel chart-panel iaa-grafico">
            <p className="section-label">Por dia</p>
            <ResponsiveContainer width="100%" height="85%">
              <BarChart data={d.por_dia || []} margin={{ top: 10, right: 6, left: -18, bottom: 0 }}>
                <XAxis dataKey="dia" tick={{ fontSize: 10, fill: '#8a978f' }} tickFormatter={fmtDia} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#8a978f' }} />
                <Tooltip contentStyle={{ background: '#1b2620', border: '1px solid #263029', borderRadius: 8, fontFamily: 'IBM Plex Mono', fontSize: 12 }}
                         labelStyle={{ color: '#8a978f' }} labelFormatter={fmtDia} cursor={{ fill: 'rgba(255,255,255,.04)' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="conversas" name="Conversas" fill="#56625b" radius={[3, 3, 0, 0]} />
                <Bar dataKey="ofertas" name="Ofertas" fill="#d9b877" radius={[3, 3, 0, 0]} />
                <Bar dataKey="pagos" name="Pagos" fill="#a9d97f" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </section>

          <p className="iaa-nota iaa-rodape">
            Conversas que começaram entre {fmtDia(d.periodo?.de)} e {fmtDia(d.periodo?.ate)}, no número da IA{testes ? ' (incluindo testes)' : ' (sem testes)'}.
            Cada conversa conta na etapa mais avançada a que chegou, mesmo que ainda esteja em andamento.
          </p>
        </>
      )}
    </>
  )
}
