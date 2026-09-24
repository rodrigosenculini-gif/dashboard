import { useCallback, useEffect, useRef, useState } from 'react'

async function getJson(type, params) {
  const qs = new URLSearchParams({ type, ...(params || {}) })
  const res = await fetch(`/api/dashboard?${qs}`)
  if (!res.ok) throw new Error('falha ao consultar')
  return res.json()
}

async function postJson(type, body) {
  const res = await fetch(`/api/dashboard?type=${type}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('falha ao enviar')
  return res.json()
}

const CHECAGEM_MS = 60 * 1000   // consulta a cada minuto; o intervalo real
                                // de cada lembrete vem da regra, no banco
const NA_TELA_MS = 90 * 1000    // some sozinho depois disso

/**
 * Lembretes periódicos no portal da vendedora.
 *
 * O "quando aparecer" é decidido no banco (horário, dias, intervalo e o
 * reforço mais curto quando a resposta foi "não") — aqui só perguntamos se
 * há algo pendente. Assim, criar um lembrete novo é um insert, não um deploy.
 *
 * Ignorar conta: a linha é gravada assim que aparece, com resposta nula.
 * É isso que permite medir quem responde e quem deixa passar.
 */
export default function LembreteVendedora({ vendedor, escopo = 'vendedora' }) {
  const [aberto, setAberto] = useState(null)   // { id, regra_id, mensagem }
  const [enviando, setEnviando] = useState(false)
  const timerRef = useRef(null)

  const fechar = useCallback(() => {
    clearTimeout(timerRef.current)
    setAberto(null)
  }, [])

  const checar = useCallback(async () => {
    if (!vendedor || aberto) return
    try {
      const r = await getJson('notificacao_pendente', { vendedor, escopo })
      const nota = Array.isArray(r) ? r[0] : null
      if (!nota?.regra_id) return
      // grava que foi mostrada ANTES de exibir: se ela fechar a aba, o
      // "não respondeu" fica registrado do mesmo jeito
      const m = await postJson('notificacao_mostrada', { regra_id: nota.regra_id, vendedor })
      const id = m?.r ?? m
      setAberto({ id, regra_id: nota.regra_id, mensagem: nota.mensagem })
      timerRef.current = setTimeout(() => setAberto(null), NA_TELA_MS)
    } catch { /* silencioso: lembrete nunca atrapalha a tela */ }
  }, [vendedor, escopo, aberto])

  useEffect(() => {
    checar()
    const t = setInterval(checar, CHECAGEM_MS)
    return () => { clearInterval(t); clearTimeout(timerRef.current) }
  }, [checar])

  const responder = async (resposta) => {
    if (!aberto || enviando) return
    setEnviando(true)
    try { await postJson('notificacao_responder', { id: aberto.id, resposta }) }
    catch { /* a resposta se perde, mas a tela nao trava */ }
    finally { setEnviando(false); fechar() }
  }

  if (!aberto) return null

  return (
    <div className="lembrete-card" role="status">
      <p className="lembrete-texto">{aberto.mensagem}</p>
      <div className="lembrete-acoes">
        <button type="button" className="lembrete-btn sim" disabled={enviando}
                onClick={() => responder('sim')}>Sim</button>
        <button type="button" className="lembrete-btn nao" disabled={enviando}
                onClick={() => responder('nao')}>N&atilde;o</button>
      </div>
    </div>
  )
}
