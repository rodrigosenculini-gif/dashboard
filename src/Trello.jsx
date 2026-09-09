import React, { useCallback, useEffect, useState } from 'react'

async function getJson(type, params = {}) {
  const qs = new URLSearchParams({ type, ...params })
  const res = await fetch(`/api/dashboard?${qs.toString()}`)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Erro ao buscar ${type}`)
  return data
}
async function postJson(type, body) {
  const res = await fetch(`/api/dashboard?type=${type}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Erro ao enviar ${type}`)
  return data
}

const PRIORIDADES = [
  { id: 'baixa', label: 'Baixa' },
  { id: 'media', label: 'Média' },
  { id: 'alta', label: 'Alta' },
  { id: 'urgente', label: 'Urgente' },
]
const fmtData = (d) => (d ? String(d).split('-').reverse().join('/') : '')
const hojeISO = () => new Date().toISOString().slice(0, 10)

function CardEditor({ card, listas, onFechar, onSalvo }) {
  const [f, setF] = useState({
    id: null, lista_id: listas[0]?.id, titulo: '', descricao: '', responsavel: '',
    prazo: '', prioridade: 'media', etiquetas: [], checklist: [], concluido: false, ...card,
  })
  const [novoItem, setNovoItem] = useState('')
  const [salvando, setSalvando] = useState(false)
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }))

  const addItem = () => {
    const t = novoItem.trim()
    if (!t) return
    set('checklist', [...(f.checklist || []), { texto: t, feito: false }])
    setNovoItem('')
  }
  const toggleItem = (i) =>
    set('checklist', f.checklist.map((c, j) => (j === i ? { ...c, feito: !c.feito } : c)))
  const removeItem = (i) => set('checklist', f.checklist.filter((_, j) => j !== i))

  async function salvar() {
    if (!f.titulo.trim()) return
    setSalvando(true)
    try {
      await postJson('trello_card_salvar', { ...f, etiquetas: f.etiquetas || [] })
      onSalvo()
    } finally {
      setSalvando(false)
    }
  }
  async function excluir() {
    if (!f.id || !window.confirm('Excluir esta tarefa?')) return
    await postJson('trello_card_excluir', { id: f.id })
    onSalvo()
  }

  return (
    <div className="chip-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onFechar() }}>
      <div className="chip-editor">
        <header className="chip-editor-top">
          <h3>{f.id ? 'Editar tarefa' : 'Nova tarefa'}</h3>
          <button className="chip-x" onClick={onFechar} aria-label="Fechar">&#10005;</button>
        </header>

        <div className="chip-editor-corpo">
          <div className="chip-campo">
            <label>Título</label>
            <input className="chip-input" value={f.titulo} autoFocus
                   onChange={(e) => set('titulo', e.target.value)} placeholder="O que precisa ser feito" />
          </div>

          <div className="chip-campo">
            <label>Descrição</label>
            <textarea className="chip-input" rows={3} value={f.descricao || ''}
                      onChange={(e) => set('descricao', e.target.value)} placeholder="Contexto, links, critério de pronto" />
          </div>

          <div className="chip-linha-3">
            <div className="chip-campo">
              <label>Lista</label>
              <select className="chip-input" value={f.lista_id} onChange={(e) => set('lista_id', Number(e.target.value))}>
                {listas.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
              </select>
            </div>
            <div className="chip-campo">
              <label>Responsável</label>
              <input className="chip-input" value={f.responsavel || ''}
                     onChange={(e) => set('responsavel', e.target.value)} placeholder="Quem toca" />
            </div>
            <div className="chip-campo">
              <label>Prazo</label>
              <input type="date" className="chip-input" value={f.prazo || ''} onChange={(e) => set('prazo', e.target.value)} />
            </div>
          </div>

          <div className="chip-campo">
            <label>Prioridade</label>
            <div className="chip-opcoes">
              {PRIORIDADES.map((p) => (
                <button key={p.id} type="button" className={`chip-opcao prio-${p.id} ${f.prioridade === p.id ? 'on' : ''}`}
                        onClick={() => set('prioridade', p.id)}>{p.label}</button>
              ))}
            </div>
          </div>

          <div className="chip-campo">
            <label>Checklist</label>
            {(f.checklist || []).map((c, i) => (
              <div key={i} className="trello-check-item">
                <label>
                  <input type="checkbox" checked={!!c.feito} onChange={() => toggleItem(i)} />
                  <span className={c.feito ? 'feito' : ''}>{c.texto}</span>
                </label>
                <button className="chips-mini chips-mini-perigo" onClick={() => removeItem(i)}>&#10005;</button>
              </div>
            ))}
            <div className="trello-check-add">
              <input className="chip-input" value={novoItem} onChange={(e) => setNovoItem(e.target.value)}
                     onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addItem() } }}
                     placeholder="Adicionar item e apertar Enter" />
              <button className="reset-btn" onClick={addItem}>Adicionar</button>
            </div>
          </div>
        </div>

        <footer className="chip-editor-rodape">
          {f.id && <button className="chips-mini chips-mini-perigo" onClick={excluir}>Excluir tarefa</button>}
          <span style={{ flex: 1 }} />
          <button className="reset-btn" onClick={onFechar}>Cancelar</button>
          <button className="chip-salvar" onClick={salvar} disabled={salvando || !f.titulo.trim()}>
            {salvando ? 'Salvando...' : 'Salvar tarefa'}
          </button>
        </footer>
      </div>
    </div>
  )
}

export default function Trello({ onVoltar }) {
  const [dados, setDados] = useState(null)
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState(null)
  const [editando, setEditando] = useState(null)
  const [arrastando, setArrastando] = useState(null)
  const [alvo, setAlvo] = useState(null)

  const carregar = useCallback(async () => {
    setCarregando(true); setErro(null)
    try { setDados(await getJson('trello_quadro')) }
    catch (e) { setErro(e.message) }
    finally { setCarregando(false) }
  }, [])
  useEffect(() => { carregar() }, [carregar])

  const listas = dados?.listas || []
  const total = listas.reduce((s, l) => s + l.cards.length, 0)

  async function soltar(listaId, indice) {
    if (!arrastando) return
    setAlvo(null)
    const id = arrastando
    setArrastando(null)
    await postJson('trello_card_mover', { id, lista_id: listaId, ordem: indice })
    carregar()
  }

  async function novaLista() {
    const nome = window.prompt('Nome da nova lista')
    if (!nome?.trim()) return
    await postJson('trello_lista_salvar', { quadro_id: dados.quadro.id, nome: nome.trim() })
    carregar()
  }

  return (
    <>
      <div className="topbar">
        <h1><span className="pulse" /> {dados?.quadro?.nome || 'Trello'}</h1>
        <div className="topbar-right">
          <span className="status-line">{carregando ? 'carregando...' : `${total} tarefa(s)`}</span>
          <button className="reset-btn" onClick={onVoltar}>&#8592; Início</button>
          <button className="refresh-btn" onClick={carregar} disabled={carregando}>&#8635; Atualizar</button>
          <button className="reset-btn" onClick={novaLista}>+ Lista</button>
        </div>
      </div>

      {erro && <div className="state-msg error">Erro: {erro}</div>}

      <div className="trello-quadro">
        {listas.map((l) => (
          <section key={l.id} className={`trello-lista cor-${l.cor || 'muted'}`}
                   onDragOver={(e) => { e.preventDefault(); setAlvo(l.id) }}
                   onDragLeave={() => setAlvo((a) => (a === l.id ? null : a))}
                   onDrop={() => soltar(l.id, l.cards.length)}>
            <header className="trello-lista-top">
              <h2>{l.nome}</h2>
              <span className="trello-contador">{l.cards.length}</span>
            </header>

            <div className={`trello-cards ${alvo === l.id ? 'alvo' : ''}`}>
              {l.cards.map((c, i) => {
                const atrasado = c.prazo && c.prazo < hojeISO() && !c.concluido
                return (
                  <article key={c.id} className={`trello-card prio-${c.prioridade} ${c.concluido ? 'feito' : ''}`}
                           draggable onDragStart={() => setArrastando(c.id)}
                           onDragEnd={() => { setArrastando(null); setAlvo(null) }}
                           onDrop={(e) => { e.stopPropagation(); soltar(l.id, i) }}
                           onClick={() => setEditando(c)}>
                    <h3>{c.titulo}</h3>
                    {c.descricao && <p className="trello-card-desc">{c.descricao}</p>}
                    <div className="trello-card-pe">
                      {c.responsavel && <span className="trello-pessoa">{c.responsavel}</span>}
                      {c.prazo && <span className={`trello-prazo ${atrasado ? 'atrasado' : ''}`}>{fmtData(c.prazo)}</span>}
                      {c.checklist_total > 0 && (
                        <span className="trello-checkcount">{c.checklist_feito}/{c.checklist_total}</span>
                      )}
                    </div>
                  </article>
                )
              })}

              <button className="trello-add" onClick={() => setEditando({ lista_id: l.id })}>
                + Adicionar tarefa
              </button>
            </div>
          </section>
        ))}

        {!listas.length && !carregando && (
          <p className="home-vazio">Nenhuma lista ainda. Crie a primeira em &ldquo;+ Lista&rdquo;.</p>
        )}
      </div>

      {editando && (
        <CardEditor card={editando} listas={listas}
                    onFechar={() => setEditando(null)}
                    onSalvo={() => { setEditando(null); carregar() }} />
      )}
    </>
  )
}
