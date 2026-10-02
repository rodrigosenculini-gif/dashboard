import React, { useCallback, useEffect, useState } from 'react'
import { useDialogo } from './Dialogo'
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
}
const NOME_ACAO = {
  audio: 'Áudio', atribuir: 'Atribuiu', retirar: 'Retirou', nota: 'Nota', lembrete: 'Lembrete',
  email: 'E-mail', encerrar: 'Encerrou', audio_pulado: 'Áudio pulado', lembrete_pulado: 'Lembrete pulado', erro: 'Erro',
}

async function getResumo() {
  const r = await fetch('/api/dashboard?type=robo_resumo')
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'falha ao carregar')
  return d.data ?? d
}

const hora = (t) => (t ? new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—')

export default function RoboFollowup({ onVoltar }) {
  const dialogo = useDialogo()
  const [dados, setDados] = useState(null)
  const [erro, setErro] = useState(null)
  const [carregando, setCarregando] = useState(false)
  const [mudando, setMudando] = useState(false)

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
          <button className={`robo-modo ${ativo ? 'on' : ''}`} onClick={trocarModo} disabled={!dados || mudando}>
            {ativo ? '● Enviando — pausar' : '○ Prévia — ligar envio'}
          </button>
        </div>
      </div>

      {erro && <div className="state-msg error">Erro: {erro}</div>}

      <div className="kpi-grid">
        <div className="kpi"><p className="kpi-label">Casos acompanhados</p><p className="kpi-value">{dados ? totalAbertos : '—'}</p></div>
        <div className="kpi"><p className="kpi-label">Áudios hoje</p><p className="kpi-value accent">{hoje.audio ?? 0}</p></div>
        <div className="kpi"><p className="kpi-label">Passados p/ vendedora</p><p className="kpi-value">{hoje.atribuir ?? 0}</p></div>
        <div className="kpi"><p className="kpi-label">Lembretes / e-mails</p><p className="kpi-value aviso">{(hoje.lembrete ?? 0)} / {(hoje.email ?? 0)}</p></div>
        <div className="kpi"><p className="kpi-label">Erros hoje</p><p className={`kpi-value ${dados?.erros_hoje ? 'alerta' : ''}`}>{dados?.erros_hoje ?? 0}</p></div>
      </div>

      <div className="robo-grid">
        <section className="panel">
          <p className="section-label">Carga das vendedoras · clientes esperando há +5 min (limite {limite} urgentes)</p>
          {carga.map((c) => {
            const pct = Math.min(100, Math.round((Number(c.urgentes) / limite) * 100))
            return (
              <div key={c.vendedora} className="robo-carga">
                <span className="robo-carga-nome">{c.vendedora}</span>
                <span className={`robo-barra ${Number(c.urgentes) >= limite ? 'cheia' : ''}`}><i style={{ width: `${pct}%` }} /></span>
                <span className="robo-carga-num" title="urgentes / total sem resposta">{c.urgentes} <small>/ {c.sem_resposta}</small></span>
              </div>
            )
          })}
          {!carga.length && <p className="home-vazio">Sem dados ainda.</p>}
        </section>

        <section className="panel">
          <p className="section-label">Em acompanhamento agora</p>
          {abertos.map((a) => (
            <div key={`${a.caso}-${a.etapa}`} className="robo-linha">
              <span>{NOME_CASO[a.caso] || a.caso} <small>· {NOME_ETAPA[a.etapa] || a.etapa}</small></span>
              <strong>{a.n}</strong>
            </div>
          ))}
          {!abertos.length && <p className="home-vazio">Nenhum caso aberto.</p>}
          {encerrados.length > 0 && <>
            <p className="section-label robo-sub">Encerrados hoje</p>
            {encerrados.slice(0, 8).map(([m, n]) => (
              <div key={m} className="robo-linha"><span>{m}</span><strong>{n}</strong></div>
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
    </>
  )
}
