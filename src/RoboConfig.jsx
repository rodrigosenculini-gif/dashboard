import React, { useEffect, useState } from 'react'

// Configurações do robô de follow-up (tabela robo_fu_config): editor genérico com nomes
// legíveis. Cada seção salva sozinha; o robô lê a configuração nova na rodada seguinte (2 min).

const CASOS = ['ticket_alto', 'ofertado', 'assinatura', 'pendencia', 'cliente_sumiu']
const NOME_CASO = { ticket_alto: 'Ticket alto', ofertado: 'Ofertado', assinatura: 'Assinatura', pendencia: 'Pendência', cliente_sumiu: 'Cliente sumiu' }
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

// seções na ordem em que aparecem (as que não estiverem aqui vão no fim)
const SECOES = {
  cadencia:           ['Sequência de follow-up', 'Minutos depois da mensagem sem resposta. O que a vendedora já mandou conta.'],
  horarios:           ['Horários', 'Áudios e ações das vendedoras só dentro destes horários.'],
  tempos:             ['Tempos', 'Prazos do fluxo com cliente esperando.'],
  saturacao:          ['Não saturar o cliente', 'Quando o robô deixa de mandar áudio/lembrete.'],
  protecao:           ['Proteção da vendedora', 'Quando o atendimento nunca é tirado dela.'],
  atribuicao_inicial: ['Atribuição inicial', 'Casos que o robô tira da IA e passa para vendedora.'],
  nao_tirar_da_ia:    ['Não tirar da IA', 'Nos demais casos, conversa com a IA fica com a IA.'],
  ligacao:            ['Lembrete de ligação', 'Oferta alta esperando aceite.'],
  intencoes:          ['Leitura das mensagens', 'Palavras que mudam o caminho (uma por linha, sem acento).'],
  etiquetas:          ['Etiquetas do robô', 'Nomes das etiquetas no CRM.'],
  email:              ['E-mail urgente', 'Envio pelo n8n/SES com cópia para a gestão.'],
  carga:              ['Carga das vendedoras', 'Urgentes esperando e liberação de espaço.'],
  series:             ['Séries de áudio', 'Nome da série no storage para cada caso (ex.: "Alto valor" usa Alto valor.1/.2/.3).'],
  sumiu_audio_final:  ['Áudio final', 'Áudio do último follow-up antes de fechar as 24h.'],
  assinatura:         ['Assinatura', 'Status do banco que contam como aguardando assinatura.'],
  pendencia:          ['Pendência', 'Status do banco que contam como pendência.'],
  pagos:              ['Vendas pagas', 'Cliente com venda paga/registrada nestes dias sai do fluxo.'],
  labels_excluir:     ['Etiquetas que tiram do fluxo', 'Conversa com qualquer uma destas não recebe nada.'],
  equipe_vendas:      ['Equipe de vendas', 'Time do CRM.'],
  limites:            ['Limites por rodada', 'Proteção contra excesso de chamadas no CRM.'],
}

