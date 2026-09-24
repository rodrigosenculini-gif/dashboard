import { useCallback, useEffect, useRef, useState } from 'react'

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
  const [minutosLivres, setMinutosLivres] = useState('')
  const [salvando, setSalvando] = useState(false)
  const tituloRef = useRef(null)
  const ehGestao = escopo === 'gestao'
  // na gestao da pra escolher pra quem e a tarefa e ver as de todas
  const [paraQuem, setParaQuem] = useState('')
  const [vendedoras, setVendedoras] = useState([])
  const [aba, setAba] = useState('tarefas')   // tarefas | regras
  const [regras, setRegras] = useState([])

  const vencidas = tarefas.filter((t) => t.vencida)
  const aFalar = nota || vencidas[0] || null
  const pendencias = (nota ? 1 : 0) + vencidas.length

  const carregar = useCallback(async () => {
    if (!vendedor) return
    try {
      const [tf, nt] = await Promise.all([
        (escopo === 'gestao'
          ? getJson('tarefas_gestao', {})
          : getJson('tarefas_pendentes', { vendedor })).catch(() => []),
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

  useEffect(() => {
    if (!ehGestao || !painel) return
    getJson('vendedoras_lista').then((r) => setVendedoras(Array.isArray(r) ? r : [])).catch(() => {})
    getJson('regras_listar').then((r) => setRegras(Array.isArray(r) ? r : [])).catch(() => {})
  }, [ehGestao, painel])

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
        vendedor: ehGestao ? (paraQuem || vendedor) : vendedor,
        titulo: t,
        minutos: minutos ?? null,
        quando: minutos ? null : (quandoCustom || null),
      })
      setTitulo(''); setQuandoCustom(''); setMinutosLivres('')
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
            <strong>{ehGestao ? 'Lembretes da equipe' : 'Meus lembretes'}</strong>
            <button type="button" className="mascote-fechar" onClick={() => setPainel(false)}>&times;</button>
          </div>

          {ehGestao && (
            <div className="home-toggle mascote-abas">
              <button type="button" className={aba === 'tarefas' ? 'on' : ''}
                      onClick={() => setAba('tarefas')}>Tarefas</button>
              <button type="button" className={aba === 'regras' ? 'on' : ''}
                      onClick={() => setAba('regras')}>Lembretes</button>
            </div>
          )}

          {ehGestao && aba === 'regras' ? (
            <ul className="mascote-lista regras">
              {regras.length === 0 && <li className="vazio">nenhum lembrete cadastrado</li>}
              {regras.map((r) => (
                <li key={r.id} className={r.ativo ? '' : 'inativa'}>
                  <div>
                    <span className="mascote-tit">{r.mensagem}</span>
                    <span className="mascote-hora">
                      a cada {r.intervalo_min} min · {String(r.hora_ini).slice(0,5)}–{String(r.hora_fim).slice(0,5)} · {r.escopo}
                    </span>
                  </div>
                  <div className="mascote-linha-acoes">
                    <button type="button" title={r.ativo ? 'Desligar' : 'Ligar'}
                      onClick={async () => {
                        await postJson('regra_salvar', { id: r.id, ativo: !r.ativo })
                        getJson('regras_listar').then((x) => setRegras(Array.isArray(x) ? x : []))
                      }}>{r.ativo ? 'on' : 'off'}</button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
          <>
          {ehGestao && (
            <select className="mascote-input" value={paraQuem}
                    onChange={(e) => setParaQuem(e.target.value)}>
              <option value="">para quem? (todas veem a sua)</option>
              {vendedoras.map((v) => <option key={v.vendedor} value={v.vendedor}>{v.vendedor}</option>)}
            </select>
          )}
          <input ref={tituloRef} className="mascote-input" value={titulo} maxLength={120}
                 placeholder="o que lembrar?" onChange={(e) => setTitulo(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter' && titulo.trim()) criar(30) }} />
          <div className="mascote-atalhos">
            {ATALHOS.map((a) => (
              <button key={a.min} type="button" className="mascote-chip"
                      disabled={!titulo.trim() || salvando} onClick={() => criar(a.min)}>{a.rotulo}</button>
            ))}
          </div>
          {/* minutos livres, alem dos atalhos */}
          <div className="mascote-data">
            <input type="number" min="1" max="10080" value={minutosLivres} placeholder="min"
                   style={{ width: 70 }}
                   onChange={(e) => setMinutosLivres(e.target.value)} />
            <button type="button" className="mascote-chip"
                    disabled={!titulo.trim() || !minutosLivres || salvando}
                    onClick={() => criar(Number(minutosLivres))}>criar</button>
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
                  <span className="mascote-hora">
                    {ehGestao && t.vendedor ? `${t.vendedor} · ` : ''}{fmtQuando(t.lembrar_em)}
                  </span>
                </div>
                <div className="mascote-linha-acoes">
                  <button type="button" onClick={() => acaoTarefa(t.id, 'concluir')} title="Concluir">&#10003;</button>
                  <button type="button" onClick={() => acaoTarefa(t.id, 'adiar', 10)} title="Adiar 10 min">+10</button>
                </div>
              </li>
            ))}
          </ul>
          </>
          )}
        </div>
      )}

      <button type="button" className="mascote-botao" onClick={() => setPainel((v) => !v)}
              title="Meus lembretes">
        <img src={MASCOTE} alt="Esquentadinho" />
        {pendencias > 0 && <span className="mascote-selo">{pendencias}</span>}
      </button>
    </>
  )

  // A janela flutuante (Picture-in-Picture) saiu: a extensao do Chrome cobre
  // melhor o mesmo caso -- aparece em qualquer site, sem clique por sessao.
  return (
    <div className={`mascote-flut ${pendencias ? 'chamando' : ''}`}>
      {conteudo}
    </div>
  )
}
