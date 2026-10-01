import React, { useCallback, useEffect, useState } from 'react'
import { ResponsiveContainer, AreaChart, Area, Tooltip, XAxis } from 'recharts'
import { callApi, useRevisaoCache } from './dadosCache'
import { useDialogo } from './Dialogo'
import { lerToken, api, estadoBanco, nomeBanco, nomeProduto, Chave } from './IAConfiguracao'
import './IAResumoRapido.css'

// Bloco "IA de atendimento" da tela Geral (dono, 01/10): análises e ajustes
// rápidos sem abrir o Painel. Números dos últimos 7 dias (mesma chamada e cache
// da seção Análises); ajustes pelo mesmo caminho do Painel (token da gestão).

const hojeSP = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10)
const diasAtras = (n) => new Date(Date.now() - 3 * 3600000 - n * 86400000).toISOString().slice(0, 10)
const fInt = (v) => Number(v || 0).toLocaleString('pt-BR')
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0)
function tempo(min) {
  if (min === null || min === undefined) return '—'
  const v = Number(min)
  if (v < 1) return `${Math.round(v * 60)} s`
  if (v < 60) return `${Math.round(v)} min`
  const h = Math.floor(v / 60), r = Math.round(v % 60)
  return r ? `${h} h ${r} min` : `${h} h`
}

function Metrica({ label, valor, sub, tom }) {
  return (
    <div className="home-metrica">
      <span className="home-metrica-label">{label}</span>
      <span className={`home-metrica-valor ${tom || ''}`}>{valor}</span>
      <span className="home-metrica-sub">{sub || ' '}</span>
    </div>
  )
}

