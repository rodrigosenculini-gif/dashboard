import { useEffect, useRef, useState } from 'react'
import { useDialogo } from './Dialogo'

async function postJson(type, body) {
  const res = await fetch(`/api/dashboard?type=${type}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Erro em ${type}`)
  return data
}

// Um documento e uma lista de blocos. Guardar assim (em vez de HTML) deixa o
// checklist marcavel de verdade e o texto continua pesquisavel no banco.
const BLOCO_NOVO = (tipo = 'texto') => ({
  id: `b${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
  tipo, texto: '', feito: false,
})

const TIPOS = [
  { id: 'titulo', label: 'H1' },
  { id: 'subtitulo', label: 'H2' },
  { id: 'texto', label: 'Texto' },
  { id: 'check', label: 'Checklist' },
  { id: 'divisor', label: '---' },
]

function Bloco({ b, onMudar, onEnter, onRemover, autoFocus }) {
  const ref = useRef(null)
  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])

  const teclas = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onEnter() }
    // backspace no comeco de um bloco vazio remove ele
    if (e.key === 'Backspace' && !b.texto) { e.preventDefault(); onRemover() }
  }

  if (b.tipo === 'divisor') {
    return (
      <div className="doc-bloco doc-divisor">
        <hr />
        <button type="button" className="doc-bloco-x" onClick={onRemover} title="Remover">&times;</button>
      </div>
    )
  }

  return (
    <div className={`doc-bloco doc-${b.tipo}`}>
      {b.tipo === 'check' && (
        <input type="checkbox" checked={!!b.feito}
               onChange={() => onMudar({ ...b, feito: !b.feito })} />
      )}
      <textarea
        ref={ref}
        rows={1}
        className={b.feito ? 'feito' : ''}
        value={b.texto}
        placeholder={b.tipo === 'titulo' ? 'Título' : b.tipo === 'subtitulo' ? 'Subtítulo' : 'Escreva algo...'}
        onChange={(e) => {
          onMudar({ ...b, texto: e.target.value })
          // cresce conforme o texto, sem barra de rolagem interna
          e.target.style.height = 'auto'
          e.target.style.height = `${e.target.scrollHeight}px`
        }}
        onKeyDown={teclas}
      />
      <button type="button" className="doc-bloco-x" onClick={onRemover} title="Remover">&times;</button>
    </div>
  )
}

export default function TrelloDocs({ quadroId, cards = [], onVoltar }) {
  const dialogo = useDialogo()
  const [docs, setDocs] = useState([])
  const [sel, setSel] = useState(null)
  const [carregando, setCarregando] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [sujo, setSujo] = useState(false)
  const [focoId, setFocoId] = useState(null)

  async function carregar(idParaAbrir) {
    setCarregando(true)
    try {
      const qs = new URLSearchParams({ type: 'trello_docs', quadro_id: quadroId ?? '' })
      const r = await (await fetch(`/api/dashboard?${qs}`)).json()
      const lista = r?.[0]?.docs || r?.docs || []
      setDocs(lista)
      const alvo = idParaAbrir ? lista.find((d) => d.id === idParaAbrir) : null
      setSel(alvo || (lista.length ? lista[0] : null))
    } finally { setCarregando(false) }
  }
  useEffect(() => { carregar() }, [quadroId])

  const setBlocos = (blocos) => { setSel((d) => ({ ...d, blocos })); setSujo(true) }

  async function salvar() {
    if (!sel) return
    setSalvando(true)
    try {
      const r = await postJson('trello_doc_salvar', {
        id: sel.id, quadro_id: quadroId, card_id: sel.card_id ?? null,
        titulo: sel.titulo, blocos: sel.blocos || [],
      })
      setSujo(false)
      await carregar(r?.r?.id || sel.id)
    } finally { setSalvando(false) }
  }

  async function novoDoc() {
    const r = await postJson('trello_doc_salvar', {
      quadro_id: quadroId, titulo: 'Sem título',
      blocos: [BLOCO_NOVO('titulo'), BLOCO_NOVO('texto')],
    })
    await carregar(r?.r?.id)
  }

  async function excluirDoc() {
    if (!sel?.id) return
    if (!await dialogo.confirmar({ titulo: 'Excluir documento?', texto: sel.titulo, perigo: true, rotuloOk: 'Excluir' })) return
    await postJson('trello_doc_excluir', { id: sel.id })
    setSel(null)
    await carregar()
  }

  const blocos = sel?.blocos || []
  const mudarBloco = (i, novo) => setBlocos(blocos.map((b, j) => (j === i ? novo : b)))
  const removerBloco = (i) => setBlocos(blocos.filter((_, j) => j !== i))
  const inserirDepois = (i, tipo = 'texto') => {
    const nb = BLOCO_NOVO(tipo)
    setBlocos([...blocos.slice(0, i + 1), nb, ...blocos.slice(i + 1)])
    setFocoId(nb.id)
  }

  return (
    <div className="doc-tela">
      <aside className="doc-lista">
        <header>
          <h2>Documentos</h2>
          <button type="button" className="reset-btn" onClick={novoDoc}>+</button>
        </header>
        {carregando && <p className="home-vazio">carregando...</p>}
        {!carregando && !docs.length && <p className="home-vazio">Nenhum documento ainda.</p>}
        {docs.map((d) => (
          <button key={d.id} type="button"
            className={`doc-item ${sel?.id === d.id ? 'on' : ''}`}
            onClick={() => { setSel(d); setSujo(false) }}>
            <span className="doc-item-nome">{d.titulo}</span>
            {d.card_titulo && <span className="doc-item-card">{d.card_titulo}</span>}
          </button>
        ))}
      </aside>

      <section className="doc-editor">
        {!sel && !carregando && <p className="home-vazio">Escolha um documento à esquerda ou crie um novo.</p>}
        {sel && (
          <>
            <div className="doc-top">
              <input className="doc-titulo" value={sel.titulo}
                onChange={(e) => { setSel({ ...sel, titulo: e.target.value }); setSujo(true) }} />
              <div className="doc-top-acoes">
                {/* vinculo opcional com uma tarefa; por padrao o doc e do quadro */}
                <select value={sel.card_id ?? ''}
                  onChange={(e) => { setSel({ ...sel, card_id: e.target.value ? Number(e.target.value) : null }); setSujo(true) }}>
                  <option value="">documento do quadro</option>
                  {cards.map((c) => <option key={c.id} value={c.id}>{c.titulo}</option>)}
                </select>
                <button type="button" className="refresh-btn" onClick={salvar} disabled={salvando || !sujo}>
                  {salvando ? 'Salvando...' : sujo ? 'Salvar' : 'Salvo'}
                </button>
                <button type="button" className="reset-btn" onClick={excluirDoc}>Excluir</button>
              </div>
            </div>

            <div className="doc-corpo">
              {blocos.map((b, i) => (
                <Bloco key={b.id} b={b} autoFocus={focoId === b.id}
                  onMudar={(nb) => mudarBloco(i, nb)}
                  onEnter={() => inserirDepois(i, b.tipo === 'check' ? 'check' : 'texto')}
                  onRemover={() => removerBloco(i)} />
              ))}
              <div className="doc-add">
                {TIPOS.map((t) => (
                  <button key={t.id} type="button" className="reset-btn"
                    onClick={() => inserirDepois(blocos.length - 1, t.id)}>
                    + {t.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
