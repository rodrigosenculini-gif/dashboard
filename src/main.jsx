import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Rede de seguranca: sem isto, um erro de runtime em qualquer view derruba
// a arvore inteira e o usuario ve so uma tela preta, sem pista nenhuma.
class LimiteDeErro extends React.Component {
  constructor(props) {
    super(props)
    this.state = { erro: null }
  }
  static getDerivedStateFromError(erro) {
    return { erro }
  }
  componentDidCatch(erro, info) {
    console.error('Falha na renderizacao:', erro, info)
  }
  render() {
    if (!this.state.erro) return this.props.children
    return (
      <div className="tela-erro">
        <h1>O dashboard travou nesta tela.</h1>
        <p>
          Recarregue a pagina. Se continuar, limpe os dados guardados no navegador
          com o botao abaixo &mdash; isso nao apaga nada do Supabase.
        </p>
        <pre>{String(this.state.erro?.message || this.state.erro)}</pre>
        <div className="tela-erro-botoes">
          <button onClick={() => window.location.reload()}>Recarregar</button>
          <button
            onClick={() => {
              try {
                Object.keys(localStorage)
                  .filter((k) => k.startsWith('dash_cache_v1:') || k === 'disparos_dashboard_view')
                  .forEach((k) => localStorage.removeItem(k))
              } catch { /* ignora */ }
              window.location.reload()
            }}
          >
            Limpar dados locais e recarregar
          </button>
        </div>
      </div>
    )
  }
}

// Barra de rolagem: só fica visível enquanto a página está rolando de
// verdade. `capture: true` no document pega o evento de qualquer área
// rolável (não só a janela), sem precisar de um listener por elemento.
let scrollHideTimer
document.addEventListener(
  'scroll',
  () => {
    document.documentElement.classList.add('is-scrolling')
    clearTimeout(scrollHideTimer)
    scrollHideTimer = setTimeout(() => {
      document.documentElement.classList.remove('is-scrolling')
    }, 1100)
  },
  { capture: true, passive: true }
)

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <LimiteDeErro>
      <App />
    </LimiteDeErro>
  </React.StrictMode>
)