export default function IAResumoRapido({ onAbrirPainel }) {
  const dialogo = useDialogo()
  const revisao = useRevisaoCache()
  const [a, setA] = useState(null)
  const [cfg, setCfg] = useState(null)
  const [token] = useState(lerToken)
  const [ocupado, setOcupado] = useState('')
  const [aviso, setAviso] = useState('')

  const carregarAnalises = useCallback(async () => {
    try { setA(await callApi('ia_analises', { date_from: diasAtras(6), date_to: hojeSP(), produto: '', testes: '0' })) } catch { /* fica sem */ }
  }, [revisao]) // eslint-disable-line react-hooks/exhaustive-deps
  const carregarCfg = useCallback(async () => {
    if (!token) return
    const r = await api({ acao: 'ler', token })
    if (r.ok) setCfg(r)
  }, [token])
  useEffect(() => { carregarAnalises() }, [carregarAnalises])
  useEffect(() => { carregarCfg() }, [carregarCfg])

  async function salvar(tipo, dados, msg, chave) {
    setOcupado(chave)
    const r = await api({ acao: 'salvar', token, tipo, dados })
    setOcupado('')
    setAviso(r.ok ? msg : (r.motivo && r.motivo.length > 12 ? r.motivo : 'Não foi possível salvar.'))
    setTimeout(() => setAviso(''), 2600)
    if (r.ok) carregarCfg()
  }
  async function pausar(b) {
    if (!await dialogo.confirmar({ titulo: `Pausar ${nomeBanco(b.banco)} (${nomeProduto(b.produto)}) por 1 hora?`,
      texto: 'A IA, a página e o painel de simulação param de consultar nele. Ele religa sozinho depois.', rotuloOk: 'Pausar 1 hora' })) return
    salvar('banco', { produto: b.produto, banco: b.banco, pausar_horas: 1, motivo: 'pausa rápida pela tela Geral' },
      `${nomeBanco(b.banco)} pausado por 1 h`, b.produto + b.banco)
  }

  const f = a?.funil || []
  const n = (et) => f.find((x) => x.etapa === et)?.n || 0
  const conversas = n('conversas')
  const serie = (a?.por_dia || []).map((x) => ({ dia: x.dia, v: x.conversas }))
  const bancos = (cfg?.bancos || []).filter((b) => b.ativo || b.pausado_ate)
  const esc = cfg?.escalada || {}

  return (
    <section className="home-painel home-ia">
      <header className="home-painel-top">
        <button className="home-painel-titulo" onClick={() => onAbrirPainel('resumo')} title="Abrir o Painel">
          <span className="home-painel-marca" style={{ background: 'var(--lime)' }} />
          IA de atendimento
          <span className="home-painel-seta" aria-hidden="true">&rsaquo;</span>
        </button>
        <div className="home-ia-links">
          <button onClick={() => onAbrirPainel('analises')}>Análises</button>
          <button onClick={() => onAbrirPainel('bancos')}>Bancos</button>
          <button onClick={() => onAbrirPainel('mensagens')}>Mensagens</button>
          <button onClick={() => onAbrirPainel('lembretes')}>Lembretes</button>
        </div>
      </header>

      <div className="home-ia-grid">
        <div>
          <p className="home-ia-rotulo">Últimos 7 dias</p>
          <div className="home-spark">
            {serie.length > 0 && (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={serie} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="sparkIA" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#a9d97f" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#a9d97f" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="dia" hide />
                  <Tooltip cursor={{ stroke: 'var(--border)' }} labelFormatter={(d) => String(d).split('-').reverse().join('/')}
                           formatter={(v) => [fInt(v), 'conversas']}
                           contentStyle={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, fontFamily: 'var(--font-mono)', fontSize: 11, padding: '6px 9px' }}
                           labelStyle={{ color: 'var(--muted)', fontSize: 10.5 }} />
                  <Area type="monotone" dataKey="v" stroke="#a9d97f" strokeWidth={1.6} fill="url(#sparkIA)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="home-metricas">
            <Metrica label="Conversas" valor={a ? fInt(conversas) : '—'} />
            <Metrica label="Receberam oferta" valor={a ? fInt(n('oferta')) : '—'} sub={a ? `${pct(n('oferta'), conversas)}% das conversas` : ''} />
            <Metrica label="Pagos" valor={a ? fInt(n('pago')) : '—'} tom="destaque" sub={a ? `${pct(n('pago'), conversas)}% das conversas` : ''} />
            <Metrica label="Resposta da IA" valor={a?.tempos?.resposta_ia_s != null ? `${a.tempos.resposta_ia_s} s` : '—'} sub="mediana" />
            <Metrica label="Até a oferta" valor={tempo(a?.tempos?.ate_oferta_min)} sub="mediana" />
            <Metrica label="Passaram p/ equipe" valor={a ? fInt(a.equipe?.derivados) : '—'} />
          </div>
        </div>

        <div className="home-ia-ajustes">
          <p className="home-ia-rotulo">Ajustes rápidos</p>
          {!token && (
            <div className="home-ia-entrar">
              <span>Para ajustar daqui, entre uma vez no Painel com a senha da gestão.</span>
              <button className="chip-salvar" onClick={() => onAbrirPainel('resumo')}>Abrir o Painel</button>
            </div>
          )}
          {token && !cfg && <p className="home-vazio">Carregando…</p>}
          {token && cfg && (
            <>
              <ul className="home-ia-bancos">
                {bancos.map((b) => {
                  const est = estadoBanco(b), k = b.produto + b.banco
                  return (
                    <li key={k} className={`s-${est.cls}`}>
                      <span className="home-ia-dot" />
                      <span className="home-ia-nome"><b>{nomeBanco(b.banco)}</b> <em>{nomeProduto(b.produto)}</em></span>
                      <span className="home-ia-estado">{est.txt}</span>
                      {b.ativo
                        ? <button className="chips-mini" disabled={ocupado === k} onClick={() => pausar(b)}>Pausar 1 h</button>
                        : <button className="chips-mini" disabled={ocupado === k}
                                  onClick={() => salvar('banco', { produto: b.produto, banco: b.banco, ativo: true }, `${nomeBanco(b.banco)} religado`, k)}>Religar</button>}
                    </li>
                  )
                })}
              </ul>
              <label className="home-ia-linha">
                <span>Avisar quando cliente fica sem resposta da vendedora <em>{esc.ativa ? `${esc.aviso_min}/${esc.acao_min} min` : 'desligado'}</em></span>
                <Chave ligado={!!esc.ativa} disabled={ocupado === 'esc'} rotulo="Escalada"
                       onChange={(v) => salvar('escalada', { ativa: v }, v ? 'Escalada ligada' : 'Escalada desligada', 'esc')} />
              </label>
              {aviso && <p className="home-ia-aviso">{aviso}</p>}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
