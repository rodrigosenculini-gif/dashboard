import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// Nuvem de arquivos de ajuda das vendedoras.
// - Bytes: Supabase Storage (bucket publico "arquivos-vendedoras"), upload e
//   exclusao feitos direto do navegador (nada pesado passa pela Vercel).
// - Metadados (pastas, nomes, dono): /api/arquivos.
// - dono = null  -> view geral: tudo que for adicionado ali e de todos
// - dono = nome  -> view restrita: ve o geral + o que ela mesma adicionou,
//                   mas so edita o que e dela.

const SUPABASE_URL = 'https://mvzqywdmhdylsuclrqrg.supabase.co'
// chave publica (anon) - restrita por politica ao bucket abaixo
const SUPABASE_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12enF5d2RtaGR5bHN1Y2xycXJnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzAzMTkzMDksImV4cCI6MjA0NTg5NTMwOX0.KG_bZF3Kd4LkX2uOHoBRa8uSXXO7W2NQCo_TIh1VBHw'
const BUCKET = 'arquivos-vendedoras'

const storageHeaders = { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` }

function publicUrl(path) {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
}

async function uploadToStorage(path, file) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      ...storageHeaders,
      'Content-Type': file.type || 'application/octet-stream',
      'x-upsert': 'false',
    },
    body: file,
  })
  if (!res.ok) throw new Error(`Falha ao enviar ${file.name}: ${await res.text()}`)
}

async function deleteFromStorage(paths) {
  if (!paths?.length) return
  await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: { ...storageHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: paths }),
  }).catch(() => {})
}

async function api(type, body) {
  const res = await fetch(`/api/arquivos?type=${type}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.error) throw new Error(data?.error || `Erro em ${type}`)
  return data
}

function slug(s) {
  return String(s || 'geral')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'geral'
}