const CAMPO = {
  slots_min: 'Follow-ups (min)', valor_prioridade: 'Valor de prioridade (R$)', slots_valor_baixo: 'Follow-ups abaixo desse valor',
  ligacao_30: 'Aos 30 min liga (casos)', audio: 'Áudios', vendedora: 'Vendedoras', dias: 'Dias', ini: 'Início', fim: 'Fim',
  max_audios_24h: 'Máx. áudios por conversa em 24h', funil_vendedora_min: 'Cliente esperando: passa para vendedora (min)',
  vendedora_lembrete_min: 'Lembrete para a vendedora após (min)', vendedora_retirar_min: 'Retira após o lembrete (min)',
  lembrete_intervalo_min: 'Intervalo entre lembretes da mesma vendedora (min)', janela_whatsapp_h: 'Janela do WhatsApp (h)',
  sumiu_final_antes_janela_min: 'Último follow-up antes de fechar a janela (min)', tolerancia_atraso_min: 'Tolerância de atraso (min)',
  varredura_inicial_h: 'Varredura inicial (h)', funil_audio1_min: '1º áudio (min, fluxo antigo)', sumiu_passos_min: 'Passos (fluxo antigo)',
  audio_recente_min: 'Sem áudio se já recebeu um há menos de (min)', max_msgs_sem_resposta: 'Sem áudio se já tem X mensagens sem resposta',
  lembrete_mesma_conversa_h: '1 lembrete/nota por conversa a cada (h)', link: 'Ela mandou link', min_msgs_vendedora: 'Ela mandou X mensagens',
  atendendo_desde_h: 'Ela atende há mais de (h)', labels_com_ela: 'Etiquetas que protegem', casos_nao_retirar: 'Nunca troca de vendedora (casos)',
  labels_nunca_ia: 'Etiquetas que nunca voltam para a IA', casos: 'Casos', ativo: 'Ativo', valor_min: 'Valor mínimo (R$)',
  labels_bloqueio: 'Etiquetas que bloqueiam', sair: 'Pediu para sair (nao_perturbe)', engano: 'Número errado', objecao: 'Objeção (passa p/ vendedora)',
  ja_fez: 'Já fez com outro banco', depois: 'Vai ver depois', desinteresse: 'Sem interesse', digitar: 'Quer digitar',
  sem_margem: 'IA disse sem margem/não aprovado', pedido_vendedora: 'Vendedora pediu algo', passa_vendedora: 'Passa para vendedora (por intenção)',
  esperando: 'Cliente esperando', copia: 'Cópia', quando: 'Quando enviar', limite_por_hora: 'Máx. por hora', limite_total_dia: 'Máx. no dia',
  limite_por_pessoa_dia: 'Máx. por vendedora no dia', intervalo_por_pessoa_min: 'Intervalo por vendedora (min)', urgentes: 'Casos urgentes',
  max_sem_resposta: 'Limite de urgentes esperando (e-mail)', sem_resposta_apos_min: 'Conta como esperando após (min)', liberar: 'Liberar espaço',
  espera_min: 'Parado há mais de (min)', max_por_rodada: 'Máx. por rodada', volta_ia_casos: 'Volta para a IA (casos)',
  status: 'Status exatos', status_contem: 'Status que contêm', esperar_link_min: 'Esperar após link (min)', bancos_confiaveis: 'Bancos com áudio',
  bancos_esperar_link: 'Bancos que esperam o link', labels: 'Etiquetas', vezes_ate_hotline: 'Vezes até a Hotline', team_id: 'ID do time',
  tempo_max_s: 'Tempo máx. da rodada (s)', max_acoes_por_rodada: 'Máx. ações por rodada', max_consultas_por_rodada: 'Máx. consultas por rodada',
}
const OCULTO = new Set(['criada', 'criadas'])
const LISTA_CASOS = new Set(['casos', 'ligacao_30', 'casos_nao_retirar', 'urgentes', 'volta_ia_casos'])

const copiar = (v) => JSON.parse(JSON.stringify(v))

function Campo({ nome, valor, onChange, dentroDe }) {
  const rotulo = CAMPO[nome] || NOME_CASO[nome] || nome
  if (typeof valor === 'boolean')
    return <label className="rc-campo rc-check"><input type="checkbox" checked={valor} onChange={(e) => onChange(e.target.checked)} /> {rotulo}</label>
  if (typeof valor === 'number')
    return <label className="rc-campo"><span>{rotulo}</span><input type="number" value={valor} onChange={(e) => onChange(Number(e.target.value))} /></label>
  if (typeof valor === 'string')
    return <label className="rc-campo"><span>{rotulo}</span><input value={valor} onChange={(e) => onChange(e.target.value)} /></label>
  if (Array.isArray(valor)) {
    if (nome === 'dias')
      return (
        <div className="rc-campo"><span>{rotulo}</span>
          <div className="rc-opcoes">{DIAS.map((d, n) => (
            <label key={d} className="rc-check"><input type="checkbox" checked={valor.includes(n)}
              onChange={(e) => onChange(e.target.checked ? [...valor, n].sort() : valor.filter((x) => x !== n))} /> {d}</label>))}
          </div>
        </div>)
    if (LISTA_CASOS.has(nome) || dentroDe === 'passa_vendedora')
      return (
        <div className="rc-campo"><span>{rotulo}</span>
          <div className="rc-opcoes">{CASOS.map((c) => (
            <label key={c} className="rc-check"><input type="checkbox" checked={valor.includes(c)}
              onChange={(e) => onChange(e.target.checked ? [...valor, c] : valor.filter((x) => x !== c))} /> {NOME_CASO[c]}</label>))}
          </div>
        </div>)
    if (valor.every((x) => typeof x === 'number'))
      return <label className="rc-campo"><span>{rotulo}</span>
        <input value={valor.join(', ')} onChange={(e) => onChange(e.target.value.split(/[,;\s]+/).filter(Boolean).map(Number).filter((n) => !isNaN(n)))} /></label>
    return <label className="rc-campo rc-largo"><span>{rotulo} <small>(uma por linha)</small></span>
      <textarea rows={Math.min(8, Math.max(2, valor.length + 1))} value={valor.join('\n')}
        onChange={(e) => onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))} /></label>
  }
  if (valor && typeof valor === 'object')
    return (
      <fieldset className="rc-grupo"><legend>{rotulo}</legend>
        {Object.entries(valor).filter(([k]) => !OCULTO.has(k)).map(([k, v]) => (
          <Campo key={k} nome={k} valor={v} dentroDe={nome} onChange={(nv) => onChange({ ...valor, [k]: nv })} />))}
      </fieldset>)
  return null
}

