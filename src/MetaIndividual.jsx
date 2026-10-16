import { useMemo } from 'react'

// Tira da meta INDIVIDUAL por faixas ("Premiacao extraordinaria", 10/2026).
// Consome a linha de dashboard_metas_v2 da vendedora, campos ind_*: pontos dela
// no mes contra as faixas vigentes (metas_individuais). Vale o premio da maior
// faixa atingida. Nao congela no fechamento (so a coletiva congela).
// Sem vendedora (gestao) ou sem faixas vigentes, o componente some.

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))
const fmtPts = (v) => new Intl.NumberFormat('pt-BR').format(Math.round(v || 0))
const fmtBRL = (v) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v || 0)
const fmtPct = (v) => v.toFixed(1).replace('.', ',') + '%'

export default function MetaIndividual({ dados }) {
  const m = useMemo(() => {
    if (!dados) return null
    const total = num(dados.ind_total_faixas) || 0
    const pontos = num(dados.ind_pontos)
    if (!total || pontos === null) return null
    const faixa = num(dados.ind_faixa)
    const premio = num(dados.ind_premio) ?? 0
    const faixaMin = num(dados.ind_faixa_min) ?? 0
    const proxFaixa = num(dados.ind_proxima_faixa)
    const proxMin = num(dados.ind_proxima_min)
    const premioProx = num(dados.ind_premio_proximo)
    const noTopo = proxMin === null
    let pct
    if (noTopo) pct = 100
    else {
      const largura = proxMin - faixaMin
      pct = largura > 0 ? ((pontos - faixaMin) / largura) * 100 : 0
    }
    pct = Math.max(0, Math.min(100, pct))
    return { total, pontos, faixa, premio, proxFaixa, premioProx, noTopo, pct, faltam: noTopo ? 0 : Math.max(0, proxMin - pontos) }
  }, [dados])

  if (!m) return null
  const semFaixa = m.faixa === null

  return (
    <div className="meta-tira">
      <span className="meta-tira-rot">Minha faixa</span>

      <span className="meta-tira-sit">
        {semFaixa ? 'abaixo da Faixa 1' : `Faixa ${m.faixa} · ${fmtBRL(m.premio)}`}
      </span>

      <div className="bar-track meta-tira-bar">
        <div className={'bar-fill' + (m.noTopo ? ' batida' : '')} style={{ width: `${m.pct}%` }} />
      </div>

      <span className="meta-tira-pct">{fmtPct(m.pct)}</span>

      <span className="meta-tira-falta">
        {m.noTopo ? (
          'faixa máxima'
        ) : (
          <>
            faltam <strong>{fmtPts(m.faltam)}</strong> pts p/ Faixa {m.proxFaixa}
            {m.premioProx ? ` · ${fmtBRL(m.premioProx)}` : ''}
          </>
        )}
      </span>

      <span className="meta-tira-trilha">
        {Array.from({ length: m.total }, (_, i) => {
          const n = i + 1
          return (
            <i
              key={n}
              className={
                'meta-tira-marco' +
                (!semFaixa && n <= m.faixa ? ' conquistada' : '') +
                (!semFaixa && n === m.faixa ? ' atual' : '')
              }
              title={`Faixa ${n}`}
            />
          )
        })}
      </span>
    </div>
  )
}