function fmtBytes(n) {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function extOf(nome) {
  const m = /\.([a-z0-9]+)$/i.exec(nome || '')
  return m ? m[1].toLowerCase() : ''
}

function kindOf(arq) {
  const mime = arq.mime || ''
  const ext = extOf(arq.nome)
  if (mime.startsWith('image/')) return 'imagem'
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'planilha'
  if (['doc', 'docx', 'txt', 'md'].includes(ext)) return 'doc'
  return 'outro'
}

// ---------- icones (linha, no tema) ----------

export function IconePasta({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9.5a2 2 0 0 0-2-2h-7.2a1 1 0 0 1-.8-.4L9.9 5.4A1 1 0 0 0 9.1 5H5a2 2 0 0 0-2 2.5Z" />
    </svg>
  )
}

function IconeArquivoGrande({ kind }) {
  const label = { pdf: 'PDF', planilha: 'XLS', doc: 'DOC', video: 'VID', audio: 'AUD', outro: 'FILE' }[kind] || 'FILE'
  return (
    <div className="nuvem-file-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
        <path d="M14 3v5h5" />
      </svg>
      <span>{label}</span>
    </div>
  )
}

// ---------- previa ----------

function Previa({ arq, grande = false }) {
  const kind = kindOf(arq)
  const url = publicUrl(arq.storage_path)
  if (kind === 'imagem') return <img src={url} alt={arq.nome} loading="lazy" className="nuvem-thumb-img" />
  if (kind === 'pdf') {
    return (
      <iframe
        src={`${url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
        title={arq.nome}
        loading="lazy"
        className={grande ? 'nuvem-preview-frame' : 'nuvem-thumb-frame'}
      />
    )
  }
  if (kind === 'video' && grande) return <video src={url} controls className="nuvem-preview-media" />
  if (kind === 'audio' && grande) return <audio src={url} controls style={{ width: '100%' }} />
  return <IconeArquivoGrande kind={kind} />
}

// ---------- componente principal ----------

export default function ArquivosButton({ dono = null, className = 'reset-btn' }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className={`${className} nuvem-trigger`} title="Arquivos de ajuda" onClick={() => setOpen(true)}>
        <IconePasta size={18} />
        <span>Arquivos</span>
      </button>
      {open && <ArquivosModal dono={dono} onClose={() => setOpen(false)} />}
    </>
  )
}

function ArquivosModal({ dono, onClose }) {
  const donoNorm = dono && dono !== 'geral' ? dono : null
  const [pastas, setPastas] = useState([])
  const [arquivos, setArquivos] = useState([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState('')
  const [pastaAtiva, setPastaAtiva] = useState('todos') // 'todos' | 'raiz' | id
  const [busca, setBusca] = useState('')
  const [preview, setPreview] = useState(null)
  const [enviando, setEnviando] = useState(0) // qtd em andamento
  const fileRef = useRef(null)

  const carregar = useCallback(async () => {
    setLoading(true); setErro('')
    try {
      const r = await api(`listar&dono=${encodeURIComponent(donoNorm || '')}`)
      setPastas(r.data?.pastas || [])
      setArquivos(r.data?.arquivos || [])
    } catch (e) {
      setErro(e.message)
    } finally {
      setLoading(false)
    }
  }, [donoNorm])

  useEffect(() => { carregar() }, [carregar])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') (preview ? setPreview(null) : onClose()) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview, onClose])

  const podeEditar = (item) => (item.dono || null) === donoNorm

  const visiveis = useMemo(() => {
    let lista = arquivos
    if (pastaAtiva === 'raiz') lista = lista.filter((a) => !a.pasta_id)
    else if (pastaAtiva !== 'todos') lista = lista.filter((a) => a.pasta_id === pastaAtiva)
    const b = busca.trim().toLowerCase()
    if (b) lista = lista.filter((a) => a.nome.toLowerCase().includes(b))
    return lista
  }, [arquivos, pastaAtiva, busca])

  const contagem = useMemo(() => {
    const m = {}
    for (const a of arquivos) m[a.pasta_id || 'raiz'] = (m[a.pasta_id || 'raiz'] || 0) + 1
    return m
  }, [arquivos])

  // ---- pastas ----
  async function novaPasta() {
    const nome = window.prompt('Nome da nova pasta:')
    if (!nome?.trim()) return
    try {
      const r = await api('criar_pasta', { nome: nome.trim(), dono: donoNorm })
      setPastas((p) => [...p, r.data])
      setPastaAtiva(r.data.id)
    } catch (e) { setErro(e.message) }
  }

  async function renomearPasta(p) {
    const nome = window.prompt('Novo nome da pasta:', p.nome)
    if (!nome?.trim() || nome.trim() === p.nome) return
    try {
      await api('renomear_pasta', { id: p.id, nome: nome.trim() })
      setPastas((ps) => ps.map((x) => (x.id === p.id ? { ...x, nome: nome.trim() } : x)))
    } catch (e) { setErro(e.message) }
  }

  async function excluirPasta(p) {
    const n = contagem[p.id] || 0
    if (!window.confirm(`Excluir a pasta "${p.nome}"${n ? ` e os ${n} arquivo(s) dentro dela` : ''}?`)) return
    try {
      const r = await api('excluir_pasta', { id: p.id })
      await deleteFromStorage(r.storage_paths)
      setPastas((ps) => ps.filter((x) => x.id !== p.id))
      setArquivos((as) => as.filter((a) => a.pasta_id !== p.id))
      if (pastaAtiva === p.id) setPastaAtiva('todos')
    } catch (e) { setErro(e.message) }
  }

  // ---- arquivos ----
  async function enviarArquivos(files) {
    const lista = Array.from(files || [])
    if (!lista.length) return
    setErro('')
    setEnviando((n) => n + lista.length)
    const pastaDestino = typeof pastaAtiva === 'number' ? pastaAtiva : null
    for (const file of lista) {
      try {
        const nomeLimpo = file.name.replace(/[^\w.\-() ]+/g, '_')
        const path = `${slug(donoNorm)}/${crypto.randomUUID()}-${nomeLimpo}`
        await uploadToStorage(path, file)
        const r = await api('registrar_arquivo', {
          nome: file.name,
          storage_path: path,
          mime: file.type || null,
          tamanho: file.size,
          pasta_id: pastaDestino,
          dono: donoNorm,
        })
        setArquivos((as) => [r.data, ...as])
      } catch (e) {
        setErro(e.message)
      } finally {
        setEnviando((n) => n - 1)
      }
    }
  }

  async function renomearArquivo(a) {
    const nome = window.prompt('Novo nome do arquivo:', a.nome)
    if (!nome?.trim() || nome.trim() === a.nome) return
    try {
      await api('renomear_arquivo', { id: a.id, nome: nome.trim() })
      setArquivos((as) => as.map((x) => (x.id === a.id ? { ...x, nome: nome.trim() } : x)))
    } catch (e) { setErro(e.message) }
  }

  async function moverArquivo(a, pastaId) {
    try {
      await api('mover_arquivo', { id: a.id, pasta_id: pastaId })
      setArquivos((as) => as.map((x) => (x.id === a.id ? { ...x, pasta_id: pastaId } : x)))
    } catch (e) { setErro(e.message) }
  }

  async function excluirArquivo(a) {
    if (!window.confirm(`Excluir "${a.nome}"?`)) return
    try {
      const r = await api('excluir_arquivo', { id: a.id })
      await deleteFromStorage([r.storage_path || a.storage_path])
      setArquivos((as) => as.filter((x) => x.id !== a.id))
      if (preview?.id === a.id) setPreview(null)
    } catch (e) { setErro(e.message) }
  }

  const tituloPasta =
    pastaAtiva === 'todos' ? 'Todos os arquivos'
      : pastaAtiva === 'raiz' ? 'Sem pasta'
        : pastas.find((p) => p.id === pastaAtiva)?.nome || 'Pasta'

  return (
    <div className="ai-chat-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ai-chat-sheet nuvem-sheet">
        <div className="ai-chat-gradient" />

        <div className="ai-chat-header">
          <div>
            <div className="ai-chat-title">Arquivos de ajuda</div>
            <div className="ai-chat-subtitle">
              {donoNorm
                ? 'Seus arquivos e os arquivos gerais da equipe. Você só edita o que é seu.'
                : 'Tudo que for adicionado aqui fica visível para todas as vendedoras.'}
            </div>
          </div>
          <button className="ai-chat-close" onClick={onClose}>✕ Fechar</button>
        </div>

        <div className="nuvem-body">
          {/* ---- lateral: pastas ---- */}
          <aside className="nuvem-side">
            <button
              className={`nuvem-pasta ${pastaAtiva === 'todos' ? 'active' : ''}`}
              onClick={() => setPastaAtiva('todos')}
            >
              <IconePasta size={16} /><span>Todos</span>
              <em>{arquivos.length}</em>
            </button>
            <button
              className={`nuvem-pasta ${pastaAtiva === 'raiz' ? 'active' : ''}`}
              onClick={() => setPastaAtiva('raiz')}
            >
              <IconePasta size={16} /><span>Sem pasta</span>
              <em>{contagem.raiz || 0}</em>
            </button>

            <div className="nuvem-side-label">Pastas</div>
            {pastas.map((p) => (
              <div key={p.id} className={`nuvem-pasta-row ${pastaAtiva === p.id ? 'active' : ''}`}>
                <button className="nuvem-pasta" onClick={() => setPastaAtiva(p.id)} title={p.dono ? 'Sua pasta' : 'Pasta geral'}>
                  <IconePasta size={16} />
                  <span>{p.nome}</span>
                  <em>{contagem[p.id] || 0}</em>
                </button>
                {podeEditar(p) && (
                  <div className="nuvem-pasta-actions">
                    <button title="Renomear" onClick={() => renomearPasta(p)}>✎</button>
                    <button title="Excluir" onClick={() => excluirPasta(p)}>✕</button>
                  </div>
                )}
              </div>
            ))}
            <button className="nuvem-nova-pasta" onClick={novaPasta}>+ Nova pasta</button>
          </aside>

          {/* ---- principal ---- */}
          <section className="nuvem-main">
            <div className="nuvem-toolbar">
              <div className="nuvem-toolbar-title">{tituloPasta}</div>
              <input
                className="nuvem-busca"
                placeholder="Buscar arquivo…"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
              />
              <input
                ref={fileRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => { enviarArquivos(e.target.files); e.target.value = '' }}
              />
              <button className="ai-chat-send nuvem-upload" onClick={() => fileRef.current?.click()} disabled={enviando > 0}>
                {enviando > 0 ? `Enviando ${enviando}…` : '↑ Enviar arquivo'}
              </button>
            </div>

            {erro && <div className="state-msg error" style={{ margin: '0 20px 10px' }}>Erro: {erro}</div>}

            <div
              className="nuvem-grid"
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('drag') }}
              onDragLeave={(e) => e.currentTarget.classList.remove('drag')}
              onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('drag'); enviarArquivos(e.dataTransfer.files) }}
            >
              {loading && <div className="ai-chat-empty">Carregando…</div>}
              {!loading && visiveis.length === 0 && (
                <div className="ai-chat-empty">
                  Nenhum arquivo aqui ainda.<br />
                  <span style={{ opacity: 0.7 }}>Arraste arquivos pra cá ou clique em "Enviar arquivo".</span>
                </div>
              )}
              {visiveis.map((a) => (
                <div key={a.id} className="nuvem-card" onClick={() => setPreview(a)} title={a.nome}>
                  <div className="nuvem-thumb"><Previa arq={a} /></div>
                  <div className="nuvem-card-meta">
                    <div className="nuvem-card-nome">{a.nome}</div>
                    <div className="nuvem-card-sub">
                      {fmtBytes(a.tamanho)}{a.dono ? '' : ' · geral'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* ---- previa grande ---- */}
        {preview && (
          <div className="nuvem-preview" onMouseDown={(e) => { if (e.target === e.currentTarget) setPreview(null) }}>
            <div className="nuvem-preview-box">
              <div className="nuvem-preview-head">
                <div>
                  <div className="ai-chat-title" style={{ fontSize: 16 }}>{preview.nome}</div>
                  <div className="ai-chat-subtitle">
                    {fmtBytes(preview.tamanho)} · {preview.dono ? 'seu arquivo' : 'arquivo geral'}
                  </div>
                </div>
                <div className="nuvem-preview-actions">
                  <a className="reset-btn" href={publicUrl(preview.storage_path)} target="_blank" rel="noreferrer">↗ Abrir</a>
                  <a className="reset-btn" href={publicUrl(preview.storage_path)} download={preview.nome}>↓ Baixar</a>
                  {podeEditar(preview) && (
                    <>
                      <select
                        className="reset-btn"
                        value={preview.pasta_id || ''}
                        onChange={(e) => {
                          const v = e.target.value ? Number(e.target.value) : null
                          moverArquivo(preview, v); setPreview({ ...preview, pasta_id: v })
                        }}
                        title="Mover pra pasta"
                      >
                        <option value="">Sem pasta</option>
                        {pastas.filter((p) => podeEditar(p)).map((p) => (
                          <option key={p.id} value={p.id}>{p.nome}</option>
                        ))}
                      </select>
                      <button className="reset-btn" onClick={() => renomearArquivo(preview).then(() => setPreview((pv) => pv && arquivos.find((x) => x.id === pv.id) || pv))}>✎ Renomear</button>
                      <button className="reset-btn nuvem-danger" onClick={() => excluirArquivo(preview)}>✕ Excluir</button>
                    </>
                  )}
                  <button className="ai-chat-close" onClick={() => setPreview(null)}>Voltar</button>
                </div>
              </div>
              <div className="nuvem-preview-body">
                <Previa arq={preview} grande />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