function Secao({ chave, valor, salvar }) {
  const [v, setV] = useState(() => copiar(valor))
  const [estado, setEstado] = useState(null)
  useEffect(() => { setV(copiar(valor)) }, [valor])
  const mudou = JSON.stringify(v) !== JSON.stringify(valor)
  const [titulo, desc] = SECOES[chave] || [chave, '']
  async function onSalvar() {
    setEstado('salvando')
    try { await salvar(chave, v); setEstado('salvo') } catch (e) { setEstado(e.message) }
  }
  return (
    <section className="panel rc-secao">
      <div className="rc-topo">
        <div><p className="section-label">{titulo}</p>{desc && <p className="rc-desc">{desc}</p>}</div>
        <div className="rc-botoes">
          {estado && estado !== 'salvando' && <span className={`rc-estado ${estado === 'salvo' ? 'ok' : 'erro'}`}>{estado === 'salvo' ? 'salvo' : estado}</span>}
          {mudou && <button className="reset-btn" onClick={() => setV(copiar(valor))}>Desfazer</button>}
          <button className="refresh-btn" disabled={!mudou || estado === 'salvando'} onClick={onSalvar}>Salvar</button>
        </div>
      </div>
      {v && typeof v === 'object' && !Array.isArray(v)
        ? <div className="rc-campos">{Object.entries(v).filter(([k]) => !OCULTO.has(k)).map(([k, x]) => (
            <Campo key={k} nome={k} valor={x} dentroDe={chave} onChange={(nx) => setV({ ...v, [k]: nx })} />))}</div>
        : <div className="rc-campos"><Campo nome={chave === 'nao_tirar_da_ia' ? 'ativo' : chave} valor={v} onChange={setV} /></div>}
    </section>
  )
}

function Vendedoras({ lista, salvar }) {
  const [itens, setItens] = useState(lista)
  useEffect(() => { setItens(lista) }, [lista])
  const [msg, setMsg] = useState(null)
  const muda = (id, campo, valor) => setItens((xs) => xs.map((x) => (x.agent_id === id ? { ...x, [campo]: valor } : x)))
  return (
    <section className="panel rc-secao">
      <div className="rc-topo"><div><p className="section-label">Vendedoras do robô</p>
        <p className="rc-desc">Quem recebe atendimentos, lembretes (nome no dashboard) e e-mails. Desativada não recebe nada.</p></div>
        {msg && <span className="rc-estado ok">{msg}</span>}</div>
      <div className="rc-vend">
        {itens.map((x) => {
          const orig = lista.find((o) => o.agent_id === x.agent_id)
          const mudou = JSON.stringify(orig) !== JSON.stringify(x)
          return (
            <div key={x.agent_id} className="rc-vend-linha">
              <label className="rc-check"><input type="checkbox" checked={!!x.ativo} onChange={(e) => muda(x.agent_id, 'ativo', e.target.checked)} /> {x.nome_crm}</label>
              <input placeholder="nome no dashboard" value={x.nome_dash || ''} onChange={(e) => muda(x.agent_id, 'nome_dash', e.target.value)} />
              <input placeholder="e-mail" value={x.email || ''} onChange={(e) => muda(x.agent_id, 'email', e.target.value)} />
              <button className="refresh-btn" disabled={!mudou} onClick={async () => { await salvar(x); setMsg(`${x.nome_crm} salva`) }}>Salvar</button>
            </div>)
        })}
      </div>
    </section>
  )
}

export default function RoboConfig() {
  const [dados, setDados] = useState(null)
  const [erro, setErro] = useState(null)
  const carregar = () => fetch('/api/dashboard?type=robo_config').then((r) => r.json())
    .then((d) => (d?.config ? setDados(d) : setErro(d?.error || 'falha'))).catch((e) => setErro(e.message))
  useEffect(() => { carregar() }, [])

  async function post(type, body) {
    const r = await fetch(`/api/dashboard?type=${type}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const d = await r.json()
    if (!r.ok || d?.ok === false) throw new Error(d?.erro || d?.error || 'falha ao salvar')
    await carregar()
  }

  if (erro) return <div className="state-msg error">Erro: {erro}</div>
  if (!dados) return <div className="home-vazio">carregando configurações...</div>
  const chaves = Object.keys(dados.config).sort((a, b) => {
    const ia = Object.keys(SECOES).indexOf(a), ib = Object.keys(SECOES).indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  return (
    <div className="rc">
      <p className="rc-desc">As mudanças valem a partir da próxima rodada do robô (a cada 2 min).</p>
      <Vendedoras lista={dados.vendedoras} salvar={(v) => post('robo_vendedora_salvar', v)} />
      {chaves.map((k) => <Secao key={k} chave={k} valor={dados.config[k]} salvar={(chave, valor) => post('robo_config_salvar', { chave, valor })} />)}
    </div>
  )
}
