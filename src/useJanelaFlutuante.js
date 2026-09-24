import { useCallback, useEffect, useState } from 'react'
import ReactDOM from 'react-dom'

/**
 * Janela flutuante (Document Picture-in-Picture): fica por cima de tudo,
 * mesmo com o Chrome em outra aba ou minimizado, e o conteúdo é HTML nosso —
 * então o visual é o mesmo do projeto, ao contrário da notificação do sistema.
 *
 * O navegador só abre em resposta a um clique; não há como abrir sozinho nem
 * guardar permissão. Por isso o botão "destacar" fica sempre à mão.
 *
 * Suporte: Chrome 116+. Onde não existe, `suportado` volta false e a tela
 * segue usando o mascote normal.
 */
export function useJanelaFlutuante() {
  const [janela, setJanela] = useState(null)
  const suportado = typeof window !== 'undefined' && 'documentPictureInPicture' in window

  const abrir = useCallback(async ({ width = 300, height = 360 } = {}) => {
    if (!suportado || janela) return null
    try {
      const w = await window.documentPictureInPicture.requestWindow({ width, height })

      // a janela nasce sem estilo: copia as folhas do documento principal
      for (const folha of document.styleSheets) {
        try {
          const regras = Array.from(folha.cssRules).map((r) => r.cssText).join('')
          const el = document.createElement('style')
          el.textContent = regras
          w.document.head.appendChild(el)
        } catch {
          // folha de outro dominio (fonte externa): recria o <link>
          if (folha.href) {
            const link = document.createElement('link')
            link.rel = 'stylesheet'
            link.href = folha.href
            w.document.head.appendChild(link)
          }
        }
      }
      w.document.body.classList.add('pip-body')
      w.addEventListener('pagehide', () => setJanela(null))
      setJanela(w)
      return w
    } catch {
      return null
    }
  }, [suportado, janela])

  const fechar = useCallback(() => {
    try { janela?.close() } catch { /* ja fechada */ }
    setJanela(null)
  }, [janela])

  // fecha junto com a aba, senao a janelinha fica orfa na tela
  useEffect(() => {
    if (!janela) return
    const aoSair = () => { try { janela.close() } catch { /* ok */ } }
    window.addEventListener('pagehide', aoSair)
    return () => window.removeEventListener('pagehide', aoSair)
  }, [janela])

  const Portal = useCallback(
    ({ children }) => (janela ? ReactDOM.createPortal(children, janela.document.body) : null),
    [janela]
  )

  return { suportado, janela, abrir, fechar, Portal }
}
