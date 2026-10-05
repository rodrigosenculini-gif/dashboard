import React, { useCallback, useEffect, useState } from 'react'
import { useDialogo } from './Dialogo'
import RoboConfig from './RoboConfig'
import RoboQualidade from './RoboQualidade'
import './RoboFollowup.css'

// Robô de follow-up do CRM VendeAI (edge function robo-followup no Supabase).
// Só leitura do que ele fez + liga/desliga o envio. Regras ficam em robo_fu_config.

const CRM = 'https://crm.vendeaitecnologia.com.br/app/accounts/75/conversations/'

const NOME_CASO = {
  ticket_alto: 'Ticket alto', ofertado: 'Ofertado', assinatura: 'Assinatura',
  pendencia: 'Pendência', cliente_sumiu: 'Cliente sumiu',
}
const NOME_ETAPA = {
  espera: 'aguardando', audio1: '1º áudio enviado', com_vendedora: 'com vendedora', lembrete: 'lembrete enviado',
  robo_fu: 'fluxo fazendo follow-up',
}
const NOME_ACAO = {
  audio: 'Áudio', atribuir: 'Atribuiu', retirar: 'Retirou', nota: 'Nota', lembrete: 'Lembrete',
  email: 'E-mail', encerrar: 'Encerrou', audio_pulado: 'Áudio pulado', lembrete_pulado: 'Lembrete pulado', erro: 'Erro',
  email_pulado: 'E-mail pulado', assumir_followup: 'Assumiu follow-up', lembrete_ligacao: 'Lembrete de ligação',
  etiqueta: 'Etiqueta', followup_pulado: 'Follow-up pulado (atrasado)', quer_digitar: 'Quer digitar', recontar: 'Recontou',
  sem_vaga: 'Sem vaga (limite/hora)',
}

