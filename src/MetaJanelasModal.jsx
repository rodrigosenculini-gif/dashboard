import { useCallback, useEffect, useState } from 'react'

// Ajuste de janelas de meta por texto livre (frente 1.3, so na view geral).
//
// Fluxo: escreve -> Interpretar -> PREVIA -> Confirmar e substituir.
//
// A previa nao e enfeite. Num teste real deste fluxo o modelo recebeu
// "80 mil para cada vendedora" e devolveu base "periodo" sem hesitar, quando a
// leitura por dia daria alvo 5x maior. Hoje o n8n recusa frases assim, mas a
// previa e a ultima checagem antes de virar comissao — por isso a coluna BASE
// tem destaque proprio: e o campo onde o erro e mais provavel e mais caro.

const WEBHOOK_META = 'https://hotn8n.querosacarfgts.com.br/webhook/meta-interpretar'

const COLS = '1fr 160px 92px 116px'

const fmtPts = (v) => new Intl.NumberFormat('pt-BR').format(Math.round(Number(v) || 0))

const fmtData = (d) => {
  const s = String(d || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const [a, m, dia] = s.split('-')
  return `${dia}/${m}/${a}`
}

const rotuloBase = (b) => (b === 'dia' ? 'POR DIA' : 'no período')

export default function MetaJanelasModal({ callApi, postApi, onClose }) {
  const [texto, setTexto] = useState('')
  const [previa, setPrevia] = useState(null)
  const [atuais, setAtuais] = useState([])
  const [carregando, setCarregando] = useState(false)
  const [gravando, setGravando] = useState(false)
  const [erro, setErro] = useState('')

  useEffect(() => {
    callApi('metas_janelas', {})
      .then((r) => setAtuais(Array.isArray(r) ? r : []))
      .catch(() => setAtuais([]))
  }, [callApi])

  const interpretar = useCallback(async () => {
    const t = texto.trim()
    if (!t) return
    setCarregando(true)
    setErro('')
    setPrevia(null)
    try {
      const hoje = new Date()
      const iso = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`
      const res = await fetch(WEBHOOK_META, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texto: t, hoje: iso }),
      })
      const d = await res.json()
      if (!d || d.ok !== true || !Array.isArray(d.janelas) || !d.janelas.length) {
        setErro(d?.erro || 'não consegui interpretar esse texto')
        return
      }
      setPrevia(d.janelas)
    } catch (e) {
      setErro('falha ao falar com a IA: ' + (e.message || e))
    } finally {
      setCarregando(false)
    }
  }, [texto])

  const confirmar = useCallback(async () => {
    if (!previa) return
    setGravando(true)
    setErro('')
    try {
      await postApi('metas_janelas_set', { janelas: previa })
      onClose(true)
    } catch (e) {
      setErro('não gravou: ' + (e.message || e))
      setGravando(false)
    }
  }, [previa, postApi, onClose])

  return (
    <div className="funil-overlay">
      <div className="funil-panel meta-jan-panel">
        <div className="funil-header">
          <span>Ajustar meta por texto</span>
          <button className="funil-close" onClick={() => onClose(false)}>×</button>
        </div>

        <div className="meta-jan-corpo">
          <textarea
            className="meta-jan-texto"
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            rows={4}
            placeholder={'de 01 a 13 de outubro, 250 mil por vendedor no período; de 23 a 25, 50 mil por dia'}
          />

          <div className="meta-jan-acoes">
            <button className="refresh-btn" onClick={interpretar} disabled={carregando || !texto.trim()}>
              {carregando ? 'Interpretando…' : 'Interpretar'}
            </button>
            <span className="meta-jan-dica">
              diga sempre se o alvo é <strong>por dia</strong> ou <strong>no período</strong>
            </span>
          </div>

          {erro && <div className="state-msg error">{erro}</div>}

          {previa && (
            <>
              <p className="section-label">Vai ficar assim</p>
              <div className="panel table-panel">
                <div className="template-row head" style={{ gridTemplateColumns: COLS }}>
                  <span>Descrição</span><span>Período</span><span>Base</span><span>Alvo</span>
                </div>
                {previa.map((j, i) => (
                  <div className="template-row" key={i} style={{ gridTemplateColumns: COLS }}>
                    <span>{j.descricao}</span>
                    <span>{fmtData(j.data_ini)} — {fmtData(j.data_fim)}</span>
                    <span className={'meta-jan-base' + (j.base === 'dia' ? ' dia' : '')}>{rotuloBase(j.base)}</span>
                    <span>{fmtPts(j.alvo_pontos)} pts</span>
                  </div>
                ))}
              </div>

              <p className="section-label">Ativas hoje — serão desativadas</p>
              <div className="panel table-panel">
                {atuais.length === 0 && <div className="state-msg">nenhuma janela ativa</div>}
                {atuais.map((j) => (
                  <div className="template-row" key={j.id} style={{ gridTemplateColumns: COLS }}>
                    <span>{j.descricao}</span>
                    <span>{fmtData(j.data_ini)} — {fmtData(j.data_fim)}</span>
                    <span className={'meta-jan-base' + (j.base === 'dia' ? ' dia' : '')}>{rotuloBase(j.base)}</span>
                    <span>{fmtPts(j.alvo_pontos)} pts</span>
                  </div>
                ))}
              </div>

              <div className="meta-jan-acoes meta-jan-confirmar">
                <button className="refresh-btn" onClick={confirmar} disabled={gravando}>
                  {gravando ? 'Gravando…' : `Confirmar e substituir (${atuais.length} → ${previa.length})`}
                </button>
                <button className="reset-btn" onClick={() => setPrevia(null)} disabled={gravando}>
                  Cancelar
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
