import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, lerToken, nomeBanco, nomeProduto } from './IAConfiguracao'
import './FunilAoVivo.css'

// View "Funil ao vivo" (dono, 02/10, no estilo do VendeAI): as conversas da IA no WhatsApp e as páginas da LP em tempo
// real. Só leitura: public.funil_ao_vivo / public.funil_detalhe (migração 183) pela sessão do Painel (/api/dashboard
// ?type=config). Atualiza sozinho a cada 10 s com a aba visível.

const TOKEN_KEY = 'ia_config_token'
const CRM = 'https://crm.vendeaitecnologia.com.br/app/accounts/75/conversations/'
const ATUALIZA_MS = 10000

const FASE = {
  identificacao: ['Identificação', 'cinza'], consulta: ['Simulando', 'azul'], autorizacao: ['Aguardando autorização', 'laranja'],
  oferta: ['Com oferta', 'verde'], negociacao: ['Negociando', 'verde'], coleta: ['Coletando dados', 'roxo'],
  confirmacao: ['Confirmando', 'roxo'], formalizacao: ['Assinatura', 'roxo'], encerrado: ['Encerrado', 'cinza'],
}
const PASSOS = [['Dados', ['identificacao']], ['Simulado', ['consulta', 'autorizacao']], ['Ofertado', ['oferta', 'negociacao']],
  ['Digitado', ['coleta', 'confirmacao']], ['Assinado', ['formalizacao']], ['Pago', []]]

const dig = (s) => String(s || '').replace(/\D/g, '')
function fone(t) {
  const d = dig(t).replace(/^55(?=\d{10,11}$)/, '')
  if (d.length === 11) return `+55 ${d.slice(0, 2)} ${d.slice(2, 7)}-${d.slice(7)}`
  if (d.length === 10) return `+55 ${d.slice(0, 2)} ${d.slice(2, 6)}-${d.slice(6)}`
  return t || ''
}
const cpfFmt = (c) => (dig(c).length === 11 ? dig(c).replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : c || '')
const brl = (v) => (v == null ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }))
const hm = (d) => (d ? new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '')
function ha(d, agora) {
  if (!d) return ''
  const s = Math.max(0, Math.round(((agora || Date.now()) - new Date(d)) / 1000))
  if (s < 60) return 'agora'
  const m = Math.round(s / 60)
  if (m < 60) return `há ${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `há ${h} h`
  return new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
const dur = (ms) => { const s = Math.round((Number(ms) || 0) / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min ${s % 60}s` }

