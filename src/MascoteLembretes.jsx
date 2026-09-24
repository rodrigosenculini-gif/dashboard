import { useCallback, useEffect, useRef, useState } from 'react'
import { useJanelaFlutuante } from './useJanelaFlutuante'

const MASCOTE = 'https://hotlinesolucoes.com.br/wp-content/uploads/2024/08/macote.png'

async function getJson(type, params) {
  const qs = new URLSearchParams({ type, ...(params || {}) })
  const res = await fetch(`/api/dashboard?${qs}`)
  if (!res.ok) throw new Error('falha')
  return res.json()
}
async function postJson(type, body) {
  const res = await fetch(`/api/dashboard?type=${type}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('falha')
  return res.json()
}

const CHECAGEM_MS = 30 * 1000
const ATALHOS = [
  { rotulo: '15 min', min: 15 },
  { rotulo: '30 min', min: 30 },
  { rotulo: '1 h', min: 60 },
  { rotulo: '2 h', min: 120 },
]

const fmtQuando = (iso) => {
  const d = new Date(iso)
  const hoje = new Date()
  const mesmoDia = d.toDateString() === hoje.toDateString()
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return mesmoDia ? hora : `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${hora}`
}

/**
 * Esquentadinho flutuante: fica discreto num canto e "fala" quando ha algo.
 *
 * Mostra duas coisas:
 *  - os lembretes periodicos da gestao (notificacoes_regras), com Sim/Nao
 *  - as tarefas que a propria vendedora criou, com concluir/adiar
 *
 * Clicar no mascote abre o painel, onde ela cadastra tarefas novas.
 */
export default function MascoteLembretes({ vendedor, escopo = 'vendedora' }) {
  const [nota, setNota] = useState(null)      // lembrete da gestao
  const [tarefas, setTarefas] = useState([])
  const [painel, setPainel] = useState(false)
  const [titulo, setTitulo] = useState('')
  const [quandoCustom, setQuandoCustom] = useState('')
  const [salvando, setSalvando] = useState(false)
  const tituloRef = useRef(null)
  const pip = useJanelaFlutuante()

  const vencidas = tarefas.filter((t) => t.vencida)
  const aFalar = nota || vencidas[0] || null
  const pendencias = (nota ? 1 : 0) + vencidas.length

  const carregar = useCallback(async () => {
    if (!vendedor) return
    try {
      const [tf, nt] = await Promise.all([
        getJson('tarefas_pendentes', { vendedor }).catch(() => []),
        nota ? Promise.resolve(null) : getJson('notificacao_pendente', { vendedor, escopo }).catch(() => null),
      ])
      setTarefas(Array.isArray(tf) ? tf : [])
      const n = Array.isArray(nt) ? nt[0] : null
      if (n?.regra_id && !nota) {
        // grava que foi mostrada antes de exibir: se fechar a aba, o
        // "nao respondeu" fica registrado
        const m = await postJson('notificacao_mostrada', { regra_id: n.regra_id, vendedor })
        setNota({ id: m?.r ?? m, mensagem: n.mensagem })
      }
    } catch { /* o mascote nunca atrapalha a tela */ }
  }, [vendedor, escopo, nota])

  useEffect(() => {
    carregar()
    const t = setInterval(carregar, CHECAGEM_MS)
    return () => clearInterval(t)
  }, [carregar])

  // com a aba em segundo plano, chama na barra de abas
  useEffect(() => {
    if (!pendencias) return
    const original = document.title
    let alterna = true
    const t = setInterval(() => {
      if (document.hidden) { document.title = alterna ? '🔔 Lembrete no dashboard' : original; alterna = !alterna }
      else document.title = original
    }, 1200)
    return () => { clearInterval(t); document.title = original }
  }, [pendencias])

  const responder = async (resposta) => {
    if (!nota) return
    try { await postJson('notificacao_responder', { id: nota.id, resposta }) } catch { /* segue */ }
    setNota(null)
  }

  const acaoTarefa = async (id, acao, minutos) => {
    try { await postJson('tarefa_acao', { id, acao, minutos }) } catch { /* segue */ }
    carregar()
  }

  const criar = async (minutos) => {
    const t = titulo.trim()
    if (!t || salvando) return
    setSalvando(true)
    try {
      await postJson('tarefa_criar', {
        vendedor, titulo: t,
        minutos: minutos ?? null,
        quando: minutos ? null : (quandoCustom || null),
      })
      setTitulo(''); setQuandoCustom('')
      carregar()
      tituloRef.current?.focus()
    } catch { /* segue */ }
    finally { setSalvando(false) }
  }

  if (!vendedor) return null

  // mesmo conteudo nos dois lugares: na pagina e na janela flutuante
  const conteudo = (
    <>
      {/* balao: so aparece quando ha algo a dizer */}
      {aFalar && !painel && (
        <div className="mascote-balao">
          {nota ? (
            <>
              <p>{nota.mensagem}</p>
              <div className="mascote-acoes">
                <button type="button" className="mascote-btn sim" onClick={() => responder('sim')}>Sim</button>
                <button type="button" className="mascote-btn nao" onClick={() => responder('nao')}>N&atilde;o</button>
              </div>
            </>
          ) : (
            <>
              <p><strong>{vencidas[0].titulo}</strong></p>
              <div className="mascote-acoes">
                <button type="button" className="mascote-btn sim" onClick={() => acaoTarefa(vencidas[0].id, 'concluir')}>Feito</button>
                <button type="button" className="mascote-btn" onClick={() => acaoTarefa(vencidas[0].id, 'adiar', 10)}>+10 min</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* painel: tarefas dela e o cadastro de novas */}
      {painel && (
        <div className="mascote-painel">
          <div className="mascote-painel-topo">
            <strong>Meus lembretes</strong>
            <button type="button" className="mascote-fechar" onClick={() => setPainel(false)}>&times;</button>
          </div>

          <input ref={tituloRef} className="mascote-input" value={titulo} maxLength={120}
                 placeholder="o que lembrar?" onChange={(e) => setTitulo(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter' && titulo.trim()) criar(30) }} />
          <div className="mascote-atalhos">
            {ATALHOS.map((a) => (
              <button key={a.min} type="button" className="mascote-chip"
                      disabled={!titulo.trim() || salvando} onClick={() => criar(a.min)}>{a.rotulo}</button>
            ))}
          </div>
          <div className="mascote-data">
            <input type="datetime-local" value={quandoCustom}
                   onChange={(e) => setQuandoCustom(e.target.value)} />
            <button type="button" className="mascote-chip"
                    disabled={!titulo.trim() || !quandoCustom || salvando}
                    onClick={() => criar(null)}>criar</button>
          </div>

          <ul className="mascote-lista">
            {tarefas.length === 0 && <li className="vazio">nenhum lembrete por aqui</li>}
            {tarefas.map((t) => (
              <li key={t.id} className={t.vencida ? 'vencida' : ''}>
                <div>
                  <span className="mascote-tit">{t.titulo}</span>
                  <span className="mascote-hora">{fmtQuando(t.lembrar_em)}</span>
                </div>
                <div className="mascote-linha-acoes">
                  <button type="button" onClick={() => acaoTarefa(t.id, 'concluir')} title="Concluir">&#10003;</button>
                  <button type="button" onClick={() => acaoTarefa(t.id, 'adiar', 10)} title="Adiar 10 min">+10</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button type="button" className="mascote-botao" onClick={() => setPainel((v) => !v)}
              title="Meus lembretes">
        <img src={MASCOTE} alt="Esquentadinho" />
        {pendencias > 0 && <span className="mascote-selo">{pendencias}</span>}
      </button>
    </>
  )

  // Com a janela flutuante aberta, o conteudo vai pra la -- ela fica por cima
  // de tudo, mesmo com o Chrome em outra aba. Na pagina fica so o atalho pra
  // trazer de volta.
  if (pip.janela) {
    return (
      <>
        <div className="mascote-flut">
          <button type="button" className="mascote-voltar" onClick={pip.fechar}
                  title="Trazer os lembretes de volta pra esta tela">
            <img src={MASCOTE} alt="" />
            <span>lembretes na janelinha</span>
          </button>
        </div>
        <pip.Portal>
          <div className={`mascote-flut na-janela ${pendencias ? 'chamando' : ''}`}>{conteudo}</div>
        </pip.Portal>
      </>
    )
  }

  return (
    <div className={`mascote-flut ${pendencias ? 'chamando' : ''}`}>
      {pip.suportado && (
        <button type="button" className="mascote-destacar" onClick={() => pip.abrir()}
                title="Abrir numa janelinha que fica por cima das outras telas">
          &#11021; destacar
        </button>
      )}
      {conteudo}
    </div>
  )
}
