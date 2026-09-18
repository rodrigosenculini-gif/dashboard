import React, { useCallback, useEffect, useState } from 'react'
import TrelloDocs from './TrelloDocs'

import { callApi, useRevisaoCache } from './dadosCache'

const getJson = (type, params = {}, opts) => callApi(type, params, opts)
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

function CardEditor({ card, listas, responsaveis = [], tags = [], onFechar, onSalvo }) {
  const [f, setF] = useState({
    id: null, titulo: '', descricao: '', responsavel: '',
    prazo: '', prioridade: 'media', etiquetas: [], checklist: [], concluido: false, ...card,
    // depois do spread: card.lista_id undefined sobrescrevia o default e a
    // tarefa voltava pra primeira lista (Backlog) a cada edicao
    lista_id: card?.lista_id ?? listas[0]?.id,
  })
  const [novoItem, setNovoItem] = useState('')
  // comeca em checklist se a tarefa ja tem itens e nao tem descricao
  const [descComoCheck, setDescComoCheck] = useState(
    (card?.checklist?.length || 0) > 0 && !card?.descricao,
  )
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
            {/* a descricao pode virar checklist: cada linha do texto vira um
                item, e voltando pra texto os itens viram linhas de novo --
                assim nada se perde na troca */}
            <div className="home-toggle" style={{ marginBottom: 6 }}>
              <button type="button" className={!descComoCheck ? 'on' : ''}
                onClick={() => {
                  if (!descComoCheck) return
                  // checklist -> texto: cada item vira uma linha
                  const linhas = (f.checklist || []).map((c) => c.texto).filter(Boolean)
                  if (linhas.length) set('descricao', [f.descricao, ...linhas].filter(Boolean).join('\n'))
                  set('checklist', [])
                  setDescComoCheck(false)
                }}>Texto</button>
              <button type="button" className={descComoCheck ? 'on' : ''}
                onClick={() => {
                  if (descComoCheck) return
                  // texto -> checklist: cada linha vira um item
                  const linhas = (f.descricao || '').split('\n').map((x) => x.trim()).filter(Boolean)
                  if (linhas.length) {
                    set('checklist', [...(f.checklist || []), ...linhas.map((t) => ({ texto: t, feito: false }))])
                    set('descricao', '')
                  }
                  setDescComoCheck(true)
                }}>Checklist</button>
            </div>
            {!descComoCheck && (
              <textarea className="chip-input" rows={3} value={f.descricao || ''}
                        onChange={(e) => set('descricao', e.target.value)} placeholder="Contexto, links, critério de pronto" />
            )}
            {descComoCheck && (
              <p className="section-sub" style={{ margin: 0 }}>
                Os itens ficam no Checklist abaixo.
              </p>
            )}
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
              {/* datalist: os nomes ja usados aparecem como sugestao, e o
                  campo continua livre pra um nome novo */}
              <input className="chip-input" value={f.responsavel || ''} list="trello-responsaveis"
                     onChange={(e) => set('responsavel', e.target.value)}
                     onBlur={(e) => {
                       // "rodirgo" / "rodrigo" -> usa o nome ja cadastrado
                       const v = e.target.value.trim()
                       if (!v) return
                       const igual = responsaveis.find((r) => r.toLowerCase() === v.toLowerCase())
                       if (igual && igual !== v) set('responsavel', igual)
                     }}
                     placeholder="Quem toca" />
              <datalist id="trello-responsaveis">
                {responsaveis.map((r) => <option key={r} value={r} />)}
              </datalist>
            </div>
            <div className="chip-campo">
              <label>Prazo</label>
              <input type="date" className="chip-input" value={f.prazo || ''} onChange={(e) => set('prazo', e.target.value)} />
            </div>
          </div>

          {tags.length > 0 && (
            <div className="chip-campo">
              <label>Tags</label>
              <div className="chip-opcoes">
                {tags.map((t) => {
                  const on = (f.etiquetas || []).includes(t.nome)
                  return (
                    <button key={t.id} type="button"
                      className={`trello-tag cor-${t.cor} ${on ? 'on' : ''}`}
                      onClick={() => set('etiquetas', on
                        ? f.etiquetas.filter((x) => x !== t.nome)
                        : [...(f.etiquetas || []), t.nome])}>
                      {t.nome}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

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
  // quadro (padrao) | agenda (por prazo) | documento (tudo aberto com checklist)
  const [visao, setVisao] = useState('quadro')
  const [tagSel, setTagSel] = useState([])

  const revisaoCache = useRevisaoCache()

  const carregar = useCallback(async (opts) => {
    setCarregando(true); setErro(null)
    try { setDados(await getJson('trello_quadro', {}, opts)) }
    catch (e) { setErro(e.message) }
    finally { setCarregando(false) }
  }, [revisaoCache])
  useEffect(() => { carregar() }, [carregar])

  const listas = dados?.listas || []
  const total = listas.reduce((s, l) => s + l.cards.length, 0)
  // nomes ja usados, pra nao redigitar a cada tarefa
  const tags = dados?.tags || []
  // filtro por tag: card entra se tiver QUALQUER uma das tags marcadas
  const listasFiltradas = !tagSel.length ? listas : listas.map((l) => ({
    ...l,
    cards: l.cards.filter((c) => (c.etiquetas || []).some((e) => tagSel.includes(e))),
  }))
  // agenda: agrupa por prazo em faixas, atrasado primeiro
  const agenda = (() => {
    const hoje = hojeISO()
    const emDias = (n) => { const d = new Date(hoje); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }
    const fim7 = emDias(7)
    const grupos = [
      { id: 'atrasado', titulo: 'Atrasadas', cards: [] },
      { id: 'hoje', titulo: 'Hoje', cards: [] },
      { id: 'semana', titulo: 'Próximos 7 dias', cards: [] },
      { id: 'depois', titulo: 'Mais adiante', cards: [] },
      { id: 'sem', titulo: 'Sem prazo', cards: [] },
    ]
    listasFiltradas.forEach((l) => l.cards.forEach((c) => {
      const item = { ...c, listaNome: l.nome }
      if (c.concluido) return
      if (!c.prazo) grupos[4].cards.push(item)
      else if (c.prazo < hoje) grupos[0].cards.push(item)
      else if (c.prazo === hoje) grupos[1].cards.push(item)
      else if (c.prazo <= fim7) grupos[2].cards.push(item)
      else grupos[3].cards.push(item)
    }))
    grupos.forEach((g) => g.cards.sort((a, b) => (a.prazo || '9999').localeCompare(b.prazo || '9999')))
    return grupos.filter((g) => g.cards.length)
  })()

  const responsaveis = [...new Set(
    listas.flatMap((l) => l.cards.map((c) => (c.responsavel || '').trim())).filter(Boolean),
  )].sort((a, b) => a.localeCompare(b))

  async function soltar(listaId, indice) {
    if (!arrastando) return
    setAlvo(null)
    const id = arrastando
    setArrastando(null)
    await postJson('trello_card_mover', { id, lista_id: listaId, ordem: indice })
    carregar({ forcar: true })
  }

  // marcar item do checklist sem abrir o card
  async function marcarItem(itemId, feito) {
    setDados((d) => !d ? d : ({ ...d, listas: d.listas.map((l) => ({
      ...l,
      cards: l.cards.map((c) => ({
        ...c,
        checklist: (c.checklist || []).map((k) => (k.id === itemId ? { ...k, feito } : k)),
        checklist_feito: (c.checklist || []).some((k) => k.id === itemId)
          ? (c.checklist || []).filter((k) => (k.id === itemId ? feito : k.feito)).length
          : c.checklist_feito,
      })),
    })) }))
    try { await postJson('trello_check_marcar', { id: itemId, feito }) }
    catch { carregar({ forcar: true }) }
  }

  async function novaLista() {
    const nome = window.prompt('Nome da nova lista')
    if (!nome?.trim()) return
    await postJson('trello_lista_salvar', { quadro_id: dados.quadro.id, nome: nome.trim() })
    carregar({ forcar: true })
  }

  return (
    <>
      <div className="topbar">
        <h1><span className="pulse" /> {dados?.quadro?.nome || 'Trello'}</h1>
        <div className="topbar-right">
          <span className="status-line">{carregando ? 'carregando...' : `${total} tarefa(s)`}</span>
          <button className="reset-btn" onClick={onVoltar}>&#8592; Início</button>
          <button className="refresh-btn" onClick={() => carregar({ forcar: true })} disabled={carregando}>&#8635; Atualizar</button>
          <div className="home-toggle">
            <button type="button" className={visao === 'quadro' ? 'on' : ''} onClick={() => setVisao('quadro')}>Quadro</button>
            <button type="button" className={visao === 'agenda' ? 'on' : ''} onClick={() => setVisao('agenda')}>Agenda</button>
            <button type="button" className={visao === 'docs' ? 'on' : ''} onClick={() => setVisao('docs')}>Docs</button>
          </div>
          {visao === 'quadro' && <button className="reset-btn" onClick={novaLista}>+ Lista</button>}
        </div>
      </div>

      {erro && <div className="state-msg error">Erro: {erro}</div>}

      {/* filtro por tag: clica pra ligar/desligar, vazio = todas */}
      {tags.length > 0 && (
        <div className="filters trello-tags-filtro">
          {tags.map((t) => (
            <button key={t.id} type="button"
              className={`trello-tag cor-${t.cor} ${tagSel.includes(t.nome) ? 'on' : ''}`}
              onClick={() => setTagSel((s) => s.includes(t.nome) ? s.filter((x) => x !== t.nome) : [...s, t.nome])}>
              {t.nome}
            </button>
          ))}
          {tagSel.length > 0 && (
            <button type="button" className="reset-btn" onClick={() => setTagSel([])}>limpar</button>
          )}
        </div>
      )}

      {visao === 'docs' && (
        <TrelloDocs quadroId={dados?.quadro?.id}
          cards={listas.flatMap((l) => l.cards.map((c) => ({ id: c.id, titulo: c.titulo })))} />
      )}

      {visao === 'agenda' && (
        <div className="trello-agenda">
          {agenda.map((g) => (
            <section key={g.id} className={`trello-agenda-grupo ${g.id}`}>
              <header><h2>{g.titulo}</h2><span className="trello-contador">{g.cards.length}</span></header>
              {g.cards.map((c) => (
                <article key={c.id} className={`trello-card prio-${c.prioridade}`} onClick={() => setEditando(c)}>
                  <h3>{c.titulo}</h3>
                  <div className="trello-card-pe">
                    <span className="trello-pessoa">{c.listaNome}</span>
                    {c.responsavel && <span className="trello-pessoa">{c.responsavel}</span>}
                    {c.prazo && <span className={`trello-prazo ${g.id === 'atrasado' ? 'atrasado' : ''}`}>{fmtData(c.prazo)}</span>}
                    {c.checklist_total > 0 && <span className="trello-checkcount">{c.checklist_feito}/{c.checklist_total}</span>}
                  </div>
                </article>
              ))}
            </section>
          ))}
          {!agenda.length && <p className="home-vazio">Nenhuma tarefa em aberto.</p>}
        </div>
      )}

      {visao === 'quadro' && (
      <div className="trello-quadro">
        {listasFiltradas.map((l) => (
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
                    {/* checklist direto no card: da pra marcar sem abrir, e
                        rola quando a lista e longa */}
                    {(c.checklist || []).length > 0 && (
                      <ul className="trello-card-check" onClick={(e) => e.stopPropagation()}>
                        {c.checklist.map((k) => (
                          <li key={k.id} className={k.feito ? 'feito' : ''}>
                            <label>
                              <input type="checkbox" checked={!!k.feito}
                                onChange={() => marcarItem(k.id, !k.feito)} />
                              <span>{k.texto}</span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                    {(c.etiquetas || []).length > 0 && (
                      <div className="trello-card-tags">
                        {c.etiquetas.map((e) => {
                          const t = tags.find((x) => x.nome === e)
                          return <span key={e} className={`trello-tag cor-${t?.cor || 'muted'}`}>{e}</span>
                        })}
                      </div>
                    )}
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
      )}

      {editando && (
        <CardEditor card={editando} listas={listas} responsaveis={responsaveis} tags={tags}
                    onFechar={() => setEditando(null)}
                    onSalvo={() => { setEditando(null); carregar({ forcar: true }) }} />
      )}
    </>
  )
}