// o que aconteceu, em palavras (lista e linha do tempo)
function textoEvento(tipo, d = {}) {
  const fase = (f) => (FASE[f] || [f || '?'])[0]
  switch (tipo) {
    case 'mensagem_cliente': return 'Cliente mandou mensagem'
    case 'mensagem_ia': return 'IA respondeu no WhatsApp'
    case 'mensagem_vendedora': return 'Equipe respondeu no WhatsApp'
    case 'conversa_criada': return 'Conversa aberta no WhatsApp'
    case 'fase_alterada': return `Foi para ${fase(d.para)}`
    case 'lp_pagina_aberta': return 'Abriu a página da campanha'
    case 'jornada_aberta': return 'Abriu a página'
    case 'lp_sinal': return d.tipo === 'consentiu_termo' ? 'Autorizou a consulta (aviso da página)' : `Mexeu na página (${String(d.tipo || '').replace(/_/g, ' ')})`
    case 'nome_informado': return d.fonte === 'lemitti' ? 'Nome encontrado no Lemitti' : 'Informou o nome'
    case 'cpf_informado': return 'Informou o CPF'
    case 'termo_aceito': return `Aceite do termo registrado · ${nomeBanco(d.banco)}`
    case 'produto_trocado': return `Trocou de produto: ${nomeProduto(d.de)} → ${nomeProduto(d.para)}`
    case 'derivacao': return 'Passado para a equipe'
    case 'msgs_na_lp': return 'Mensagem mostrada na página'
    case 'lp_entregue_disparo': return `Aprovado: template ${d.template || ''} na fila de envio`
    case 'lp_entrega_ok': return 'Template de aprovado enviado'
    case 'lp_entrega_erro': return 'Falhou o envio do template de aprovado'
    case 'lp_clicou_whatsapp': return 'Tocou no botão do WhatsApp'
    case 'encerrado_manual': return 'Encerrado manualmente'
    case 'reativacao': return 'Template de retomada enviado'
    case 'fgts_liberado': return 'FGTS liberado'
    case 'proposta_digitada': return 'Proposta digitada'
    case 'lembrete_lp': return 'Lembrete da página enviado'
    case 'nota_privada': return 'Nota interna'
    case 'atribuicao': return 'Atribuído'
    case 'status_resolved': return 'Conversa resolvida'
    default: return String(tipo || '').replace(/_/g, ' ')
  }
}
function comQuem(l) {
  if (l.situacao === 'derivado' || l.agente_tipo === 'humano') return ['Equipe', 'pessoa']
  if (l.conversa && l.ia_ativa !== false) return ['IA no WhatsApp', 'chat']
  if (l.lp) return ['Página (LP)', 'web']
  return ['IA', 'chat']
}
function ondeAgora(l) {
  if (l.na_pagina) return 'Está na página agora'
  if (l.lp?.clicou_em) return 'Tocou no WhatsApp da página'
  if (l.lp?.entregue_em) return 'Aprovado · template enviado'
  if (l.aguarda_cliente) return 'Esperando o cliente autorizar um banco'
  return l.ultimo ? textoEvento(l.ultimo.tipo, l.ultimo.d) : '—'
}
// motivo do encerramento (migração 208 manda o desfecho; 207: FGTS sem autorização em página que não pede)
const DESFECHO = { pago: 'Pago', sem_saldo: 'Sem saldo', fora_politica: 'Fora da política', fgts_sem_autorizacao: 'FGTS sem autorização',
  teste_reiniciado: 'Teste reiniciado', lp_nova_consulta: 'Nova consulta' }
