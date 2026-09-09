import React, { useCallback, useEffect, useMemo, useState } from 'react'

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

// 17981482653 -> (17) 98148-2653
function fmtFone(f) {
  const s = String(f || '').replace(/\D/g, '')
  if (s.length === 11) return `(${s.slice(0, 2)}) ${s.slice(2, 7)}-${s.slice(7)}`
  if (s.length === 10) return `(${s.slice(0, 2)}) ${s.slice(2, 6)}-${s.slice(6)}`
  return s
}
const fmtData = (d) => (d ? String(d).split('-').reverse().join('/') : '—')

// Opções fixas viram botão — é o que a planilha já usava, só que sem digitar.
const STATUS_WPP = ['CONECTADO', 'DESCONECTADO', 'BANIDO', 'N CONECTAR']
const STATUS_PLAT = ['CONECTADO', 'DESCONECTADO', 'N CONECTAR']
const PLATAFORMAS = ['VENDEAI', 'VENDEAI 2', 'CHATWOOT', 'HUGGY', 'MANYCHAT', 'META', 'NENHUMA']
const OPERADORAS = ['TIM', 'CLARO', 'VIVO', 'OI']

const VAZIO = {
  id: null, telefone: '', operadora: '', responsavel: '', plataforma: '',
  status: 'DESCONECTADO', status_plataforma: '', instancia: '',
  recarregar: true, ultima_recarga: '', proxima_recarga: '', intervalo_dias: 30, observacao: '',
}

function Escolha({ label, valor, opcoes, onChange, permitirLimpar = true }) {
  return (
    <div className="chip-campo">
      <label>{label}</label>
      <div className="chip-opcoes">
        {opcoes.map((o) => (
          <button key={o} type="button"
                  className={`chip-opcao ${valor === o ? 'on' : ''}`}
                  onClick={() => onChange(permitirLimpar && valor === o ? '' : o)}>
            {o}
          </button>
        ))}
      </div>
    </div>
  )
}

function Editor({ chip, opcoes, onFechar, onSalvo }) {
  const [f, setF] = useState({ ...VAZIO, ...chip })
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState('')
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }))

  const instancias = useMemo(
    () => Array.from(new Set([...(opcoes.instancias || [])].filter(Boolean))).sort(),
    [opcoes.instancias]
  )

  async function salvar() {
    const fone = String(f.telefone || '').replace(/\D/g, '')
    if (fone.length < 10) { setErro('Informe o telefone com DDD.'); return }
    setSalvando(true); setErro('')
    try {
      const r = await postJson('chips_salvar', { ...f, telefone: fone })
      if (!r.ok) { setErro(r.erro || 'Não foi possível salvar.'); return }
      onSalvo()
    } catch (e) {
      setErro(e.message)
    } finally {
      setSalvando(false)
    }
  }

  return (
    <div className="chip-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onFechar() }}>
      <div className="chip-editor">
        <header className="chip-editor-top">
          <h3>{f.id ? 'Editar chip' : 'Adicionar chip'}</h3>
          <button className="chip-x" onClick={onFechar} aria-label="Fechar">&#10005;</button>
        </header>

        <div className="chip-editor-corpo">
          <div className="chip-linha-2">
            <div className="chip-campo">
              <label>Telefone</label>
              <input className="chip-input" value={f.telefone} inputMode="numeric"
                     onChange={(e) => set('telefone', e.target.value)} placeholder="17 98148-2653" />
            </div>
            <div className="chip-campo">
              <label>Responsável</label>
              <input className="chip-input" value={f.responsavel || ''}
                     onChange={(e) => set('responsavel', e.target.value)} placeholder="Vendedora, setor ou pessoa" />
            </div>
          </div>

          <Escolha label="Operadora" valor={f.operadora || ''} opcoes={OPERADORAS} onChange={(v) => set('operadora', v)} />
          <Escolha label="Status do WhatsApp" valor={f.status || ''} opcoes={STATUS_WPP}
                   onChange={(v) => set('status', v || 'DESCONECTADO')} permitirLimpar={false} />
          <Escolha label="Plataforma" valor={f.plataforma || ''} opcoes={PLATAFORMAS} onChange={(v) => set('plataforma', v)} />
          <Escolha label="Status na plataforma" valor={f.status_plataforma || ''} opcoes={STATUS_PLAT}
                   onChange={(v) => set('status_plataforma', v)} />

          <div className="chip-campo">
            <label>Instância / conexão</label>
            <div className="chip-opcoes">
              {instancias.slice(0, 24).map((o) => (
                <button key={o} type="button" className={`chip-opcao ${f.instancia === o ? 'on' : ''}`}
                        onClick={() => set('instancia', f.instancia === o ? '' : o)}>{o}</button>
              ))}
            </div>
            <input className="chip-input" value={f.instancia || ''}
                   onChange={(e) => set('instancia', e.target.value)} placeholder="ou digite uma nova (ex: HOT-90)" />
          </div>

          <div className="chip-linha-3">
            <div className="chip-campo">
              <label>Última recarga</label>
              <input type="date" className="chip-input" value={f.ultima_recarga || ''}
                     onChange={(e) => set('ultima_recarga', e.target.value)} />
            </div>
            <div className="chip-campo">
              <label>Recarrega a cada</label>
              <div className="chip-opcoes">
                {[15, 30, 60, 90].map((dd) => (
                  <button key={dd} type="button" className={`chip-opcao ${Number(f.intervalo_dias) === dd ? 'on' : ''}`}
                          onClick={() => set('intervalo_dias', dd)}>{dd}d</button>
                ))}
              </div>
            </div>
            <div className="chip-campo">
              <label>Próxima recarga</label>
              <input type="date" className="chip-input" value={f.proxima_recarga || ''}
                     onChange={(e) => set('proxima_recarga', e.target.value)} />
              <small className="chip-dica">Em branco = última + {f.intervalo_dias || 30} dias</small>
            </div>
          </div>

          <label className="chip-switch">
            <input type="checkbox" checked={!!f.recarregar} onChange={(e) => set('recarregar', e.target.checked)} />
            <span>Entra no alerta de recarga</span>
          </label>

          <div className="chip-campo">
            <label>Observação</label>
            <textarea className="chip-input" rows={2} value={f.observacao || ''}
                      onChange={(e) => set('observacao', e.target.value)} placeholder="Pouca mensagem, sem chip, banido na Meta..." />
          </div>

          {erro && <p className="chip-erro">{erro}</p>}
        </div>

        <footer className="chip-editor-rodape">
          <button className="reset-btn" onClick={onFechar}>Cancelar</button>
          <button className="chip-salvar" onClick={salvar} disabled={salvando}>
            {salvando ? 'Salvando...' : 'Salvar chip'}
          </button>
        </footer>
      </div>
    </div>
  )
}

