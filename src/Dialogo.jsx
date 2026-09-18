import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

/**
 * Substitui window.confirm / window.prompt, que renderizam a caixa do
 * navegador (branca, fora do tema) em cima de um dashboard escuro.
 *
 * Uso:
 *   const dialogo = useDialogo()
 *   if (!await dialogo.confirmar({ titulo: 'Excluir?', perigo: true })) return
 *   const nome = await dialogo.perguntar({ titulo: 'Nome da lista' })
 */
const DialogoCtx = createContext(null)

export function useDialogo() {
  const ctx = useContext(DialogoCtx)
  if (!ctx) throw new Error('useDialogo precisa do <DialogoProvider>')
  return ctx
}

function Caixa({ pedido, onResolver }) {
  const [valor, setValor] = useState(pedido.valorInicial || '')
  const inputRef = useRef(null)
  const okRef = useRef(null)

  useEffect(() => {
    // foca o campo quando é pergunta, senão o botão de confirmar
    const alvo = pedido.tipo === 'perguntar' ? inputRef.current : okRef.current
    alvo?.focus()
    if (pedido.tipo === 'perguntar') inputRef.current?.select()
  }, [pedido])

  useEffect(() => {
    const esc = (e) => {
      if (e.key === 'Escape') onResolver(pedido.tipo === 'perguntar' ? null : false)
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [pedido, onResolver])

  const confirmar = () => onResolver(pedido.tipo === 'perguntar' ? (valor.trim() || null) : true)

  return (
    <div className="dlg-overlay"
         onMouseDown={(e) => {
           if (e.target === e.currentTarget) onResolver(pedido.tipo === 'perguntar' ? null : false)
         }}>
      <div className="dlg-caixa" role="dialog" aria-modal="true">
        <h2 className="dlg-titulo">{pedido.titulo}</h2>
        {pedido.texto && <p className="dlg-texto">{pedido.texto}</p>}

        {pedido.tipo === 'perguntar' && (
          <input
            ref={inputRef}
            className="dlg-input"
            value={valor}
            placeholder={pedido.placeholder || ''}
            onChange={(e) => setValor(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirmar() }}
          />
        )}

        <div className="dlg-acoes">
          <button
            ref={okRef}
            type="button"
            className={`dlg-btn ${pedido.perigo ? 'perigo' : 'ok'}`}
            onClick={confirmar}
            disabled={pedido.tipo === 'perguntar' && !valor.trim()}
          >
            {pedido.rotuloOk || (pedido.perigo ? 'Excluir' : 'Confirmar')}
          </button>
          <button
            type="button"
            className="dlg-btn cancelar"
            onClick={() => onResolver(pedido.tipo === 'perguntar' ? null : false)}
          >
            {pedido.rotuloCancelar || 'Cancelar'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function DialogoProvider({ children }) {
  const [pedido, setPedido] = useState(null)
  const resolverRef = useRef(null)

  const abrir = useCallback((tipo, opcoes) => new Promise((resolve) => {
    resolverRef.current = resolve
    setPedido({ tipo, ...(typeof opcoes === 'string' ? { titulo: opcoes } : opcoes) })
  }), [])

  const resolver = useCallback((r) => {
    setPedido(null)
    resolverRef.current?.(r)
    resolverRef.current = null
  }, [])

  const api = useRef({
    confirmar: (o) => abrir('confirmar', o),
    perguntar: (o) => abrir('perguntar', o),
  }).current

  return (
    <DialogoCtx.Provider value={api}>
      {children}
      {pedido && <Caixa pedido={pedido} onResolver={resolver} />}
    </DialogoCtx.Provider>
  )
}