function etapa(l) {
  if (l.situacao === 'derivado') return ['Com a equipe', 'laranja']
  if (l.situacao === 'encerrado') return [`Encerrado · ${DESFECHO[l.desfecho] || (FASE[l.fase] || [l.fase || '—'])[0]}`, 'cinza']
  if (l.aguarda_cliente && l.fase === 'consulta') return ['Aguardando autorização', 'laranja']
  return FASE[l.fase] || [l.fase || '—', 'cinza']
}
const Icone = ({ k }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={{ chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z', pessoa: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
      web: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20' }[k]} />
  </svg>
)

// Interação depois do resultado e venda (migração 214): clicou no WhatsApp da página, voltou à página, respondeu no
// VendeAI ou mandou mensagem; proposta / pago / cancelado vêm das propostas da IA e das propostas dos bancos pelo CPF.
function chipsInteracao(l) {
  const i = l.inter || {}, c = []
  if (i.clicou) c.push(['Clicou no WhatsApp', 'verde'])
  if (i.vendeai) c.push(['Respondeu no VendeAI', 'verde'])
  if (i.voltou) c.push(['Voltou à página', 'azul'])
  if (i.msgs) c.push([`${i.msgs} msg do cliente`, 'azul'])
  if (!c.length && l.lp?.aprovado_em) c.push([l.lp.entregue_em ? 'Sem interação' : 'Resultado não entregue', 'cinza'])
  if (i.lembretes) c.push([`${i.lembretes} lembrete${i.lembretes > 1 ? 's' : ''}`, 'cinza'])
  return c
}
function chipVenda(v) {
  if (!v) return null
  if (v.pago) return ['Pago', 'verde']
  if (v.cancelado) return ['Cancelado', 'vermelho']
  return [`Proposta${v.status ? ` · ${String(v.status).slice(0, 28)}` : ''}`, 'roxo']
}

function Entrar({ onOk }) {
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState('')
  async function ir(e) {
    e.preventDefault()
    const r = await api({ acao: 'entrar', senha })
    if (r.ok && r.token) { try { localStorage.setItem(TOKEN_KEY, r.token) } catch { /* ignora */ } onOk(r.token) }
    else setErro('Senha incorreta.')
  }
  return (
    <form className="panel fav-entrar" onSubmit={ir}>
      <b>Entrar no Funil ao vivo</b>
      <p className="iac-miudo">É a mesma senha do Painel.</p>
      <input className="chip-input" type="password" value={senha} onChange={(e) => setSenha(e.target.value)} placeholder="Senha" autoFocus />
      {erro && <p className="chip-erro">{erro}</p>}
      <button className="chip-salvar iac-btn-p" type="submit">Entrar</button>
    </form>
  )
}

function Detalhe({ id, token, onFechar, agora }) {
  const [d, setD] = useState(null)
  const carregar = useCallback(() => api({ acao: 'funil_detalhe', token, id }).then(setD), [id, token])
  useEffect(() => { setD(null); carregar(); const t = setInterval(() => { if (!document.hidden) carregar() }, ATUALIZA_MS); return () => clearInterval(t) }, [carregar])
  useEffect(() => { const esc = (e) => e.key === 'Escape' && onFechar(); addEventListener('keydown', esc); return () => removeEventListener('keydown', esc) }, [onFechar])
  const a = d?.atendimento
  const melhor = d?.ofertas?.[0]
  const passoAtual = a ? PASSOS.findIndex(([, fs]) => fs.includes(a.fase)) : -1
  // linha do tempo: eventos e chamadas aos bancos juntos, na ordem
  const linha = d ? [
    ...d.eventos.filter((e) => e.tipo !== 'lp_sinal' || e.d?.tipo === 'consentiu_termo').map((e) => ({ em: e.em, tipo: 'ev', e })),
    ...d.consultas.map((c) => ({ em: c.inicio, tipo: 'banco', c })),
  ].sort((x, y) => new Date(x.em) - new Date(y.em)) : []
  return (
    <div className="fav-gaveta-fundo" onClick={onFechar}>
      <aside className="fav-gaveta" onClick={(e) => e.stopPropagation()} aria-label="Detalhe do atendimento">
        <button className="fav-fechar" onClick={onFechar} aria-label="Fechar">×</button>
        {!d && <p className="iac-miudo">Carregando…</p>}
        {d && !d.ok && <p className="chip-erro">Não foi possível abrir este atendimento.</p>}
        {a && (
          <>
            <h3 className="fav-nome">{a.nome || 'Sem nome'}</h3>
            <p className="fav-sub">{fone(a.telefone)} · {cpfFmt(a.cpf)}</p>
            <p className="fav-sub">Atendimento {a.id}{a.campanha ? ` · campanha ${a.campanha}` : ''}
              {a.conversa ? ` · conversa ${a.conversa}` : ''}
              {d.vendeai?.length ? ` · VendeAI ${d.vendeai.map((c) => c.conversa).join(', ')}` : (!a.conversa ? ' · sem conversa' : '')}</p>
            <div className="fav-linha-chips">
              <span className={`fav-badge ${etapa(a)[1]}`}>{etapa(a)[0]}</span>
              {a.na_pagina && <span className="fav-badge verde">Na página agora</span>}
              {a.conversa && (
                <a className="iac-link" href={`https://chatwoot.querosacarfgts.com.br/app/accounts/${a.conta || 1}/conversations/${a.conversa}`}
                   target="_blank" rel="noreferrer">Ver conversa no Chatwoot</a>
              )}
              {(d.vendeai || []).slice(0, 3).map((c) => (
                <a key={c.conversa} className="iac-link" href={CRM + c.conversa} target="_blank" rel="noreferrer">
                  Conversa {c.conversa} no VendeAI</a>
              ))}
            </div>

            <div className="fav-cartao">
              <div className="fav-cartao-topo"><span className="fav-badge cinza">{nomeProduto(a.produto)}</span>
                <small>{comQuem({ ...a, lp: a.lp })[0]}</small></div>
              {melhor ? (
                <>
                  <b className="fav-banco">{nomeBanco(melhor.banco)}</b>
                  <div className="fav-valor">{brl(melhor.valor)}</div>
                  {melhor.parcelas && <small>{melhor.valor_parcela ? `${melhor.parcelas}x de ${brl(melhor.valor_parcela)}` : `${melhor.parcelas} parcela(s)`}</small>}
                </>
              ) : <p className="iac-miudo">Sem oferta{a.trocou_de ? ` (veio do ${nomeProduto(a.trocou_de)})` : ''}.</p>}
            </div>

            {(a.lp?.aprovado_em || d.vendeai?.length > 0 || d.propostas?.length > 0) && (
              <div className="fav-cartao">
                <p className="fav-titulo-bloco">Interação e venda</p>
                <div className="fav-linha-chips">
                  {a.lp?.clicou_em && <span className="fav-badge verde">Clicou no WhatsApp {hm(a.lp.clicou_em)}</span>}
                  {(d.vendeai || []).filter((c) => c.cliente_ultima_em).slice(0, 3).map((c) => (
                    <span key={c.conversa} className="fav-badge verde">Respondeu no VendeAI {hm(c.cliente_ultima_em)} (conversa {c.conversa})</span>
                  ))}
                  {!a.lp?.clicou_em && !(d.vendeai || []).some((c) => c.cliente_ultima_em) && <span className="fav-badge cinza">Sem resposta do cliente</span>}
                </div>
                {(d.propostas || []).map((p, i) => (
                  <div key={i} className="fav-banco-linha">
                    <b>{nomeBanco(p.banco)}</b>
                    <span className={`fav-badge ${p.pago ? 'verde' : p.cancelado ? 'vermelho' : 'roxo'}`}>{p.pago ? 'pago' : p.cancelado ? 'cancelado' : 'proposta'}</span>
                    <small>{p.valor ? `${brl(p.valor)} · ` : ''}{p.status || ''}{p.vendedor ? ` · ${p.vendedor}` : ''} · {hm(p.em)}</small>
                  </div>
                ))}
                {!d.propostas?.length && <p className="iac-miudo">Nenhuma proposta.</p>}
              </div>
            )}

            <div className="fav-cartao">
              <p className="fav-titulo-bloco">Andamento</p>
              <div className="fav-passos">
                {PASSOS.map(([n], i) => <div key={n} className={i <= passoAtual ? 'feito' : ''}><i />{n}</div>)}
              </div>
            </div>

            {Object.keys(d.bancos).length > 0 && (
              <div className="fav-cartao">
                <p className="fav-titulo-bloco">Bancos</p>
                {Object.entries(d.bancos).map(([b, s]) => (
                  <div key={b} className="fav-banco-linha">
                    <b>{nomeBanco(b)}</b>
                    <span className={`fav-badge ${s.situacao === 'ofertas' ? 'verde' : s.situacao === 'sem_oferta' ? 'cinza' : s.situacao === 'erro' ? 'vermelho' : 'azul'}`}>
                      {s.aguarda_cliente ? 'esperando o cliente' : String(s.situacao || '').replace(/_/g, ' ')}</span>
                    {s.erro && <small title={s.erro}>{s.erro}</small>}
                  </div>
                ))}
              </div>
            )}

            <div className="fav-cartao">
              <p className="fav-titulo-bloco">Linha do tempo</p>
              <ol className="fav-tempo">
                {linha.map((x, i) => x.tipo === 'ev' ? (
                  <li key={`e${x.e.id}`}><time>{hm(x.em)}</time><span className={`fav-ponto ${x.e.ator}`} />{textoEvento(x.e.tipo, x.e.d)}</li>
                ) : (
                  <li key={`c${i}`} className="fav-tempo-banco"><time>{hm(x.em)}</time><span className="fav-ponto banco" />
                    <span><b>{nomeBanco(x.c.banco)}</b> · {x.c.verbo} · {dur(x.c.ms)}{' '}
                      <em className={x.c.ok ? 'ok' : 'falha'}>{x.c.ok ? (x.c.valor ? brl(x.c.valor) : 'ok') : String(x.c.cat || 'erro').replace(/_/g, ' ')}</em>
                      {!x.c.ok && x.c.erro && <small title={x.c.erro}>{x.c.erro}</small>}</span>
                  </li>
                ))}
              </ol>
            </div>
            <p className="iac-miudo">Atualizado {ha(a.atualizado, agora)}.</p>
          </>
        )}
      </aside>
    </div>
  )
}

export default function FunilAoVivo() {
  const [token, setToken] = useState(() => lerToken())
  const [filtros, setFiltros] = useState({ periodo: 'hoje', produto: '', canal: '', status: '', busca: '' })
  const [busca, setBusca] = useState('')
  const [dados, setDados] = useState(null)
  const [erro, setErro] = useState('')
  const [aberto, setAberto] = useState(null)
  const [agora, setAgora] = useState(Date.now())
  const pedindo = useRef(false)

  const carregar = useCallback(async () => {
    if (!token || pedindo.current) return
    pedindo.current = true
    try {
      const r = await api({ acao: 'funil', token, filtros })
      if (r.motivo === 'sessao') { try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignora */ } setToken(null); return }
      if (r.ok) { setDados(r); setErro(''); setAgora(Date.now()) } else setErro('Não foi possível atualizar agora.')
    } catch { setErro('Não foi possível atualizar agora.') } finally { pedindo.current = false }
  }, [token, filtros])
  useEffect(() => { carregar(); const t = setInterval(() => { if (!document.hidden) carregar() }, ATUALIZA_MS); return () => clearInterval(t) }, [carregar])
  useEffect(() => { const t = setTimeout(() => setFiltros((f) => (f.busca === busca ? f : { ...f, busca })), 400); return () => clearTimeout(t) }, [busca])

  if (!token) return <div className="fav"><Entrar onOk={setToken} /></div>
  const k = dados?.kpis || {}
  const CARTOES = [['entraram', 'Entraram'], ['na_pagina', 'Na página agora'], ['simulando', 'Simulando'], ['aguardando', 'Aguardando autorização'],
    ['com_oferta', 'Com oferta na mão'], ['digitando', 'Digitando'], ['equipe', 'Com a equipe'], ['interagiram', 'Interagiram (aprovados)'], ['com_proposta', 'Com proposta'],
    ['pagos', 'Pagos'], ['cancelados', 'Cancelados']]
  const set = (c, v) => setFiltros((f) => ({ ...f, [c]: v }))
  return (
    <div className="fav">
      <div className="fav-topo">
        <div>
          <h2>Funil ao vivo <span className="fav-vivo"><i />Ao vivo</span></h2>
          <p className="iac-miudo">IA no WhatsApp e páginas da LP: onde cada cliente está agora. Atualiza sozinho a cada 10 segundos.</p>
        </div>
      </div>
      <div className="fav-kpis">
        {CARTOES.map(([c, t]) => <div key={c} className="fav-kpi"><small>{t}</small><b>{dados ? (k[c] ?? 0).toLocaleString('pt-BR') : '—'}{dados && c === 'interagiram' && k.aprovados_lp ? <small className="fav-de"> de {k.aprovados_lp}</small> : null}</b></div>)}
      </div>
      <div className="fav-filtros">
        <input className="chip-input fav-busca" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Nome, CPF ou telefone" />
        <select className="chip-input" value={filtros.produto} onChange={(e) => set('produto', e.target.value)}>
          <option value="">Todos os produtos</option><option value="clt">CLT</option><option value="fgts">FGTS</option>
        </select>
        <select className="chip-input" value={filtros.canal} onChange={(e) => set('canal', e.target.value)}>
          <option value="">Todos os canais</option><option value="lp">Página (LP)</option><option value="chat">WhatsApp</option>
        </select>
        {/* filtro de status (migração 208): só a lista; os números do topo continuam com o total */}
        <select className="chip-input" value={filtros.status} onChange={(e) => set('status', e.target.value)}>
          <option value="">Todos os status</option><option value="ativos">Ativos</option><option value="simulando">Simulando</option>
          <option value="aguardando">Aguardando autorização</option><option value="oferta">Com oferta</option>
          <option value="aprovado_lp">Aprovado (LP)</option><option value="digitando">Digitando</option>
          <option value="equipe">Com a equipe</option><option value="encerrado">Encerrado</option>
          <option value="interagiu">Interagiu</option><option value="sem_interacao">Aprovado sem interação</option>
          <option value="proposta">Com proposta</option><option value="pago">Pago</option><option value="cancelado">Cancelado</option>
        </select>
        <select className="chip-input" value={filtros.periodo} onChange={(e) => set('periodo', e.target.value)}>
          <option value="hoje">Hoje</option><option value="24h">Últimas 24 h</option><option value="7d">7 dias</option><option value="30d">30 dias</option>
        </select>
        <button className="reset-btn" onClick={carregar}>Atualizar</button>
      </div>
      {erro && <p className="chip-erro">{erro}</p>}
      <div className="panel fav-tabela-caixa">
        <table className="fav-tabela">
          <thead><tr><th>Cliente</th><th>Produto</th><th>Com quem</th><th>Etapa</th><th>Onde está agora</th><th>Banco</th>
            <th className="num">Oferta</th><th>Interação / venda</th><th>Entrou</th><th>Última atividade</th></tr></thead>
          <tbody>
            {dados && !dados.linhas.length && <tr><td colSpan={10} className="fav-vazio">Nenhum atendimento neste período.</td></tr>}
            {(dados?.linhas || []).map((l) => {
              const [quem, ic] = comQuem(l), [et, cor] = etapa(l)
              const ativo = l.na_pagina || (agora - new Date(l.ultima)) < 120000
              return (
                <tr key={l.id} onClick={() => setAberto(l.id)} className={aberto === l.id ? 'sel' : ''}>
                  <td><div className="fav-cliente"><i className={ativo ? 'on' : ''} /><div>
                    <b>{l.nome || 'Sem nome'}</b><small>{fone(l.telefone)} <span>{cpfFmt(l.cpf)}</span></small>
                    <small className="fav-ids">#{l.id}{l.conversa ? ` · conversa ${l.conversa}` : ''}{l.conversa_vendeai ? ` · VendeAI ${l.conversa_vendeai}` : ''}</small></div></div></td>
                  <td>{nomeProduto(l.produto)}{l.trocou_de && <small className="fav-troca">veio do {nomeProduto(l.trocou_de)}</small>}</td>
                  <td><span className="fav-quem"><Icone k={ic} />{quem}</span></td>
                  <td><span className={`fav-badge ${cor}`}>{et}</span></td>
                  <td className="fav-onde">{ondeAgora(l)}</td>
                  <td>{l.banco ? nomeBanco(l.banco) : ''}</td>
                  <td className="num"><b>{l.oferta ? brl(l.oferta) : ''}</b></td>
                  <td><div className="fav-chips-mini">
                    {chipsInteracao(l).map(([t, c]) => <span key={t} className={`fav-badge ${c}`}>{t}</span>)}
                    {chipVenda(l.venda) && <span className={`fav-badge ${chipVenda(l.venda)[1]}`}>{chipVenda(l.venda)[0]}</span>}
                  </div></td>
                  <td>{ha(l.entrou, agora)}</td>
                  <td>{ha(l.ultima, agora)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {aberto && <Detalhe id={aberto} token={token} agora={agora} onFechar={() => setAberto(null)} />}
    </div>
  )
}
