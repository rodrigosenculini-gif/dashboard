import { useMemo } from 'react'

// Barra da meta coletiva da empresa.
//
// Consome UMA linha de dashboard_metas_v2 (os campos col_*). O pai faz o
// callApi('metas_v2', { vendedor }) e passa a linha inteira aqui.
//
// Dois cuidados que vieram de ler a funcao:
//  - os numericos chegam como STRING do Postgres ("5715755.8290"), entao tudo
//    passa por num() antes de conta. Chamar .toFixed() direto estoura.
//  - col_pct_proxima NAO serve para a barra: e pontos/proxima_min, que nasce
//    em 83% no primeiro dia da faixa. A barra usa o trecho, calculado aqui.

// Congelamento da coletiva.
// Do 5o dia antes do fim do mes ate o 2o dia util do mes seguinte a tela nao
// mostra a progressao: e o periodo de conferencia, e a vendedora nao pode ver
// "bateu" ou "nao bateu" a partir de numero que ainda vai mudar.
// So a COLETIVA congela. A janela individual continua visivel.
//
// Dia util = seg a sex (isodow < 6). E a mesma definicao que
// dashboard_vendedoras_meta ja usa no banco — feriado nao conta.
// Mantida igual de proposito, para nao existirem duas nocoes de dia util.
export function coletivaCongelada(hoje = new Date()) {
  const d = hoje.getDate()
  const ano = hoje.getFullYear()
  const mes = hoje.getMonth()

  const ultimoDia = new Date(ano, mes + 1, 0).getDate()
  if (d > ultimoDia - 5) return true // ultimos 5 dias do mes

  let uteis = 0
  for (let i = 1; i <= d; i++) {
    const dow = new Date(ano, mes, i).getDay() // 0=dom, 6=sab
    if (dow !== 0 && dow !== 6) uteis++
  }
  return uteis <= 2 // ainda dentro dos 2 primeiros dias uteis
}

const TOTAL_FAIXAS = 7

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))

const fmtPts = (v) => new Intl.NumberFormat('pt-BR').format(Math.round(v || 0))

const fmtBRL = (v) =>
  new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  }).format(v || 0)

export default function MetaColetiva({ dados, congelada }) {
  const travada = congelada ?? coletivaCongelada()

  const c = useMemo(() => {
    if (!dados) return null

    const pontos = num(dados.col_pontos) ?? 0
    const faixa = num(dados.col_faixa) // null abaixo de 4 milhoes
    const premio = num(dados.col_premio) ?? 0
    const faixaMin = num(dados.col_faixa_min) ?? 0 // null abaixo de 4 mi -> piso 0
    const proxFaixa = num(dados.col_proxima_faixa) // null no topo
    const proxMin = num(dados.col_proxima_min) // null no topo
    const premioProx = num(dados.col_premio_proximo)
    const teto = num(dados.col_teto) ?? 0
    const pctTeto = num(dados.col_pct_teto) ?? 0

    const noTopo = proxMin === null

    // trecho entre a faixa atual e a proxima: vai de 0 a 100 DENTRO da faixa.
    let pctTrecho
    if (noTopo) {
      pctTrecho = 100
    } else {
      const largura = proxMin - faixaMin
      pctTrecho = largura > 0 ? ((pontos - faixaMin) / largura) * 100 : 0
    }
    pctTrecho = Math.max(0, Math.min(100, pctTrecho))

    const faltam = noTopo ? 0 : Math.max(0, proxMin - pontos)

    return {
      pontos, faixa, premio, faixaMin,
      proxFaixa, proxMin, premioProx,
      teto, pctTeto, noTopo, pctTrecho, faltam,
    }
  }, [dados])

  if (!c) return null

  if (travada) {
    return (
      <div className="meta-col meta-col-congelada">
        <div className="ia-kpi">
          <span>Meta coletiva</span>
          <strong>Em conferência</strong>
          <span className="meta-col-faixa-atual">
            A pontuação da empresa volta a aparecer após o fechamento do mês.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="meta-col">
      <div className="meta-col-linha">

        {/* esquerda — situacao atual */}
        <div className="ia-kpi meta-col-situacao">
          <span>Pontuação da empresa</span>
          <strong>{fmtPts(c.pontos)}</strong>
          <span className="meta-col-faixa-atual">
            {c.faixa === null
              ? 'Abaixo da Faixa 1'
              : `Faixa ${c.faixa} · ${fmtBRL(c.premio)}`}
          </span>
        </div>

        {/* centro — a barra */}
        <div className="meta-col-progresso">
          <p className="meta-col-rotulo">
            {c.noTopo ? (
              <>Faixa máxima atingida · {fmtBRL(c.premio)}</>
            ) : (
              <>
                faltam <strong>{fmtPts(c.faltam)} pts</strong> para a Faixa{' '}
                {c.proxFaixa}
                {c.premioProx ? <> — {fmtBRL(c.premioProx)}</> : null}
              </>
            )}
          </p>

          <div className="meta-col-bar-linha">
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${c.pctTrecho}%` }} />
            </div>
          </div>

          <div className="meta-col-pontas">
            <span>{fmtPts(c.faixaMin)}</span>
            <span>{c.noTopo ? '—' : fmtPts(c.proxMin)}</span>
          </div>
        </div>

        {/* direita — trilha das 7 faixas */}
        <div
          className="meta-col-trilha"
          aria-label={`Faixa ${c.faixa ?? 0} de ${TOTAL_FAIXAS}`}
        >
          {Array.from({ length: TOTAL_FAIXAS }, (_, i) => {
            const n = i + 1
            const conquistada = c.faixa !== null && n <= c.faixa
            const atual = c.faixa !== null && n === c.faixa
            return (
              <span
                key={n}
                className={
                  'meta-col-marco' +
                  (conquistada ? ' conquistada' : '') +
                  (atual ? ' atual' : '')
                }
                title={`Faixa ${n}`}
              />
            )
          })}
        </div>
      </div>

      {/* rodape — teto */}
      <p className="meta-col-teto">
        {c.pctTeto.toFixed(1).replace('.', ',')}% dos {fmtPts(c.teto)}
      </p>
    </div>
  )
}
