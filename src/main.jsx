import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

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
    <App />
  </React.StrictMode>
)
