import { useEffect, useState } from 'react'

// ---------------------------------------------------------------------
// Lembra filtros e rolagem de cada tela ao atualizar a pagina (F5).
//
// - Fica no sessionStorage: vale so para aquela aba do navegador.
// - Com limite: se a pagina ficou fechada/sem recarregar por mais de
//   LIMITE_MS, tudo volta ao padrao (datas do periodo atual, sem filtro).
// - Os DADOS nao vem daqui: cada tela continua consultando o banco ao abrir
//   (o cache de dados tem a propria regra de 3 minutos em dadosCache.js).
// ---------------------------------------------------------------------

const PREFIXO = 'lembra:'
const LIMITE_MS = 30 * 60_000   // 30 minutos

let valido = null
function lembrancaValida() {
  if (valido !== null) return valido
  try {
    const saida = Number(sessionStorage.getItem(PREFIXO + '_saida') || 0)
    valido = saida > 0 && Date.now() - saida < LIMITE_MS
    if (!valido) {
      Object.keys(sessionStorage).filter((k) => k.startsWith(PREFIXO)).forEach((k) => sessionStorage.removeItem(k))
    }
  } catch { valido = false }
  return valido
}

if (typeof window !== 'undefined') {
  const marcarSaida = () => { try { sessionStorage.setItem(PREFIXO + '_saida', String(Date.now())) } catch { /* ignora */ } }
  window.addEventListener('pagehide', marcarSaida)
  window.addEventListener('beforeunload', marcarSaida)
}

// useState que sobrevive ao F5 (dentro do limite)
export function useLembrado(chave, inicial) {
  const k = PREFIXO + chave
  const [v, setV] = useState(() => {
    if (lembrancaValida()) {
      try {
        const raw = sessionStorage.getItem(k)
        if (raw !== null) return JSON.parse(raw)
      } catch { /* ignora */ }
    }
    return typeof inicial === 'function' ? inicial() : inicial
  })
  useEffect(() => {
    try { sessionStorage.setItem(k, JSON.stringify(v)) } catch { /* ignora */ }
  }, [k, v])
  return [v, setV]
}

// Rolagem da pagina por tela: guarda enquanto rola e volta ao mesmo ponto
// depois do F5, esperando o conteudo carregar (ate ~5 s).
export function useRolagemLembrada(chave) {
  useEffect(() => {
    const k = PREFIXO + 'rolagem:' + chave
    let alvo = 0
    if (lembrancaValida()) {
      try { alvo = Number(sessionStorage.getItem(k) || 0) } catch { /* ignora */ }
    }
    let tentativas = 0
    let timerRestaura
    const restaurar = () => {
      if (!alvo) return
      const cabe = document.documentElement.scrollHeight - window.innerHeight >= alvo - 20
      if (cabe || tentativas >= 25) { window.scrollTo(0, alvo); alvo = 0; return }
      tentativas += 1
      timerRestaura = setTimeout(restaurar, 200)
    }
    restaurar()
    const salvar = () => { try { sessionStorage.setItem(k, String(Math.round(window.scrollY))) } catch { /* ignora */ } }
    let timerSalva
    const aoRolar = () => { clearTimeout(timerSalva); timerSalva = setTimeout(salvar, 250) }
    window.addEventListener('scroll', aoRolar, { passive: true })
    window.addEventListener('pagehide', salvar)
    return () => {
      clearTimeout(timerRestaura); clearTimeout(timerSalva)
      window.removeEventListener('scroll', aoRolar)
      window.removeEventListener('pagehide', salvar)
    }
  }, [chave])
}