// desempenho das vendedoras com os atendimentos que o robô passou para elas hoje
function Desempenho({ tick }) {
  const [d, setD] = useState(null)
  useEffect(() => {
    fetch('/api/dashboard?type=robo_desempenho').then((r) => r.json()).then((x) => setD(x?.data ?? x)).catch(() => {})
  }, [tick])
  if (!d?.vendedoras) return null
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)
  const cor = (x) => (x == null ? '' : x >= 0.8 ? 'ok' : x < 0.5 ? 'ruim' : 'medio')
  return (
    <section className="panel table-panel">
      <p className="section-label">
        Desempenho das vendedoras · hoje · última hora {d.recebidos_hora}/{d.total_hora} atendimentos novos (equipe)
      </p>
      <div className="scroll-table">
        <table className="robo-desemp">
          <thead><tr>
            <th>Vendedora</th><th title="atendimentos novos na última hora / limite por hora">Hora</th><th>Recebidos</th>
            <th>Respondidos</th><th>Taxa</th><th title={`respondeu em até ${d.resposta_ok_min} min`}>No prazo</th>
            <th>Tempo médio</th><th>Sem resposta</th><th title="saiu dela sem ela responder">Saiu s/ resp.</th>
            <th>Ligações pend.</th>
          </tr></thead>
          <tbody>
            {d.vendedoras.map((v) => (
              <tr key={v.agent_id} className={v.online ? '' : 'off'}>
                <td><span className={`robo-dot ${v.online ? 'on' : ''}`} /> {v.nome}</td>
                <td>{v.hora}/{v.limite}<small>{v.limite_fixo != null ? ' fixo' : ' auto'}</small></td>
                <td>{v.hoje}</td><td>{v.respondidos}</td>
                <td className={`robo-taxa ${cor(v.taxa)}`}>{pct(v.taxa)}</td>
                <td>{v.no_prazo}</td><td>{fmtMin(v.media_min)}</td>
                <td>{v.sem_resposta}</td><td>{v.saiu_sem_resposta}</td><td>{v.ligacoes_pend}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

async function getResumo() {
  const r = await fetch('/api/dashboard?type=robo_resumo')
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'falha ao carregar')
  return d.data ?? d
}

const hora = (t) => (t ? new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—')
const fmtMin = (m) => (m == null ? '—' : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`)

// conversas por trás de uma linha (carga / caso+etapa / motivo de encerramento)
function ListaConversas({ tipo, a, b }) {
  const [itens, setItens] = useState(null)
  const [erro, setErro] = useState(null)
  useEffect(() => {
    const qs = new URLSearchParams({ type: 'robo_lista', tipo, a: a || '', b: b || '' })
    fetch(`/api/dashboard?${qs}`).then((r) => r.json())
      .then((d) => (Array.isArray(d) ? setItens(d) : setErro(d?.error || 'falha')))
      .catch((e) => setErro(e.message))
  }, [tipo, a, b])
  if (erro) return <div className="robo-lista state-msg error">Erro: {erro}</div>
  if (!itens) return <div className="robo-lista home-vazio">carregando...</div>
  if (!itens.length) return <div className="robo-lista home-vazio">Nenhuma conversa.</div>
  return (
    <div className="robo-lista">
      {itens.map((c) => (
        <div key={c.conversation_id} className="robo-lista-item">
          <a href={CRM + c.conversation_id} target="_blank" rel="noreferrer">#{c.conversation_id}</a>
          <span>
            {tipo === 'carga' && <>esperando {fmtMin(c.espera_min)}{c.urgente ? <b className="robo-tag">urgente</b> : null}</>}
            {tipo === 'aberto' && <>cliente calado há {fmtMin(c.espera_min)} · etapa há {fmtMin(c.etapa_min)}</>}
            {tipo === 'encerrado' && <>{NOME_CASO[c.caso] || c.caso} · {hora(c.quando)}</>}
          </span>
          <span className="robo-lista-extra">
            {[c.vendedora, c.detalhe, c.audios ? `${c.audios} áudio(s)` : null,
              tipo === 'carga' ? (c.labels || []).filter((l) => l !== 'clt').join(', ') : null].filter(Boolean).join(' · ')}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function RoboFollowup({ onVoltar }) {
  const dialogo = useDialogo()
  const [dados, setDados] = useState(null)
  const [erro, setErro] = useState(null)
  const [carregando, setCarregando] = useState(false)
  const [mudando, setMudando] = useState(false)
  const [aberta, setAberta] = useState(null) // chave da linha expandida: "tipo|a|b"
  const [verConfig, setVerConfig] = useState(false)
  const [verQual, setVerQual] = useState(false)
  const alternar = (tipo, a, b) => {
    const k = `${tipo}|${a}|${b || ''}`
    setAberta((x) => (x === k ? null : k))
  }
  const estaAberta = (tipo, a, b) => aberta === `${tipo}|${a}|${b || ''}`

  const carregar = useCallback(async () => {
    setCarregando(true)
    try { setDados(await getResumo()); setErro(null) }
    catch (e) { setErro(e.message) }
    finally { setCarregando(false) }
  }, [])

  useEffect(() => {
    carregar()
    const t = setInterval(carregar, 60_000)
    return () => clearInterval(t)
  }, [carregar])

  async function trocarModo() {
    const novo = dados?.modo === 'ativo' ? 'previa' : 'ativo'
    const ok = await dialogo.confirmar(novo === 'ativo'
      ? { titulo: 'Ligar o envio?', texto: 'O robô passa a mandar áudios, atribuir atendimentos, criar lembretes e e-mails de verdade.', rotuloOk: 'Ligar' }
      : { titulo: 'Pausar o envio?', texto: 'O robô continua acompanhando, mas só registra o que faria (prévia).', rotuloOk: 'Pausar', perigo: true })
    if (!ok) return
    setMudando(true)
    try {
      const r = await fetch('/api/dashboard?type=robo_modo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modo: novo }),
      })
      if (!r.ok) throw new Error((await r.json()).error || 'falha')
      await carregar()
    } catch (e) { setErro(e.message) }
    finally { setMudando(false) }
  }

  const ativo = dados?.modo === 'ativo'
  const hoje = dados?.hoje || {}
  const abertos = dados?.abertos || []
  const totalAbertos = abertos.reduce((s, a) => s + Number(a.n || 0), 0)
  const carga = dados?.carga || []
  const limite = dados?.config?.carga?.max_sem_resposta ?? 10
  const encerrados = Object.entries(dados?.encerrados_hoje || {}).sort((a, b) => b[1] - a[1])

  return (
    <>
      <div className="topbar">
        <h1><span className="pulse" /> Robô follow-up</h1>
        <div className="topbar-right">
          <span className="status-line">
            {carregando ? 'carregando...' : `última leitura do CRM ${hora(dados?.ultima_varredura)}`}
          </span>
          <button className="reset-btn" onClick={onVoltar}>&#8592; Início</button>
          <button className="refresh-btn" onClick={carregar} disabled={carregando}>&#8635; Atualizar</button>
          <button className={`reset-btn ${verQual ? 'rc-on' : ''}`} onClick={() => { setVerQual((x) => !x); setVerConfig(false) }}>
            {verQual ? '← Painel' : '★ Qualidade'}
          </button>
          <button className={`reset-btn ${verConfig ? 'rc-on' : ''}`} onClick={() => { setVerConfig((x) => !x); setVerQual(false) }}>
            {verConfig ? '← Painel' : '⚙ Configurações'}
          </button>
          <button className={`robo-modo ${ativo ? 'on' : ''}`} onClick={trocarModo} disabled={!dados || mudando}>
            {ativo ? '● Enviando — pausar' : '○ Prévia — ligar envio'}
          </button>
        </div>
      </div>

      {erro && <div className="state-msg error">Erro: {erro}</div>}

      {verConfig ? <RoboConfig /> : verQual ? <RoboQualidade /> : <>
      <div className="kpi-grid">
        <div className="kpi"><p className="kpi-label">Casos acompanhados</p><p className="kpi-value">{dados ? totalAbertos : '—'}</p></div>
        <div className="kpi"><p className="kpi-label">Áudios hoje</p><p className="kpi-value accent">{hoje.audio ?? 0}</p></div>
        <div className="kpi"><p className="kpi-label">Passados p/ vendedora</p><p className="kpi-value">{hoje.atribuir ?? 0}</p></div>
        <div className="kpi"><p className="kpi-label">Lembretes / e-mails</p><p className="kpi-value aviso">{(hoje.lembrete ?? 0)} / {(hoje.email ?? 0)}</p></div>
        <div className="kpi"><p className="kpi-label">Erros hoje</p><p className={`kpi-value ${dados?.erros_hoje ? 'alerta' : ''}`}>{dados?.erros_hoje ?? 0}</p></div>
      </div>

      <Desempenho tick={dados} />

      <div className="robo-grid">
        <section className="panel">
          <p className="section-label">Carga das vendedoras · clientes esperando há +5 min (limite {limite} urgentes)</p>
          {carga.map((c) => {
            const pct = Math.min(100, Math.round((Number(c.urgentes) / limite) * 100))
            return (
              <React.Fragment key={c.vendedora}>
                <button type="button" className={`robo-carga robo-clicavel ${estaAberta('carga', c.vendedora) ? 'on' : ''}`}
                        onClick={() => alternar('carga', c.vendedora)}>
                  <span className="robo-carga-nome">{c.vendedora}</span>
                  <span className={`robo-barra ${Number(c.urgentes) >= limite ? 'cheia' : ''}`}><i style={{ width: `${pct}%` }} /></span>
                  <span className="robo-carga-num" title="urgentes / total sem resposta">{c.urgentes} <small>/ {c.sem_resposta}</small></span>
                </button>
                {estaAberta('carga', c.vendedora) && <ListaConversas tipo="carga" a={c.vendedora} />}
              </React.Fragment>
            )
          })}
          {!carga.length && <p className="home-vazio">Sem dados ainda.</p>}
        </section>

        <section className="panel">
          <p className="section-label">Em acompanhamento agora</p>
          {abertos.map((a) => (
            <React.Fragment key={`${a.caso}-${a.etapa}`}>
              <button type="button" className={`robo-linha robo-clicavel ${estaAberta('aberto', a.caso, a.etapa) ? 'on' : ''}`}
                      onClick={() => alternar('aberto', a.caso, a.etapa)}>
                <span>{NOME_CASO[a.caso] || a.caso} <small>· {NOME_ETAPA[a.etapa] || a.etapa}</small></span>
                <strong>{a.n}</strong>
              </button>
              {estaAberta('aberto', a.caso, a.etapa) && <ListaConversas tipo="aberto" a={a.caso} b={a.etapa} />}
            </React.Fragment>
          ))}
          {!abertos.length && <p className="home-vazio">Nenhum caso aberto.</p>}
          {encerrados.length > 0 && <>
            <p className="section-label robo-sub">Encerrados hoje</p>
            {encerrados.map(([m, n]) => (
              <React.Fragment key={m}>
                <button type="button" className={`robo-linha robo-clicavel ${estaAberta('encerrado', m) ? 'on' : ''}`}
                        onClick={() => alternar('encerrado', m)}>
                  <span>{m}</span><strong>{n}</strong>
                </button>
                {estaAberta('encerrado', m) && <ListaConversas tipo="encerrado" a={m} />}
              </React.Fragment>
            ))}
          </>}
        </section>
      </div>

      <section className="panel table-panel">
        <p className="section-label">Últimas ações</p>
        <div className="scroll-table">
          {(dados?.acoes || []).map((a, i) => (
            <div key={i} className={`robo-acao ${a.ok === false ? 'falha' : ''}`}>
              <span className="robo-acao-hora">{hora(a.em)}</span>
              <span className="robo-acao-tipo">{NOME_ACAO[a.acao] || a.acao}</span>
              <a href={CRM + a.conversation_id} target="_blank" rel="noreferrer">#{a.conversation_id}</a>
              <span className="robo-acao-det">{a.ok === false ? a.erro : a.detalhe}</span>
            </div>
          ))}
          {!(dados?.acoes || []).length && <p className="home-vazio">Nenhuma ação ainda.</p>}
        </div>
      </section>

      <section className="panel table-panel">
        <p className="section-label">E-mails urgentes</p>
        {(dados?.emails || []).map((e, i) => (
          <div key={i} className={`robo-acao ${e.erro ? 'falha' : ''}`}>
            <span className="robo-acao-hora">{hora(e.criado_em)}</span>
            <span className="robo-acao-tipo">{e.enviado_em ? (e.erro ? 'Falhou' : 'Enviado') : 'Na fila'}</span>
            <a href={CRM + e.conversation_id} target="_blank" rel="noreferrer">#{e.conversation_id}</a>
            <span className="robo-acao-det">{e.para} — {e.erro || e.assunto}</span>
          </div>
        ))}
        {!(dados?.emails || []).length && <p className="home-vazio">Nenhum e-mail ainda.</p>}
      </section>
      </>}
    </>
  )
}