export default function Chips({ onVoltar }) {
  const [dados, setDados] = useState(null)
  const [opcoes, setOpcoes] = useState({})
  const [busca, setBusca] = useState('')
  const [statusFiltro, setStatusFiltro] = useState('')
  const [soRecarga, setSoRecarga] = useState(false)
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState(null)
  const [editando, setEditando] = useState(null)
  const [marcados, setMarcados] = useState([])

  const carregar = useCallback(async () => {
    setCarregando(true); setErro(null)
    try {
      const d = await getJson('chips_listar', {
        busca, status: statusFiltro, so_recarga: soRecarga ? '1' : '0',
      })
      setDados(d)
      setMarcados([])
    } catch (e) {
      setErro(e.message)
    } finally {
      setCarregando(false)
    }
  }, [busca, statusFiltro, soRecarga])

  useEffect(() => {
    const t = setTimeout(carregar, busca ? 350 : 0)
    return () => clearTimeout(t)
  }, [carregar, busca])
  useEffect(() => { getJson('chips_opcoes').then(setOpcoes).catch(() => {}) }, [])

  const resumo = dados?.resumo || {}
  const rows = dados?.rows || []
  const porInstancia = dados?.por_instancia || []

  const alternar = (id) => setMarcados((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]))

  async function recarregar() {
    if (!marcados.length) return
    await postJson('chips_recarregar', { ids: marcados })
    carregar()
  }
  async function excluir(id) {
    if (!window.confirm('Remover este chip do controle?')) return
    await postJson('chips_excluir', { id })
    carregar()
  }

  return (
    <>
      <div className="topbar">
        <h1><span className="pulse" /> Chips &mdash; WhatsApp</h1>
        <div className="topbar-right">
          <span className="status-line">{carregando ? 'carregando...' : `${rows.length} de ${resumo.total || 0} chips`}</span>
          <button className="reset-btn" onClick={onVoltar}>&#8592; Início</button>
          <button className="refresh-btn" onClick={carregar} disabled={carregando}>&#8635; Atualizar</button>
          <button className="chip-salvar" onClick={() => setEditando({ ...VAZIO })}>+ Adicionar número</button>
        </div>
      </div>

      {erro && <div className="state-msg error">Erro: {erro}</div>}

      <div className="kpi-grid chips-kpis">
        <div className="kpi"><p className="kpi-label">Total</p><p className="kpi-value">{resumo.total ?? '—'}</p></div>
        <div className="kpi"><p className="kpi-label">Conectados</p><p className="kpi-value accent">{resumo.conectados ?? '—'}</p></div>
        <div className="kpi"><p className="kpi-label">Desconectados</p><p className="kpi-value">{resumo.desconectados ?? '—'}</p></div>
        <div className="kpi"><p className="kpi-label">Recarga vencida</p><p className="kpi-value alerta">{resumo.vencidos ?? '—'}</p></div>
        <div className="kpi"><p className="kpi-label">Vence em 7 dias</p><p className="kpi-value aviso">{resumo.vence_7d ?? '—'}</p></div>
      </div>

      <section className="panel chips-mapa">
        <p className="section-label">Onde estão conectados</p>
        <div className="chips-instancias">
          {porInstancia.map((i) => {
            const pct = i.qtd ? Math.round((i.conectados / i.qtd) * 100) : 0
            return (
              <div key={i.instancia} className="chips-inst" title={`${i.conectados} de ${i.qtd} conectados`}>
                <span className="chips-inst-nome">{i.instancia}</span>
                <span className="chips-inst-barra"><i style={{ width: `${pct}%` }} /></span>
                <span className="chips-inst-qtd">{i.conectados}/{i.qtd}</span>
              </div>
            )
          })}
          {!porInstancia.length && !carregando && <p className="home-vazio">Nenhum chip cadastrado ainda.</p>}
        </div>
      </section>

      <div className="chips-barra">
        <input className="chip-input chips-busca" value={busca} onChange={(e) => setBusca(e.target.value)}
               placeholder="Buscar por telefone, responsável, instância ou observação" />
        <div className="chip-opcoes">
          {STATUS_WPP.map((s) => (
            <button key={s} type="button" className={`chip-opcao ${statusFiltro === s ? 'on' : ''}`}
                    onClick={() => setStatusFiltro(statusFiltro === s ? '' : s)}>{s}</button>
          ))}
          <button type="button" className={`chip-opcao ${soRecarga ? 'on' : ''}`}
                  onClick={() => setSoRecarga((v) => !v)}>Precisa recarregar</button>
        </div>
        {marcados.length > 0 && (
          <button className="chip-salvar" onClick={recarregar}>
            Marcar {marcados.length} como recarregado
          </button>
        )}
      </div>

      <div className="panel chips-tabela-wrap">
        <table className="chips-tabela">
          <thead>
            <tr>
              <th className="chips-check"></th>
              <th>Telefone</th><th>Operadora</th><th>Instância</th>
              <th>WhatsApp</th><th>Plataforma</th>
              <th>Próxima recarga</th><th>Observação</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const dias = c.dias_para_recarga
              const alerta = c.recarregar && dias !== null && dias !== undefined && dias < 0
              const aviso = c.recarregar && dias !== null && dias >= 0 && dias <= 7
              return (
                <tr key={c.id} className={alerta ? 'linha-alerta' : aviso ? 'linha-aviso' : ''}>
                  <td className="chips-check">
                    <input type="checkbox" checked={marcados.includes(c.id)} onChange={() => alternar(c.id)} />
                  </td>
                  <td className="chips-fone">{fmtFone(c.telefone)}</td>
                  <td>{c.operadora || '—'}</td>
                  <td>{c.instancia || '—'}</td>
                  <td><span className={`chips-tag t-${(c.status || '').toLowerCase().replace(/\s/g, '-')}`}>{c.status || '—'}</span></td>
                  <td>
                    {c.plataforma
                      ? <span className="chips-plat">{c.plataforma}{c.status_plataforma ? ` · ${c.status_plataforma.toLowerCase()}` : ''}</span>
                      : (c.status_plataforma ? <span className="chips-plat">{c.status_plataforma.toLowerCase()}</span> : '—')}
                  </td>
                  <td>
                    {c.recarregar
                      ? <>{fmtData(c.proxima_recarga)}{dias !== null && dias !== undefined &&
                          <small className={alerta ? 'chips-prazo alerta' : aviso ? 'chips-prazo aviso' : 'chips-prazo'}>
                            {dias < 0 ? ` vencida há ${Math.abs(dias)}d` : dias === 0 ? ' hoje' : ` em ${dias}d`}
                          </small>}</>
                      : <span className="chips-off">não recarrega</span>}
                  </td>
                  <td className="chips-obs" title={c.observacao || ''}>{c.observacao || '—'}</td>
                  <td className="chips-acoes">
                    <button className="chips-mini" onClick={() => setEditando(c)}>Editar</button>
                    <button className="chips-mini chips-mini-perigo" onClick={() => excluir(c.id)}>Remover</button>
                  </td>
                </tr>
              )
            })}
            {!rows.length && !carregando && (
              <tr><td colSpan={9} className="home-vazio">
                Nenhum chip com esses filtros. Ajuste a busca ou adicione um número novo.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editando && (
        <Editor chip={editando} opcoes={opcoes}
                onFechar={() => setEditando(null)}
                onSalvo={() => { setEditando(null); carregar() }} />
      )}
    </>
  )
}
