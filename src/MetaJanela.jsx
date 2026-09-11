import { useMemo } from 'react'

// Tira compacta da meta INDIVIDUAL (janela vigente de metas_periodos).
// Consome a mesma linha de dashboard_metas_v2 que a coletiva, campos janela_*.
//
// Diferente da coletiva, esta NAO congela no fechamento do mes: a decisao foi
// congelar so a coletiva.
//
// Nem todo dia tem janela: as janelas de setembro sao 01-13, 14-18, 23-25 e
// 28-30, entao 19-22 e 26-27 ficam sem nenhuma. Nesses dias o componente some
// em vez de imprimir NaN.

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))
const fmtPts = (v) => new Intl.NumberFormat('pt-BR').format(Math.round(Number(v) || 0))
const fmtPct = (v) => v.toFixed(1).replace('.', ',') + '%'

export default function MetaJanela({ dados }) {
  const j = useMemo(() => {
    if (!dados || dados.janela_id === null || dados.janela_id === undefined) return null
    const alvo = num(dados.janela_alvo) ?? 0
    if (!(alvo > 0)) return null
    const feito = num(dados.janela_realizado) ?? 0
    const pct = num(dados.janela_pct) ?? 0
    return {
      descricao: dados.janela_descricao || 'Meta da janela',
      base: dados.janela_base,
      alvo,
      feito,
      pct: Math.max(0, Math.min(100, pct)),
      pctReal: pct,
      batida: dados.janela_batida === true,
    }
  }, [dados])

  if (!j) return null

  return (
    <div className="meta-tira">
      <span className="meta-tira-rot">Minha meta</span>

      <span className="meta-tira-sit">
        {j.descricao}
        {j.base === 'dia' ? <em className="meta-tira-hoje"> (hoje)</em> : null}
      </span>

      <div className="bar-track meta-tira-bar">
        <div className={'bar-fill' + (j.batida ? ' batida' : '')} style={{ width: `${j.pct}%` }} />
      </div>

      <span className="meta-tira-pct">{fmtPct(j.pctReal)}</span>

      <span className="meta-tira-falta">
        {j.batida
          ? 'meta batida'
          : <>faltam <strong>{fmtPts(j.alvo - j.feito)}</strong> pts</>}
      </span>
    </div>
  )
}
