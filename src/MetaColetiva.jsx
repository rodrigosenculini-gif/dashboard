import { useMemo } from 'react'

// Tira compacta da meta coletiva.
//
// Consome UMA linha de dashboard_metas_v2 (campos col_*). Ocupa uma linha so:
// o grafico do dia e o que importa na tela, a meta e apoio. Quando a meta
// individual entrar, ela cabe na mesma tira sem empurrar nada.
//
// NAO exibe numeros totais (pontuacao acumulada, pisos das faixas, teto).
//
// Cuidados vindos de ler a funcao no banco:
//  - numericos chegam como STRING do Postgres; tudo passa por num().
//  - col_pct_proxima NAO serve: e pontos/proxima_min, nasce em 83% no primeiro
//    dia da faixa. O percentual aqui e o trecho DENTRO da faixa.

// Congelamento: do 5o dia antes do fim do mes ate o 2o dia util do mes
// seguinte. E o periodo de conferencia — a vendedora nao pode ver "bateu" a
// partir de numero que ainda vai mudar. So a COLETIVA congela.
// Dia util = seg a sex, igual a dashboard_vendedoras_meta no banco.
export function coletivaCongelada(hoje = new Date()) {
  const d = hoje.getDate()
  const ano = hoje.getFullYear()
  const mes = hoje.getMonth()

  const ultimoDia = new Date(ano, mes + 1, 0).getDate()
  if (d > ultimoDia - 5) return true

  let uteis = 0
  for (let i = 1; i <= d; i++) {
    const dow = new Date(ano, mes, i).getDay()
    if (dow !== 0 && dow !== 6) uteis++
  }
  return uteis <= 2
}

const TOTAL_FAIXAS = 7
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))
const fmtPts = (v) => new Intl.NumberFormat('pt-BR').format(Math.round(v || 0))
const fmtBRL = (v) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v || 0)
const fmtPct = (v) => v.toFixed(1).replace('.', ',') + '%'

export default function MetaColetiva({ dados, congelada }) {
  const travada = congelada ?? coletivaCongelada()

  const c = useMemo(() => {
    if (!dados) return null
    const pontos = num(dados.col_pontos) ?? 0
    const faixa = num(dados.col_faixa)
    const premio = num(dados.col_premio) ?? 0
    const faixaMin = num(dados.col_faixa_min) ?? 0
    const proxFaixa = num(dados.col_proxima_faixa)
    const proxMin = num(dados.col_proxima_min)
    const premioProx = num(dados.col_premio_proximo)

    const noTopo = proxMin === null
    let pct
    if (noTopo) pct = 100
    else {
      const largura = proxMin - faixaMin
      pct = largura > 0 ? ((pontos - faixaMin) / largura) * 100 : 0
    }
    pct = Math.max(0, Math.min(100, pct))

    return {
      faixa, premio, proxFaixa, premioProx, noTopo, pct,
      faltam: noTopo ? 0 : Math.max(0, proxMin - pontos),
    }
  }, [dados])

  if (!c) return null

  if (travada) {
    return (
      <div className="meta-tira">
        <span className="meta-tira-rot">Coletiva</span>
        <span className="meta-tira-sit">em conferência</span>
      </div>
    )
  }

  const semFaixa = c.faixa === null

  return (
    <div className="meta-tira">
      <span className="meta-tira-rot">Coletiva</span>

      <span className="meta-tira-sit">
        {semFaixa ? 'abaixo da Faixa 1' : `Faixa ${c.faixa} · ${fmtBRL(c.premio)}`}
      </span>

      <div className="bar-track meta-tira-bar">
        <div className="bar-fill" style={{ width: `${c.pct}%` }} />
      </div>

      <span className="meta-tira-pct">{fmtPct(c.pct)}</span>

      <span className="meta-tira-falta">
        {c.noTopo ? (
          'faixa máxima'
        ) : (
          <>
            faltam <strong>{fmtPts(c.faltam)}</strong> p/ Faixa {c.proxFaixa}
            {c.premioProx ? ` · ${fmtBRL(c.premioProx)}` : ''}
          </>
        )}
      </span>

      <span className="meta-tira-trilha">
        {Array.from({ length: TOTAL_FAIXAS }, (_, i) => {
          const n = i + 1
          return (
            <i
              key={n}
              className={
                'meta-tira-marco' +
                (!semFaixa && n <= c.faixa ? ' conquistada' : '') +
                (!semFaixa && n === c.faixa ? ' atual' : '')
              }
              title={`Faixa ${n}`}
            />
          )
        })}
      </span>
    </div>
  )
}
