import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDialogo } from './Dialogo'
import IAAnalises from './IAAnalises'
import SecaoTemplates from './IATemplates'
import './IAConfiguracao.css'

// View "Painel" (id 'painel'; antes "IA — Configuração" + "IA — Análises", juntadas em
// 01/10 a pedido do dono): tudo da IA de atendimento num lugar, com menu lateral.
// A seção aberta fica em sessionStorage 'iac_secao' (a tela Geral usa isso para
// abrir direto numa seção). As Análises não precisam do token; os ajustes sim.
// Muda o comportamento da IA de atendimento sem abrir o n8n nem o Supabase. Tudo passa por /api/dashboard?type=config, que so
// repassa para public.config_ler / public.config_salvar -- a validacao e o
// historico (quem, quando, antes e depois) ficam no banco (migracoes 154/155
// do projeto da IA, C:\hotline\supabase).
// Acesso: o login da gestao ja devolve config_token (api/dashboard.js,
// auth_login). Sessao antiga sem o token: a view pede a senha uma vez.

const AUTH_KEY = 'disparos_dashboard_auth'
const TOKEN_KEY = 'ia_config_token'

export function lerToken() {
  try {
    const t = localStorage.getItem(TOKEN_KEY)
    if (t) return t
    return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null')?.config_token || null
  } catch { return null }
}
function gravarToken(t) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY) } catch { /* ignora */ }
}

export async function api(corpo) {
  const r = await fetch('/api/dashboard?type=config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
  })
  return r.json().catch(() => ({ ok: false, motivo: 'erro' }))
}

// ---------------------------------------------------------------- formatos
export const hora = (d) => (d ? new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '')
function quando(d) {
  if (!d) return ''
  const dt = new Date(d), min = Math.round((Date.now() - dt) / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const hoje = new Date().toDateString() === dt.toDateString()
  return hoje ? `hoje às ${hora(d)}` : dt.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function duracao(min) {
  const m = Number(min) || 0
  if (m < 60) return `${m} min`
  if (m % 1440 === 0) return `${m / 1440} dia${m === 1440 ? '' : 's'}`
  if (m % 60 === 0) return `${m / 60} h`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`

const NOME_BANCO = { 'NOVO SAQUE': 'Novo Saque', 'PRESENÇA': 'Presença', SOMA: 'Soma', FACTA: 'Facta', 'SEMPRE FACIL': 'Sempre Fácil', C6: 'C6' }
export const nomeBanco = (b) => NOME_BANCO[b] || b
const NOME_PRODUTO = { fgts: 'FGTS', clt: 'CLT', energia: 'Energia' }
export const nomeProduto = (p) => NOME_PRODUTO[String(p || '').toLowerCase()] || String(p || '').toUpperCase()

// ---------------------------------------------------------------- textos da IA
// codigo -> [nome que aparece, quando a IA manda]. Codigo sem entrada aqui
// aparece pelo proprio nome, com _ trocado por espaco.
const TEXTOS = {
  ola: ['Apresentação curta', 'Primeira mensagem, antes de qualquer outra coisa'],
  saudacao: ['Saudação', 'Começo da conversa, apresentando o produto'],
  saudacao_pedir_cpf: ['Saudação pedindo CPF', 'Começo da conversa quando ainda não temos o CPF'],
  pedir_cpf: ['Pedido de CPF', 'Quando a IA precisa do CPF para consultar'],
  cpf_invalido: ['CPF inválido', 'O cliente mandou um CPF que não confere'],
  consultando_base: ['Cadastro encontrado', 'O CPF já estava na nossa base e a consulta começou'],
  sem_interesse: ['Cliente sem interesse', 'O cliente disse que não quer'],
  jornada_inicio: ['Consulta começou (página)', 'Consulta iniciada; manda o botão para acompanhar na página'],
  jornada_inicio_base: ['Consulta começou com cadastro', 'CPF da base; manda o botão da página'],
  jornada_inicio_sem_cpf: ['Convite para a página', 'Sem CPF: convida o cliente a começar pela página'],
  consultando: ['Consultando', 'Logo depois de receber o CPF'],
  consulta_demorando: ['Consulta demorando', 'O banco está levando mais tempo que o normal'],
  verificando: ['Conferindo com o banco', 'Resposta rápida enquanto a IA consulta'],
  autorizacao: ['Autorização em andamento', 'O banco está confirmando os dados do cliente'],
  autorizacao_pendente: ['Autorização pendente', 'O cliente diz que autorizou, mas o banco ainda não recebeu'],
  autorizacao_dificuldade: ['Ajuda para autorizar', 'O cliente diz que não consegue autorizar no app'],
  autorizacao_bloqueio: ['Banco pediu intervalo', 'O banco bloqueou novas consultas do CPF por um tempo'],
  aceite_banco: ['Falta autorizar outro banco', 'CLT: mais um banco precisa do aceite do cliente'],
  oferta: ['Proposta (uma opção)', 'A consulta deu certo e há uma proposta'],
  ofertas: ['Propostas (várias opções)', 'A consulta trouxe mais de uma opção'],
  oferta_escolher: ['Pedir o número da opção', 'O cliente respondeu sem dizer qual opção quer'],
  oferta_reperguntar: ['Perguntar de novo', 'O cliente não respondeu se quer seguir com a proposta'],
  oferta_melhor: ['Proposta ainda melhor', 'CLT: chegou uma oferta melhor de outro banco'],
  oferta_escolhida: ['Opção escolhida', 'O cliente escolheu; começa a coleta dos dados'],
  jornada_lp: ['Proposta com link da página', 'Proposta enviada com o link da página'],
  jornada_lp_botao: ['Proposta com botão da página', 'Proposta enviada com botão para a página'],
  jornada_flow: ['Proposta pelo WhatsApp Flow', 'Proposta enviada pelo formulário do WhatsApp'],
  jornada_flow_oferta: ['Proposta pelo Flow (com oferta)', 'Proposta dentro do formulário do WhatsApp'],
  negociacao_1: ['Negociação: 2ª opção', 'O cliente pediu mais; a IA oferece a próxima opção'],
  negociacao_2: ['Negociação: valor máximo', 'Última rodada: o maior valor que o banco libera'],
  followup_1: ['1º lembrete', 'O cliente parou de responder nesta etapa'],
  followup_2: ['2º lembrete', 'O cliente continua sem responder'],
  followup_jornada_1: ['1º lembrete da página', 'O cliente viu a proposta na página e não finalizou'],
  followup_jornada_2: ['Último lembrete da página', 'Segunda cobrança da proposta da página'],
  lembrete_lp_autorizar: ['Lembrete: falta autorizar', 'Na página, parou na autorização'],
  lembrete_lp_consulta: ['Lembrete: consulta andando', 'Na página, parou enquanto a consulta rodava'],
  lembrete_lp_oferta: ['Lembrete: proposta esperando', 'Na página, viu a proposta e não finalizou'],
  coleta_nome: ['Pergunta: nome completo', 'Coleta dos dados do contrato'],
  coleta_nascimento: ['Pergunta: nascimento', 'Coleta dos dados do contrato'],
  coleta_sexo: ['Pergunta: sexo', 'Coleta dos dados do contrato'],
  coleta_email: ['Pergunta: e-mail', 'Coleta dos dados do contrato'],
  coleta_telefone: ['Pergunta: celular', 'Coleta dos dados do contrato'],
  coleta_profissao: ['Pergunta: profissão', 'Coleta dos dados do contrato'],
  coleta_pep: ['Pergunta: pessoa politicamente exposta', 'Coleta dos dados do contrato'],
  coleta_cep: ['Pergunta: CEP', 'Coleta do endereço'],
  coleta_rua: ['Pergunta: rua', 'Coleta do endereço'],
  coleta_numero: ['Pergunta: número', 'Coleta do endereço'],
  coleta_bairro: ['Pergunta: bairro', 'Coleta do endereço'],
  coleta_cidade: ['Pergunta: cidade', 'Coleta do endereço'],
  coleta_uf: ['Pergunta: estado', 'Coleta do endereço'],
  coleta_pix: ['Pergunta: onde receber', 'Último dado: Pix ou conta'],
  coleta_ted: ['Dados para TED', 'O cliente prefere receber por TED'],
  coleta_invalido: ['Resposta não aceita', 'O dado não confere; explica e pergunta de novo'],
  coleta_reiniciar: ['Refazer os dados', 'O cliente quer começar os dados de novo'],
  confirmacao: ['Confirmação dos dados', 'Resumo de tudo antes de enviar ao banco'],
  confirmacao_corrigir: ['Corrigir um dado', 'O cliente disse que algo está errado'],
  confirmacao_responder: ['Pedir SIM ou NÃO', 'O cliente não respondeu à confirmação'],
  digitando: ['Enviando ao banco', 'Os dados foram confirmados e a proposta vai para o banco'],
  ensaio_nota: ['Nota: envio de teste', 'Nota interna: a digitação foi só um ensaio'],
  aguardando_link: ['Contrato sendo gerado', 'O banco ainda não gerou o link de assinatura'],
  link: ['Link de assinatura', 'O contrato está pronto para assinar'],
  acompanhamento_assinar: ['Falta assinar', 'O contrato espera a assinatura do cliente'],
  acompanhamento_analise: ['Contrato em análise', 'Assinado; o banco está analisando'],
  assinatura_confirmada: ['Assinatura confirmada', 'O banco confirmou a assinatura'],
  pago: ['Pagamento feito', 'O banco pagou o cliente'],
  encerrado: ['Atendimento encerrado', 'A conversa foi encerrada'],
  encerrado_curto: ['Resposta a agradecimento', 'O cliente agradeceu depois do fim'],
  encerrado_pago: ['Agradecimento final', 'O cliente agradeceu depois de receber'],
  encerrado_sem_sucesso: ['Encerrado sem sucesso', 'Não deu certo desta vez'],
  sem_saldo: ['Sem saldo', 'O banco não encontrou saldo ou margem'],
  fora_politica: ['Não aprovado', 'O banco recusou pela política dele'],
  indicacao: ['Pedido de indicação', 'Depois do atendimento, pede contatos de amigos'],
  indicacao_recebida: ['Indicação recebida', 'O cliente mandou contatos'],
  indicacao_repetida: ['Indicação repetida', 'O contato indicado já está em atendimento'],
  derivar: ['Passando para a equipe', 'A IA transfere o cliente para uma vendedora'],
  derivar_nota: ['Nota: motivo da transferência', 'Nota interna para a vendedora'],
  instabilidade: ['Banco instável', 'O banco está fora do ar ou falhando'],
  obrigada: ['Obrigada', 'Resposta curta de agradecimento'],
  troca_produto: ['Troca de produto', 'Um produto não deu certo e a IA já tenta o outro'],
  troca_prefixo: ['Troca deu certo', 'Um produto não liberou, mas o outro sim'],
  troca_produto_aniversario: ['FGTS no mês do aniversário', 'O FGTS só libera depois do aniversário'],
  troca_prefixo_aniversario: ['FGTS depois do aniversário', 'FGTS só depois do aniversário, mas o CLT deu certo'],
}
const tituloTexto = (c) => (TEXTOS[c]?.[0] || c.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase()))
const quandoTexto = (c) => TEXTOS[c]?.[1] || ''
const ehNota = (c) => /_nota$/.test(c)

const VARIAVEIS = {
  valor: 'valor liberado', parcelas: 'número de parcelas', parcela: 'valor da parcela', link: 'link',
  cpf_final: 'fim do CPF', motivo: 'motivo', pergunta: 'próxima pergunta', resumo: 'resumo dos dados',
  opcoes: 'lista de opções', ofertas: 'lista de ofertas', quantos: 'quantos contatos', data: 'data', fase: 'etapa',
  nome: 'nome', banco: 'banco', taxa: 'taxa', prazo: 'prazo', antecipacao: 'nº de antecipações', hora: 'horário',
}
const varsDo = (t) => Array.from(new Set((String(t || '').match(/\{\{\s*[a-z_0-9]+\s*\}\}/g) || []).map((v) => v.replace(/[{}\s]/g, ''))))

// etapas na ordem da conversa
const ETAPAS = [
  ['inicio', 'Início'], ['identificacao', 'CPF'], ['consulta', 'Consulta'], ['autorizacao', 'Autorização'],
  ['oferta', 'Oferta'], ['negociacao', 'Negociação'], ['coleta', 'Dados'], ['digitacao', 'Envio ao banco'],
  ['formalizacao', 'Assinatura'], ['acompanhamento', 'Acompanhamento'], ['encerrado', 'Encerramento'],
  ['lembretes_lp', 'Lembretes da página'], ['geral', 'Situações especiais'],
]
const NOME_ETAPA = Object.fromEntries(ETAPAS)
function etapaDo(m) {
  if (m.fase) return m.fase
  if (/^(ola|saudacao|jornada_inicio)/.test(m.codigo)) return 'inicio'
  if (/^lembrete_lp_/.test(m.codigo)) return 'lembretes_lp'
  return 'geral'
}

// ---------------------------------------------------------------- pequenos componentes
export function Chave({ ligado, onChange, disabled, rotulo }) {
  return (
    <button type="button" role="switch" aria-checked={!!ligado} aria-label={rotulo} disabled={disabled}
            className={`iac-chave ${ligado ? 'on' : ''}`} onClick={() => onChange(!ligado)}>
      <i />
    </button>
  )
}

function Numero({ valor, onChange, min, max, passo = 1, sufixo, largura = 70 }) {
  return (
    <span className="iac-num">
      <input type="number" value={valor ?? ''} min={min} max={max} step={passo} style={{ width: largura }}
             onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
      {sufixo && <em>{sufixo}</em>}
    </span>
  )
}

// campo com Salvar/Desfazer que so aparece quando o valor muda
function useRascunho(original) {
  const [v, setV] = useState(original)
  const chave = JSON.stringify(original)
  useEffect(() => { setV(original) }, [chave]) // eslint-disable-line react-hooks/exhaustive-deps
  const mudou = JSON.stringify(v) !== chave
  return [v, setV, mudou, () => setV(original)]
}
function BotoesRascunho({ mudou, onSalvar, onDesfazer, salvando }) {
  if (!mudou) return null
  return (
    <span className="iac-rascunho">
      <button className="chip-salvar iac-btn-p" onClick={onSalvar} disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar'}</button>
      <button className="reset-btn" onClick={onDesfazer} disabled={salvando}>Desfazer</button>
    </span>
  )
}

function Linha({ titulo, ajuda, children, id }) {
  return (
    <div className="iac-linha" id={id}>
      <div className="iac-linha-txt">
        <b>{titulo}</b>
        {ajuda && <small>{ajuda}</small>}
      </div>
      <div className="iac-linha-ctl">{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------- bancos
export function estadoBanco(b) {
  const u = b.uso_24h || {}
  if (!b.ativo && b.pausado_ate) return { cls: 'pausa', txt: `Pausado até ${hora(b.pausado_ate)}` }
  if (!b.ativo) return { cls: 'off', txt: 'Desligado' }
  return ({
    bom: { cls: 'ok', txt: 'Funcionando bem' },
    atencao: { cls: 'aviso', txt: 'Algumas falhas' },
    ruim: { cls: 'ruim', txt: 'Falhando muito' },
    sem_uso: { cls: 'neutro', txt: 'Sem consultas em 24 h' },
  })[u.saude] || { cls: 'neutro', txt: 'Ligado' }
}

function BarraUso({ u }) {
  const t = u?.chamadas || 0
  if (!t) return <div className="iac-barra vazia" />
  const p = (n) => `${(100 * (n || 0)) / t}%`
  return (
    <div className="iac-barra" title="verde: deu certo · cinza: situação do cliente · vermelho: falha do banco · amarelo: ajuste nosso">
      <i className="b-ok" style={{ width: p(u.ok) }} />
      <i className="b-cli" style={{ width: p(u.cliente) }} />
      <i className="b-int" style={{ width: p(u.integracao) }} />
      <i className="b-falha" style={{ width: p(u.falhas) }} />
    </div>
  )
}

function CartaoBanco({ b, salvar, sozinho, dialogo }) {
  const u = b.uso_24h || {}
  const est = estadoBanco(b)
  const [aberto, setAberto] = useState(false)
  const [av, setAv, mudou, desfazer] = useRascunho({ ordem: b.ordem, timeout_segundos: b.timeout_segundos, max_tentativas: b.max_tentativas })
  const [salvando, setSalvando] = useState(false)
  const chave = { produto: b.produto, banco: b.banco }

  async function ligar(v) {
    if (!v && sozinho && !await dialogo.confirmar({
      titulo: `Desligar ${nomeBanco(b.banco)}?`,
      texto: `É o único banco ligado no ${nomeProduto(b.produto)}. Desligando, a IA fica sem banco para consultar esse produto.`,
      perigo: true, rotuloOk: 'Desligar mesmo assim',
    })) return
    salvar('banco', { ...chave, ativo: v }, v ? `${nomeBanco(b.banco)} ligado` : `${nomeBanco(b.banco)} desligado`)
  }
  async function pausar(h) {
    const motivo = await dialogo.perguntar({
      titulo: `Pausar ${nomeBanco(b.banco)} por ${h} h`, texto: 'Por quê? Fica no histórico. Ele religa sozinho no fim da pausa.',
      valorInicial: 'banco instável',
    })
    if (motivo === null) return
    salvar('banco', { ...chave, pausar_horas: h, motivo }, `${nomeBanco(b.banco)} pausado por ${h} h`)
  }

  const frase = u.chamadas
    ? `${plural(u.chamadas, 'consulta', 'consultas')}: ${u.ok} deram certo` +
      (u.cliente ? `, ${u.cliente} pararam em algo do cliente` : '') +
      (u.integracao ? `, ${u.integracao} precisam de ajuste nosso` : '') +
      (u.falhas ? `, ${plural(u.falhas, 'falha', 'falhas')} do banco` : ', nenhuma falha do banco') + '.'
    : 'Nenhuma consulta nas últimas 24 horas.'

  return (
    <div className={`iac-banco s-${est.cls}`} id={`banco-${b.produto}-${b.banco}`}>
      <div className="iac-banco-topo">
        <span className="iac-dot" />
        <div className="iac-banco-nome">
          <b>{nomeBanco(b.banco)}</b>
          <span>{est.txt}{b.pausa_motivo && !b.ativo ? ` · ${b.pausa_motivo}` : ''}</span>
        </div>
        <Chave ligado={b.ativo} onChange={ligar} rotulo={`Ligar ou desligar ${nomeBanco(b.banco)}`} />
      </div>
      <BarraUso u={u} />
      <p className="iac-frase">{frase}</p>
      {u.ultima_falha && (
        <p className="iac-falha">Última falha {quando(u.ultima_falha.em)}: <b>{u.ultima_falha.motivo}</b></p>
      )}
      <div className="iac-banco-acoes">
        {b.ativo ? (
          <>
            <span className="iac-rot">Pausar por</span>
            {[1, 4, 24].map((h) => <button key={h} className="chip-opcao" onClick={() => pausar(h)}>{h} h</button>)}
          </>
        ) : (
          <button className="chip-opcao on" onClick={() => ligar(true)}>Religar agora</button>
        )}
        <button className="iac-link" onClick={() => setAberto((x) => !x)}>{aberto ? 'Fechar detalhes' : 'Detalhes e ajustes'}</button>
      </div>
      {aberto && (
        <div className="iac-banco-det">
          {u.motivos?.length > 0 && (
            <>
              <p className="section-label">O que aconteceu nas últimas 24 h</p>
              <ul className="iac-motivos">
                {u.motivos.map((m) => (
                  <li key={m.classe + m.motivo}>
                    <span className={`iac-tag t-${m.classe}`}>{({ cliente: 'cliente', banco: 'banco', integracao: 'ajuste nosso' })[m.classe]}</span>
                    {m.motivo}<em>{m.n}</em>
                  </li>
                ))}
              </ul>
            </>
          )}
          {u.latencia_ms > 0 && <p className="iac-miudo">Tempo médio de resposta: {(u.latencia_ms / 1000).toFixed(1)} s{u.ultimo_ok_em ? ` · última consulta que deu certo ${quando(u.ultimo_ok_em)}` : ''}</p>}
          <p className="section-label" style={{ marginTop: 14 }}>Ajustes avançados</p>
          <Linha titulo="Ordem de consulta" ajuda="1 = consultado primeiro.">
            <Numero valor={av.ordem} min={1} max={50} onChange={(v) => setAv({ ...av, ordem: v })} largura={60} />
          </Linha>
          <Linha titulo="Tempo máximo de espera" ajuda="Depois disso a IA desiste dessa tentativa.">
            <Numero valor={av.timeout_segundos} min={10} max={600} sufixo="segundos" onChange={(v) => setAv({ ...av, timeout_segundos: v })} />
          </Linha>
          <Linha titulo="Tentativas quando falha" ajuda="Quantas vezes tenta de novo antes de desistir.">
            <Numero valor={av.max_tentativas} min={1} max={10} onChange={(v) => setAv({ ...av, max_tentativas: v })} largura={60} />
          </Linha>
          <BotoesRascunho mudou={mudou} salvando={salvando} onDesfazer={desfazer} onSalvar={async () => {
            setSalvando(true); await salvar('banco', { ...chave, ...av }, 'Ajustes salvos'); setSalvando(false)
          }} />
        </div>
      )}
    </div>
  )
}

function SecaoBancos({ d, salvar, dialogo }) {
  const porProduto = useMemo(() => {
    const g = {}
    for (const b of d.bancos) (g[b.produto] = g[b.produto] || []).push(b)
    return Object.entries(g)
  }, [d.bancos])
  return (
    <>
      <p className="iac-intro">
        Cada cartão mostra como o banco foi nas últimas 24 horas. Só as <b className="c-falha">falhas do banco</b> pesam na
        saúde: quando o cliente não tem saldo, não autorizou ou usou um celular já cadastrado, a consulta para por
        <b className="c-cli"> algo do cliente</b>, e isso é normal. Ligar, desligar ou pausar vale na hora para a IA, a página e
        o painel de simulação. A pausa religa o banco sozinha.
      </p>
      <div className="iac-legenda">
        <span><i className="b-ok" />deu certo</span><span><i className="b-cli" />situação do cliente</span>
        <span><i className="b-int" />ajuste nosso</span><span><i className="b-falha" />falha do banco</span>
      </div>
      {porProduto.map(([p, lista]) => (
        <section key={p} className="iac-bloco">
          <p className="section-label">{nomeProduto(p)} · {lista.filter((b) => b.ativo).length} de {lista.length} ligados</p>
          <div className="iac-bancos">
            {lista.map((b) => (
              <CartaoBanco key={b.banco} b={b} salvar={salvar} dialogo={dialogo}
                           sozinho={lista.filter((x) => x.ativo).length <= 1} />
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

// ---------------------------------------------------------------- mensagens
function Previa({ texto }) {
  const partes = String(texto || '').split(/(\{\{\s*[a-z_0-9]+\s*\}\})/g)
  return (
    <p className="iac-previa">
      {partes.map((p, i) => {
        const v = p.match(/^\{\{\s*([a-z_0-9]+)\s*\}\}$/)
        return v ? <span key={i} className="iac-var" title={`{{${v[1]}}}`}>{VARIAVEIS[v[1]] || v[1]}</span> : p
      })}
    </p>
  )
}

function CartaoTexto({ m, salvar, abertoInicial }) {
  const [aberto, setAberto] = useState(!!abertoInicial)
  const [t, setT, mudou, desfazer] = useRascunho({ conteudo: m.conteudo, redigir: m.redigir, ativo: m.ativo })
  const [salvando, setSalvando] = useState(false)
  const ref = useRef(null)
  const obrig = varsDo(m.conteudo)
  const faltam = obrig.filter((v) => !varsDo(t.conteudo).includes(v))

  function inserir(v) {
    const el = ref.current, ins = `{{${v}}}`
    if (!el) return setT({ ...t, conteudo: t.conteudo + ins })
    const a = el.selectionStart ?? t.conteudo.length, z = el.selectionEnd ?? a
    setT({ ...t, conteudo: t.conteudo.slice(0, a) + ins + t.conteudo.slice(z) })
    setTimeout(() => { el.focus(); el.setSelectionRange(a + ins.length, a + ins.length) }, 0)
  }

  return (
    <div className={`iac-texto ${m.ativo ? '' : 'desligado'} ${aberto ? 'aberto' : ''}`} id={`texto-${m.id}`}>
      <button className="iac-texto-cab" onClick={() => setAberto((x) => !x)}>
        <div>
          <b>{tituloTexto(m.codigo)}</b>
          {quandoTexto(m.codigo) && <small>{quandoTexto(m.codigo)}</small>}
        </div>
        <span className="iac-tags">
          <span className="iac-tag">{m.produto ? nomeProduto(m.produto) : 'todos'}</span>
          {ehNota(m.codigo) && <span className="iac-tag t-nota">nota interna</span>}
          {!m.ativo && <span className="iac-tag t-banco">desligado</span>}
          {m.redigir && <span className="iac-tag t-ia" title="A IA pode trocar as palavras, mantendo números e links">IA adapta</span>}
        </span>
      </button>
      {!aberto && <Previa texto={m.conteudo} />}
      {aberto && (
        <div className="iac-texto-ed">
          <textarea ref={ref} className="chip-input" rows={Math.min(10, Math.max(3, Math.ceil(t.conteudo.length / 90)))}
                    value={t.conteudo} onChange={(e) => setT({ ...t, conteudo: e.target.value })} />
          {obrig.length > 0 && (
            <div className="iac-vars">
              <span className="iac-rot">Dados que entram sozinhos (toque para inserir):</span>
              {obrig.map((v) => (
                <button key={v} className={`iac-var ${faltam.includes(v) ? 'falta' : ''}`} onClick={() => inserir(v)}>
                  {VARIAVEIS[v] || v}
                </button>
              ))}
            </div>
          )}
          {faltam.length > 0 && <p className="chip-erro">O texto precisa continuar com: {faltam.map((v) => VARIAVEIS[v] || v).join(', ')}.</p>}
          <div className="iac-texto-rodape">
            <label className="chip-switch"><Chave ligado={t.redigir} onChange={(v) => setT({ ...t, redigir: v })} rotulo="IA adapta" />
              <span>A IA pode adaptar as palavras <small>(mantém valores e links)</small></span></label>
            <label className="chip-switch"><Chave ligado={t.ativo} onChange={(v) => setT({ ...t, ativo: v })} rotulo="Em uso" />
              <span>Em uso</span></label>
            <span className="iac-miudo">{m.atualizado_em ? `alterado ${quando(m.atualizado_em)}` : ''}</span>
          </div>
          <div className="iac-texto-rodape">
            <BotoesRascunho mudou={mudou && !faltam.length} salvando={salvando} onDesfazer={desfazer} onSalvar={async () => {
              setSalvando(true); const ok = await salvar('mensagem', { id: m.id, ...t }, 'Texto salvo'); setSalvando(false); if (ok) setAberto(false)
            }} />
            {!mudou && <button className="reset-btn" onClick={() => setAberto(false)}>Fechar</button>}
          </div>
        </div>
      )}
    </div>
  )
}

function SecaoMensagens({ d, salvar, filtroInicial }) {
  const [busca, setBusca] = useState(filtroInicial?.busca || '')
  const [prod, setProd] = useState('')
  const [etapa, setEtapa] = useState(filtroInicial?.etapa || '')
  useEffect(() => { if (filtroInicial) { setBusca(filtroInicial.busca || ''); setEtapa(filtroInicial.etapa || '') } }, [filtroInicial])

  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const lista = useMemo(() => {
    const q = norm(busca)
    return d.mensagens.filter((m) => (!prod || !m.produto || m.produto === prod)
      && (!q || norm(`${tituloTexto(m.codigo)} ${quandoTexto(m.codigo)} ${m.codigo} ${m.conteudo}`).includes(q)))
  }, [d.mensagens, busca, prod])
  const contagem = useMemo(() => {
    const c = {}
    for (const m of lista) { const e = etapaDo(m); c[e] = (c[e] || 0) + 1 }
    return c
  }, [lista])
  const visiveis = lista.filter((m) => !etapa || etapaDo(m) === etapa)

  return (
    <>
      <p className="iac-intro">
        Os textos fixos que a IA manda, na ordem da conversa. O que aparece destacado (como <span className="iac-var">valor liberado</span>)
        é preenchido sozinho com o dado do cliente. Com <b>“IA adapta”</b>, a IA pode trocar as palavras para soar natural;
        sem isso, o texto sai exatamente como está.
      </p>
      <div className="iac-filtros">
        <input className="chip-input iac-busca-local" value={busca} onChange={(e) => setBusca(e.target.value)}
               placeholder="Procurar um texto (ex.: CPF, assinatura, Pix)" />
        <div className="chip-opcoes">
          {[['', 'Todos os produtos'], ['fgts', 'FGTS'], ['clt', 'CLT']].map(([k, t]) => (
            <button key={k} className={`chip-opcao ${prod === k ? 'on' : ''}`} onClick={() => setProd(k)}>{t}</button>
          ))}
        </div>
      </div>
      <div className="iac-etapas" role="tablist">
        <button className={`iac-etapa ${!etapa ? 'on' : ''}`} onClick={() => setEtapa('')}>Todas <em>{lista.length}</em></button>
        {ETAPAS.filter(([k]) => contagem[k]).map(([k, t]) => (
          <button key={k} className={`iac-etapa ${etapa === k ? 'on' : ''}`} onClick={() => setEtapa(k)}>{t} <em>{contagem[k]}</em></button>
        ))}
      </div>
      {ETAPAS.filter(([k]) => (!etapa || etapa === k) && visiveis.some((m) => etapaDo(m) === k)).map(([k, t]) => (
        <section key={k} className="iac-bloco">
          <p className="section-label">{t}</p>
          <div className="iac-textos">
            {visiveis.filter((m) => etapaDo(m) === k).map((m) => (
              <CartaoTexto key={m.id} m={m} salvar={salvar} abertoInicial={filtroInicial?.abrir === m.id} />
            ))}
          </div>
        </section>
      ))}
      {!visiveis.length && <p className="home-vazio">Nenhum texto com esse filtro.</p>}
    </>
  )
}

// ---------------------------------------------------------------- lembretes
function LinhaFollowup({ f, salvar }) {
  const [min, setMin, mudou, desfazer] = useRascunho(f.apos_minutos)
  return (
    <div className={`iac-fu ${f.ativo ? '' : 'off'}`}>
      <Chave ligado={f.ativo} rotulo="Lembrete ligado"
             onChange={(v) => salvar('followup', { id: f.id, ativo: v }, v ? 'Lembrete ligado' : 'Lembrete desligado')} />
      <span className="iac-fu-n">{f.ordem}º lembrete</span>
      <span className="iac-rot">depois de</span>
      <Numero valor={min} min={1} max={10080} sufixo="min" onChange={setMin} largura={70} />
      <span className="iac-miudo">{min ? `(${duracao(min)})` : ''}</span>
      <BotoesRascunho mudou={mudou} onDesfazer={desfazer}
                      onSalvar={() => salvar('followup', { id: f.id, apos_minutos: Number(min) }, 'Tempo do lembrete salvo')} />
    </div>
  )
}

function SecaoLembretes({ d, salvar, param, irPara }) {
  const silencio = param('lembrete_silencio')
  const reat = param('reativacao')
  const [sil, setSil, mudouSil, desfazerSil] = useRascunho(silencio?.valor || { inicio: 21, fim: 8 })
  const grupos = useMemo(() => {
    const g = {}
    for (const f of d.followups) {
      const k = f.produto
      g[k] = g[k] || {}
      ;(g[k][f.fase] = g[k][f.fase] || []).push(f)
    }
    return g
  }, [d.followups])

  return (
    <>
      <p className="iac-intro">
        Quando o cliente para de responder, a IA manda lembretes. O tempo conta a partir da última mensagem da IA.
        Os textos de cada lembrete ficam em <button className="iac-link" onClick={() => irPara('mensagens', { busca: 'lembrete' })}>Mensagens → lembretes</button>.
      </p>
      {silencio && (
        <section className="iac-bloco panel">
          <Linha titulo="Horário de silêncio" ajuda="Nenhum lembrete nesse horário. O que vencer no meio sai no fim do silêncio (se ainda estiver dentro das 24 h do WhatsApp).">
            <span className="iac-rot">das</span>
            <Numero valor={sil.inicio} min={0} max={23} sufixo="h" onChange={(v) => setSil({ ...sil, inicio: v })} largura={56} />
            <span className="iac-rot">às</span>
            <Numero valor={sil.fim} min={0} max={23} sufixo="h" onChange={(v) => setSil({ ...sil, fim: v })} largura={56} />
            <BotoesRascunho mudou={mudouSil} onDesfazer={desfazerSil}
                            onSalvar={() => salvar('parametro', { chave: 'lembrete_silencio', valor: { ...silencio.valor, inicio: Number(sil.inicio), fim: Number(sil.fim) } }, 'Horário de silêncio salvo')} />
          </Linha>
          {reat && (
            <Linha titulo="Retomar conversas paradas há mais de 24 h" ajuda="Depois de 24 h o WhatsApp só deixa escrever com um modelo aprovado pela Meta. Ligado, a IA usa esses modelos para retomar.">
              <Chave ligado={!!reat.valor?.ativa} rotulo="Retomar conversas"
                     onChange={(v) => salvar('parametro', { chave: 'reativacao', valor: { ...reat.valor, ativa: v } }, v ? 'Retomada ligada' : 'Retomada desligada')} />
            </Linha>
          )}
        </section>
      )}
      {Object.entries(grupos).map(([p, fases]) => (
        <section key={p} className="iac-bloco">
          <p className="section-label">Lembretes · {nomeProduto(p)}</p>
          <div className="iac-fus">
            {ETAPAS.filter(([k]) => fases[k]).map(([k, t]) => (
              <div key={k} className="iac-fu-etapa panel">
                <b>Parou em: {t}</b>
                {fases[k].sort((a, b) => a.ordem - b.ordem).map((f) => <LinhaFollowup key={f.id} f={f} salvar={salvar} />)}
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

// ---------------------------------------------------------------- ofertas e jornada
const JORNADAS = [['lp', 'Página (LP)'], ['chat', 'Conversa no chat'], ['flow', 'WhatsApp Flow'], ['flow_oferta', 'Flow com a oferta']]
function EditorJornada({ p, salvar, flowAtivo }) {
  const [v, setV, mudou, desfazer] = useRascunho(p.valor || {})
  const soma = JORNADAS.reduce((s, [k]) => s + (Number(v[k]) || 0), 0)
  const unica = JORNADAS.find(([k]) => Number(v[k]) === soma && soma > 0)?.[0]
  const [misturar, setMisturar] = useState(!unica)
  return (
    <div>
      <div className="chip-opcoes">
        {JORNADAS.map(([k, t]) => (
          <button key={k} className={`chip-opcao ${!misturar && unica === k ? 'on' : ''}`} disabled={k.startsWith('flow') && !flowAtivo}
                  title={k.startsWith('flow') && !flowAtivo ? 'Ligue "WhatsApp Flow publicado" primeiro' : ''}
                  onClick={() => { setMisturar(false); setV(Object.fromEntries(JORNADAS.map(([x]) => [x, x === k ? 100 : 0]))) }}>{t}</button>
        ))}
        <button className={`chip-opcao ${misturar ? 'on' : ''}`} onClick={() => setMisturar(true)}>Misturar</button>
      </div>
      {misturar && (
        <div className="iac-mistura">
          {JORNADAS.map(([k, t]) => (
            <label key={k}><span>{t}</span><Numero valor={v[k] ?? 0} min={0} max={100} sufixo="%" largura={60}
                                                    onChange={(n) => setV({ ...v, [k]: n === '' ? 0 : n })} /></label>
          ))}
          <small className={soma === 100 ? 'iac-miudo' : 'chip-erro'}>Soma: {soma}%{soma !== 100 ? ' (o sorteio usa a proporção, mas o ideal é somar 100)' : ''}</small>
        </div>
      )}
      <BotoesRascunho mudou={mudou} onDesfazer={() => { desfazer(); setMisturar(!unica) }}
                      onSalvar={() => salvar('parametro', { chave: p.chave, valor: Object.fromEntries(Object.entries(v).map(([k, n]) => [k, Number(n) || 0])) }, 'Jornada salva')} />
    </div>
  )
}

const NOME_DEGRAU = { maior_valor: 'a de maior valor', menor_taxa: 'a de menor taxa', intermediaria: 'a intermediária' }
function EditorEscada({ p, salvar }) {
  const [v, setV, mudou, desfazer] = useRascunho(Array.isArray(p.valor) ? p.valor : [])
  const [novo, setNovo] = useState('')
  const mover = (i, d) => { const a = [...v]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; setV(a) }
  return (
    <div className="iac-escada">
      <ol>
        {v.map((x, i) => (
          <li key={i}>
            <span className="iac-escada-n">{i === 0 ? 'Oferta' : `${i}ª negociação`}</span>
            <b>{NOME_DEGRAU[x] || `tabela ${x}`}</b>
            <span className="iac-escada-acoes">
              <button onClick={() => mover(i, -1)} disabled={!i} aria-label="Subir">↑</button>
              <button onClick={() => mover(i, 1)} disabled={i === v.length - 1} aria-label="Descer">↓</button>
              <button onClick={() => setV(v.filter((_, j) => j !== i))} aria-label="Remover">✕</button>
            </span>
          </li>
        ))}
      </ol>
      <div className="iac-escada-add">
        <select className="chip-input" value={novo} onChange={(e) => setNovo(e.target.value)}>
          <option value="">Adicionar degrau…</option>
          {Object.entries(NOME_DEGRAU).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          <option value="__tabela">uma tabela pelo nome…</option>
        </select>
        {novo === '__tabela'
          ? <input className="chip-input" placeholder="Nome da tabela, como aparece no banco" onKeyDown={(e) => {
              if (e.key === 'Enter' && e.target.value.trim()) { setV([...v, e.target.value.trim()]); setNovo('') }
            }} />
          : <button className="reset-btn" disabled={!novo} onClick={() => { setV([...v, novo]); setNovo('') }}>Adicionar</button>}
      </div>
      <BotoesRascunho mudou={mudou} onDesfazer={desfazer} onSalvar={() => salvar('parametro', { chave: p.chave, valor: v }, 'Ordem das ofertas salva')} />
    </div>
  )
}

function ParamNumero({ p, salvar, titulo, ajuda, fator = 1, sufixo, min, max, passo }) {
  const [v, setV, mudou, desfazer] = useRascunho(p ? Number(p.valor) / fator : '')
  if (!p) return null
  return (
    <Linha titulo={titulo} ajuda={ajuda} id={`param-${p.chave}`}>
      <Numero valor={v} min={min} max={max} passo={passo} sufixo={sufixo} onChange={setV} largura={86} />
      <BotoesRascunho mudou={mudou} onDesfazer={desfazer}
                      onSalvar={() => salvar('parametro', { chave: p.chave, valor: Math.round(Number(v) * fator * 100) / 100 }, `${titulo}: salvo`)} />
    </Linha>
  )
}

function ProdutoLinha({ p, salvar }) {
  const [teto, setTeto, mudou, desfazer] = useRascunho(p.teto_rodadas_negociacao ?? 2)
  return (
    <div className={`iac-produto ${p.ativo ? '' : 'off'}`}>
      <div className="iac-linha-txt"><b>{p.nome || p.codigo}</b><small>{p.ativo ? 'A IA atende' : 'A IA não atende'}</small></div>
      <Chave ligado={p.ativo} rotulo={`IA atende ${p.nome}`}
             onChange={(v) => salvar('produto', { codigo: p.codigo, ativo: v }, v ? 'Produto ligado' : 'Produto desligado')} />
      <span className="iac-rot">Rodadas de negociação</span>
      <Numero valor={teto} min={0} max={6} onChange={setTeto} largura={56} />
      <BotoesRascunho mudou={mudou} onDesfazer={desfazer}
                      onSalvar={() => salvar('produto', { codigo: p.codigo, teto_rodadas_negociacao: Number(teto) }, 'Rodadas salvas')} />
    </div>
  )
}

function SecaoOfertas({ d, salvar, param }) {
  const flow = param('flow_ativo'), ind = param('indicacoes_ativas')
  return (
    <>
      <p className="iac-intro">Quais produtos a IA atende, como o cliente vê a proposta e em que ordem as opções são oferecidas.</p>
      <section className="iac-bloco">
        <p className="section-label">Produtos</p>
        <div className="panel">
          <p className="iac-miudo" style={{ marginTop: 0 }}>Rodadas de negociação: quantas vezes a IA oferece outra opção quando o cliente pede mais. Depois disso, passa para a equipe.</p>
          {d.produtos.map((p) => <ProdutoLinha key={p.codigo} p={p} salvar={salvar} />)}
        </div>
      </section>

      <section className="iac-bloco">
        <p className="section-label">Como o cliente vê a proposta</p>
        <div className="panel">
          {flow && (
            <Linha titulo="WhatsApp Flow publicado" ajuda="Ligue só quando o formulário estiver aprovado na Meta. Desligado, quem cairia no Flow vai para a página.">
              <Chave ligado={!!flow.valor} rotulo="Flow publicado"
                     onChange={(v) => salvar('parametro', { chave: 'flow_ativo', valor: v }, v ? 'Flow ligado' : 'Flow desligado')} />
            </Linha>
          )}
          {['fgts_variantes', 'clt_variantes'].map((k) => param(k) && (
            <Linha key={k} titulo={k.startsWith('fgts') ? 'FGTS' : 'CLT'} ajuda="Por onde a proposta chega ao cliente." id={`param-${k}`}>
              <EditorJornada p={param(k)} salvar={salvar} flowAtivo={!!flow?.valor} />
            </Linha>
          ))}
          <ParamNumero p={param('jornada_lead_horas')} salvar={salvar} titulo="Validade do link do disparo"
                       ajuda="Por quanto tempo o link enviado no disparo continua abrindo a consulta." fator={24} sufixo="dias" min={1} max={60} passo={1} />
        </div>
      </section>

      <section className="iac-bloco">
        <p className="section-label">Ordem das ofertas</p>
        <div className="iac-duas">
          {['fgts_escada_ofertas', 'clt_escada_ofertas'].map((k) => param(k) && (
            <div key={k} className="panel" id={`param-${k}`}>
              <b>{k.startsWith('fgts') ? 'FGTS' : 'CLT'}</b>
              <p className="iac-miudo">A primeira é a oferta; as seguintes aparecem quando o cliente pede mais.</p>
              <EditorEscada p={param(k)} salvar={salvar} />
            </div>
          ))}
        </div>
      </section>

      <section className="iac-bloco">
        <p className="section-label">Valores e tempos</p>
        <div className="panel">
          <ParamNumero p={param('fgts_alto_valor')} salvar={salvar} titulo="FGTS: proposta de alto valor"
                       ajuda="Acima disso, os lembretes usam os áudios de alto valor." sufixo="reais" min={0} />
          <ParamNumero p={param('clt_alto_valor')} salvar={salvar} titulo="CLT: proposta de alto valor"
                       ajuda="Acima disso, a conversa ganha a etiqueta ticket_alto." sufixo="reais" min={0} />
          <ParamNumero p={param('clt_espera_parcial_s')} salvar={salvar} titulo="CLT: mostrar a primeira oferta depois de"
                       ajuda="Com uma oferta na mão, a IA mostra depois desse tempo sem esperar os outros bancos." sufixo="segundos" min={10} max={600} />
          <ParamNumero p={param('clt_espera_cliente_s')} salvar={salvar} titulo="CLT: esperar o cliente autorizar por até"
                       ajuda="Banco esperando o termo ou link do cliente segura a decisão por no máximo esse tempo." fator={60} sufixo="min" min={1} max={120} />
          {ind && (
            <Linha titulo="Pedir indicações no fim do atendimento" ajuda="Ligue só com o modelo de indicação aprovado na Meta.">
              <Chave ligado={!!ind.valor} rotulo="Indicações"
                     onChange={(v) => salvar('parametro', { chave: 'indicacoes_ativas', valor: v }, v ? 'Indicações ligadas' : 'Indicações desligadas')} />
            </Linha>
          )}
        </div>
      </section>
    </>
  )
}

// ---------------------------------------------------------------- vendedoras (escalada)
function SecaoEscalada({ d, salvar }) {
  const e = d.escalada || {}
  const [v, setV, mudou, desfazer] = useRascunho({ aviso_min: e.aviso_min ?? 10, acao_min: e.acao_min ?? 20 })
  return (
    <>
      <p className="iac-intro">
        O que acontece quando um cliente escreve para uma vendedora e fica sem resposta. Vale no nosso Chatwoot, no horário
        em que alguém da equipe está online.
      </p>
      <div className="panel iac-bloco">
        <Linha titulo="Acompanhar clientes sem resposta" ajuda={e.ativa ? 'Ligado' : 'Desligado: ninguém é avisado'}>
          <Chave ligado={!!e.ativa} rotulo="Escalada"
                 onChange={(x) => salvar('escalada', { ativa: x }, x ? 'Escalada ligada' : 'Escalada desligada')} />
        </Linha>
      </div>
      <ol className={`iac-trilha ${e.ativa ? '' : 'off'}`}>
        <li><span className="iac-trilha-p">0</span><div><b>Cliente manda mensagem</b><small>e a vendedora não responde</small></div></li>
        <li><span className="iac-trilha-p">1</span><div>
          <b>Depois de <Numero valor={v.aviso_min} min={1} max={240} sufixo="min" largura={60} onChange={(n) => setV({ ...v, aviso_min: n })} />: aviso à vendedora</b>
          <small>Nota na conversa mencionando a vendedora e lembrete na extensão Esquentadinho.</small></div></li>
        <li><span className="iac-trilha-p">2</span><div>
          <b>Depois de <Numero valor={v.acao_min} min={2} max={480} sufixo="min" largura={60} onChange={(n) => setV({ ...v, acao_min: n })} />: ação</b>
          <small>Se a vendedora não fez nada na conversa, a IA assume o atendimento. Se ela já estava atendendo,
            os supervisores ({(e.supervisores || []).map((s) => s.nome).join(', ') || '—'}) são chamados.</small></div></li>
      </ol>
      {Number(v.acao_min) <= Number(v.aviso_min) && <p className="chip-erro">A ação precisa vir depois do aviso.</p>}
      <BotoesRascunho mudou={mudou && Number(v.acao_min) > Number(v.aviso_min)} onDesfazer={desfazer}
                      onSalvar={() => salvar('escalada', { aviso_min: Number(v.aviso_min), acao_min: Number(v.acao_min) }, 'Tempos salvos')} />
    </>
  )
}

// ---------------------------------------------------------------- páginas da LP (/c/<campanha>, migração 160)
// Dono, 01/10: além da LP atual (link que a IA manda, sem mudança), duas páginas novas para campanhas:
// "devolve" (consulta na hora e, aprovado, manda ao disparo) e "prende" (aprovado: botão do WhatsApp; sem clique na
// espera, manda ao disparo). Cada campanha usa uma página e tem o seu link.
const DISPARO_ARARA = 'https://hotnwh.querosacarfgts.com.br/webhook/disparo-arara'
const NOME_MODO = { devolve: 'Devolve ao disparo', prende: 'Prende na página' }
const AJUDA_MODO = {
  devolve: 'Consulta na hora. Aprovou: o cliente vê "em instantes você recebe no WhatsApp" e vai para o disparo.',
  prende: 'Consulta com o cliente na página. Aprovou: botão para falar no WhatsApp; se não tocar na espera, vai para o disparo.',
}
// botão do WhatsApp da página (dono, 02/10): número + mensagem -> link wa.me (o servidor guarda os links)
const waPartes = (link) => {
  const m = String(link || '').match(/wa\.me\/(\d*)(?:\?text=([^&#]*))?/)
  let numero = m ? m[1] : '', texto = ''
  try { texto = m && m[2] ? decodeURIComponent(m[2].replace(/\+/g, ' ')) : '' } catch { texto = m[2] }
  if (/^55\d{10,11}$/.test(numero)) numero = numero.slice(2)
  return { numero, texto }
}
const waLink = ({ numero, texto }) => {
  let d = String(numero || '').replace(/\D/g, '').slice(0, 13)
  if (/^\d{10,11}$/.test(d)) d = '55' + d
  return `https://wa.me/${d}${texto ? `?text=${encodeURIComponent(texto)}` : ''}`
}
const waMascara = (d) => String(d || '').replace(/\D/g, '').slice(0, 11).replace(/^(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d{1,4})$/, '$1-$2')
const waValido = (link) => /^https:\/\/wa\.me\/55\d{10,11}(\?text=.*)?$/.test(String(link || ''))

const paginaVazia = () => ({ nome: '', modo: 'devolve', produto: 'clt', destinos: [], whatsapp: [], espera_s: 120, ativa: true, envio: null })
const VARIAVEIS_ENVIO = [['primeiro_nome', 'Primeiro nome'], ['pedido', 'Pedido ("simulação de crédito do trabalhador")'], ['resultado', 'Resultado ("Valor liberado: R$ 4.500,00")'], ['nome', 'Nome completo'], ['valor', 'Maior valor aprovado'], ['produto', 'Produto']]
// variável = texto livre com marcadores [campo] (migração 172); o formato antigo (só o nome do campo) vira [campo]
const CAMPO_EXEMPLO = { primeiro_nome: 'Maria', nome: 'Maria Souza', valor: 'R$ 4.500,00', produto: 'crédito do trabalhador',
  pedido: 'simulação de crédito do trabalhador', resultado: 'Valor liberado: R$ 4.500,00' }
const textoVar = (v) => (CAMPO_EXEMPLO[v] !== undefined ? `[${v}]` : (v || ''))
const exemploVar = (v) => textoVar(v).replace(/\[(\w+)\]/g, (m, k) => (CAMPO_EXEMPLO[k] !== undefined ? CAMPO_EXEMPLO[k] : m))

// Envio do aprovado (migração 166): template aprovado de uma das nossas BMs, pelo número escolhido
function EscolherEnvio({ envio, onChange, token, api, onRemover, n }) {
  const [bms, setBms] = useState(null)
  const [contas, setContas] = useState({})
  const e = envio || { bm: 'hotline', variaveis: [] }
  const bm = e.bm || 'hotline'
  const chamar = (meta) => api({ acao: 'meta', token, meta })
  useEffect(() => { chamar({ acao: 'bms' }).then((r) => setBms(r.ok ? r.bms : [])) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // lista guardada aparece na hora, mas sempre busca a atual na Meta (02/10: o cache de antes da aprovação escondia os
  // templates aprovados depois: "Nenhum template aprovado")
  const [buscando, setBuscando] = useState(false)
  const buscar = (qual) => {
    setBuscando(true)
    chamar({ acao: 'listar', bm: qual }).then((r) => { if (r.ok) setContas((c) => ({ ...c, [qual]: r.contas || [] })) })
      .finally(() => setBuscando(false))
  }
  useEffect(() => {
    let guardado = null
    try { guardado = JSON.parse(localStorage.getItem('iac_templates_cache') || 'null')?.porBm?.[bm]?.contas } catch { /* sem cache */ }
    if (guardado && !contas[bm]) setContas((c) => ({ ...c, [bm]: guardado }))
    buscar(bm)
  }, [bm]) // eslint-disable-line react-hooks/exhaustive-deps
  const lista = (contas[bm] || []).filter((c) => !c.erro)
  const conta = lista.find((c) => c.id === e.waba)
  // texto com acento quebrado na Meta ("Ol�", lp_simulacao_*_v1 de 02/10) não aparece: o cliente receberia assim
  const aprovados = (conta?.message_templates?.data || []).filter((t) => t.status === 'APPROVED'
    && !(t.components || []).some((c) => String(c.text || '').includes('�')))
  const tpl = aprovados.find((t) => t.name === e.template)
  const corpo = tpl?.components?.find((c) => c.type === 'BODY')?.text || ''
  const nVars = [...new Set((corpo.match(/\{\{(\d+)\}\}/g) || []))].length
  const mudar = (x) => onChange({ ...e, ...x })
  return (
    <div className="tpl-lote-bm" style={{ marginBottom: 8 }}>
      <div className="tpl-lote-topo"><b>Opção {n}</b>{onRemover && <button className="iac-link" onClick={onRemover}>remover</button>}</div>
      <div className="chip-opcoes" style={{ marginBottom: 6 }}>
        <span className="iac-rot">Vale para</span>
        {PRODUTO_ENVIO.map(([k, t]) => (
          <button key={k} type="button" className={`chip-opcao ${(e.produto || 'todos') === k ? 'on' : ''}`} onClick={() => mudar({ produto: k })}>{t}</button>
        ))}
      </div>
      <div className="iac-filtros" style={{ marginBottom: 6 }}>
        <select className="chip-input" value={bm} onChange={(ev) => mudar({ bm: ev.target.value, waba: '', numero_id: '', numero: '', template: '', variaveis: [] })}>
          {(bms || [{ id: 'hotline', nome: 'Hotline Infbip' }]).map((b) => <option key={b.id} value={b.id}>{b.nome}</option>)}
        </select>
        <select className="chip-input" value={e.waba || ''} disabled={!lista.length}
                onChange={(ev) => { const c = lista.find((x) => x.id === ev.target.value); const n = c?.phone_numbers?.data?.[0] || {}
                  mudar({ waba: ev.target.value, numero_id: n.id || '', numero: n.display_phone_number || '', template: '', variaveis: [] }) }}>
          <option value="">{contas[bm] ? 'Escolha o número' : 'Carregando…'}</option>
          {lista.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.phone_numbers?.data?.[0]?.display_phone_number || '—'})</option>)}
        </select>
        <select className="chip-input" value={e.template || ''} disabled={!conta}
                onChange={(ev) => { const t = aprovados.find((x) => x.name === ev.target.value)
                  const n = [...new Set(((t?.components?.find((c) => c.type === 'BODY')?.text || '').match(/\{\{(\d+)\}\}/g) || []))].length
                  mudar({ template: ev.target.value, idioma: t?.language || 'pt_BR', variaveis: (n === 3 ? ['primeiro_nome', 'pedido', 'resultado'] : ['primeiro_nome', 'valor', 'produto', 'nome']).slice(0, n) }) }}>
          <option value="">{conta && !aprovados.length ? (buscando ? 'Buscando na Meta…' : 'Nenhum template aprovado') : 'Escolha o template'}</option>
          {aprovados.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
        </select>
        <button type="button" className="iac-link" disabled={buscando} onClick={() => buscar(bm)}>{buscando ? 'atualizando…' : 'atualizar lista'}</button>
      </div>
      {tpl && <p className="iac-miudo" style={{ margin: '6px 0 2px' }}>Modelo: {corpo}</p>}
      {Array.from({ length: nVars }, (_, i) => {
        const val = textoVar((e.variaveis || [])[i])
        const setVar = (t) => { const v = [...(e.variaveis || [])]; while (v.length < nVars) v.push(''); v[i] = t.replace(/[\r\n\t]+/g, ' ').slice(0, 300); mudar({ variaveis: v }) }
        return (
          <div key={i} style={{ marginBottom: 8 }}>
            <div className="iac-filtros" style={{ margin: 0 }}>
              <span className="iac-rot">{`{{${i + 1}}}`}</span>
              <input className="chip-input" style={{ flex: 1, minWidth: 220 }} value={val} maxLength={300}
                     placeholder="Escreva o texto e insira os campos abaixo" onChange={(ev) => setVar(ev.target.value)} />
            </div>
            <div className="chip-opcoes" style={{ margin: '4px 0 0 36px' }}>
              {VARIAVEIS_ENVIO.map(([k, t]) => (
                <button key={k} type="button" className="chip-opcao" title={t}
                        onClick={() => setVar(`${val}${val && !/\s$/.test(val) ? ' ' : ''}[${k}]`)}>+ {t.split(' (')[0]}</button>
              ))}
            </div>
          </div>
        )
      })}
      {tpl && (
        <p className="tpl-leitura" style={{ margin: '6px 0', whiteSpace: 'pre-wrap' }}>
          {corpo.replace(/\{\{(\d+)\}\}/g, (m, n) => exemploVar((e.variaveis || [])[Number(n) - 1]) || m)}
        </p>
      )}
    </div>
  )
}

// Várias opções de envio (dono, 02/10): cada aprovado recebe uma delas, sorteada (migração 170)
const opcoesDe = (envio) => (envio?.opcoes || (envio?.template ? [envio] : []))
// cada opção vale para um produto (migração 179): o aprovado no CLT recebe uma das de "CLT" ou "qualquer"; no FGTS, idem
const PRODUTO_ENVIO = [['todos', 'Qualquer produto'], ['clt', 'Só CLT'], ['fgts', 'Só FGTS']]
const NOME_PRODUTO_ENVIO = { todos: '', clt: ' (CLT)', fgts: ' (FGTS)' }
function EscolherEnvios({ envio, onChange, token, api }) {
  const ops = opcoesDe(envio).length ? opcoesDe(envio) : [{ bm: 'hotline', variaveis: [] }]
  const mudar = (lista) => onChange({ opcoes: lista })
  const prontas = ops.filter((o) => o.template).length
  const cobre = (p) => ops.some((o) => o.template && ['todos', p].includes(o.produto || 'todos'))
  const faltam = prontas ? ['clt', 'fgts'].filter((p) => !cobre(p)) : []
  return (
    <div>
      <b>Envio do aprovado</b>
      <p className="iac-miudo">Template do WhatsApp aprovado em uma das nossas BMs. Com mais de uma opção, cada aprovado recebe uma delas, sorteada.</p>
      {ops.map((o, i) => (
        <EscolherEnvio key={i} n={i + 1} envio={o} token={token} api={api}
                       onChange={(v) => mudar(ops.map((x, j) => (j === i ? v : x)))}
                       onRemover={ops.length > 1 ? () => mudar(ops.filter((_, j) => j !== i)) : null} />
      ))}
      <button className="iac-link" onClick={() => mudar([...ops, { bm: ops[ops.length - 1]?.bm || 'hotline', variaveis: [] }])}>+ outra opção</button>
      {!prontas && <p className="chip-erro">Sem template escolhido, o aprovado fica esperando (até 3 dias) e só recebe quando o envio for configurado.</p>}
      {faltam.map((p) => <p key={p} className="chip-erro">Nenhuma opção vale para o {p.toUpperCase()}: quem for aprovado no {p.toUpperCase()} não recebe template.</p>)}
    </div>
  )
}

function EditorPagina({ inicial, salvar, onFechar, token, api, bancos = [] }) {
  const [p, setP] = useState(() => ({ ...paginaVazia(), bancos: [], tempo_max_s: null, ...inicial }))
  // bancos do CLT que a página consulta (migração 187): vazio = todos os ligados no Painel > Bancos
  const bancosClt = bancos.filter((b) => b.produto === 'clt').sort((a, b) => (a.ordem || 0) - (b.ordem || 0))
  const marcados = p.bancos || []
  const todos = !marcados.length
  const alternaBanco = (b) => {
    const base = todos ? bancosClt.map((x) => x.banco) : marcados
    const novo = base.includes(b) ? base.filter((x) => x !== b) : [...base, b]
    set('bancos', novo.length === bancosClt.length ? [] : novo)
  }
  const [salvando, setSalvando] = useState(false)
  const set = (k, v) => setP((x) => ({ ...x, [k]: v }))
  const setDestino = (i, k, v) => set('destinos', p.destinos.map((x, j) => (j === i ? { ...x, [k]: v } : x)))
  async function ok() {
    setSalvando(true)
    const dados = { ...p, nome: p.nome.trim(), espera_s: Number(p.espera_s) || 120, destinos: [],
      envio: (() => {
        const ops = opcoesDe(p.envio).filter((o) => o.template && o.numero_id).map((o) => ({ bm: o.bm, waba: o.waba, numero_id: o.numero_id,
          numero: o.numero, template: o.template, idioma: o.idioma || 'pt_BR', variaveis: o.variaveis || [], produto: o.produto || 'todos' }))
        return ops.length ? { opcoes: ops } : null
      })(),
      whatsapp: p.whatsapp.map((x) => x.trim()).filter(waValido) }
    for (const k of ['criado_em', 'atualizado_em']) delete dados[k]
    const r = await salvar('lp_pagina', dados, inicial?.id ? 'Página salva' : 'Página criada')
    setSalvando(false)
    if (r) onFechar()
  }
  return (
    <div className="panel iac-texto-ed" style={{ marginTop: 0 }}>
      <Linha titulo="Nome da página" ajuda="Só para vocês (ex.: Leilão Arara - devolve).">
        <input className="chip-input" value={p.nome} onChange={(e) => set('nome', e.target.value)} placeholder="Nome" />
      </Linha>
      <Linha titulo="Como funciona" ajuda={AJUDA_MODO[p.modo]}>
        <div className="chip-opcoes">
          {Object.entries(NOME_MODO).map(([k, t]) => (
            <button key={k} className={`chip-opcao ${p.modo === k ? 'on' : ''}`} onClick={() => set('modo', k)}>{t}</button>
          ))}
        </div>
      </Linha>
      <Linha titulo="Produto" ajuda="CLT reprovado oferece o FGTS na própria página.">
        <div className="chip-opcoes">
          {[['clt', 'CLT'], ['fgts', 'FGTS']].map(([k, t]) => (
            <button key={k} className={`chip-opcao ${p.produto === k ? 'on' : ''}`} onClick={() => set('produto', k)}>{t}</button>
          ))}
        </div>
      </Linha>
      <Linha titulo="Bancos consultados (CLT)" ajuda="Toque para tirar ou colocar um banco só nesta página. Todos marcados = os bancos ligados no Painel > Bancos (onde também ficam pausa, espera e tentativas).">
        <div className="chip-opcoes">
          {bancosClt.map((b) => {
            const on = todos || marcados.includes(b.banco)
            return (
              <button key={b.banco} type="button" className={`chip-opcao ${on ? 'on' : ''}`} onClick={() => alternaBanco(b.banco)}
                      title={b.ativo ? '' : 'Desligado no Painel > Bancos: não consulta mesmo marcado'}>
                {nomeBanco(b.banco)}{b.ativo ? '' : ' (desligado)'}
              </button>
            )
          })}
          {!todos && <button type="button" className="iac-link" onClick={() => set('bancos', [])}>marcar todos</button>}
        </div>
      </Linha>
      <Linha titulo="Corte da consulta" ajuda="Os bancos rodam juntos, o primeiro valor já segue e, depois de 1 minuto, a tela avisa que o cliente pode sair (a resposta vai pelo WhatsApp). Sem limite: o servidor espera a resposta de todos os bancos. Com um tempo: passou dele, fecha com o que tiver e os bancos que não responderam ficam de fora.">
        <div className="chip-opcoes">
          {[[null, 'Sem limite (padrão)'], [120, '2 min'], [180, '3 min'], [300, '5 min'], [600, '10 min']].map(([v, t]) => (
            <button key={t} type="button" className={`chip-opcao ${(p.tempo_max_s || null) === v ? 'on' : ''}`} onClick={() => set('tempo_max_s', v)}>{t}</button>
          ))}
        </div>
      </Linha>
      <EscolherEnvios envio={p.envio} onChange={(v) => set('envio', v)} token={token} api={api} />
      <>
          <div>
            <b>WhatsApp do botão</b>
            <p className="iac-miudo">Botão verde que aparece quando o cliente é aprovado (quem toca não recebe o template). Escolha o
              número e a mensagem que já vem escrita; o painel monta o link. Com mais de um, cada cliente cai num deles, sorteado.</p>
            {p.whatsapp.map((x, i) => {
              const w = waPartes(x)
              const mudar = (k, v) => set('whatsapp', p.whatsapp.map((y, j) => (j === i ? waLink({ ...waPartes(y), [k]: v }) : y)))
              return (
                <div key={i} className="iac-filtros" style={{ marginBottom: 6, alignItems: 'center' }}>
                  <input className="chip-input" style={{ width: 170 }} value={waMascara(w.numero)} placeholder="(17) 98182-5570"
                         inputMode="tel" onChange={(e) => mudar('numero', e.target.value)} />
                  <input className="chip-input" style={{ flex: 1, minWidth: 200 }} value={w.texto} maxLength={300}
                         placeholder="Mensagem que já vem escrita (opcional)" onChange={(e) => mudar('texto', e.target.value)} />
                  <button className="iac-link" onClick={() => set('whatsapp', p.whatsapp.filter((_, j) => j !== i))}>remover</button>
                  {x && <a className="iac-miudo" href={x} target="_blank" rel="noreferrer" style={{ flexBasis: '100%', margin: 0 }}>{x}</a>}
                </div>
              )
            })}
            <button className="iac-link" onClick={() => set('whatsapp', [...p.whatsapp,
              waLink({ numero: '', texto: p.whatsapp.length ? waPartes(p.whatsapp[p.whatsapp.length - 1]).texto : '' })])}>+ número</button>
          </div>
          {p.modo === 'prende' && (
          <Linha titulo="Esperar o clique por" ajuda="Sem tocar no botão nesse tempo, o cliente recebe o template.">
            <Numero valor={Math.round(p.espera_s / 60 * 10) / 10} min={0.5} max={60} passo={0.5} sufixo="min"
                    onChange={(n) => set('espera_s', Math.round(Number(n) * 60))} />
          </Linha>
          )}
      </>
      {inicial?.id && (
        <Linha titulo="Página ativa" ajuda="Desligada, os links das campanhas dela não abrem a consulta.">
          <Chave ligado={!!p.ativa} rotulo="Página ativa" onChange={(v) => set('ativa', v)} />
        </Linha>
      )}
      <span className="iac-rascunho">
        <button className="chip-salvar iac-btn-p" onClick={ok} disabled={salvando || !p.nome.trim()}>{salvando ? 'Salvando…' : 'Salvar página'}</button>
        <button className="reset-btn" onClick={onFechar} disabled={salvando}>Cancelar</button>
      </span>
    </div>
  )
}

function EditorCampanha({ inicial, paginas, salvar, onFechar }) {
  const [c, setC] = useState(() => ({ slug: '', nome: '', pagina_id: paginas[0]?.id || '', campaign_id: '', produto: '', ativa: true, ...inicial }))
  const [salvando, setSalvando] = useState(false)
  const set = (k, v) => setC((x) => ({ ...x, [k]: v }))
  const novo = !inicial?.slug
  async function ok() {
    setSalvando(true)
    const r = await salvar('lp_campanha', { slug: c.slug, nome: c.nome, pagina_id: Number(c.pagina_id), campaign_id: c.campaign_id || '',
      produto: c.produto || '', ativa: !!c.ativa }, novo ? 'Campanha criada' : 'Campanha salva')
    setSalvando(false)
    if (r) onFechar()
  }
  return (
    <div className="panel iac-texto-ed" style={{ marginTop: 0 }}>
      <Linha titulo="Nome" ajuda="Só para vocês.">
        <input className="chip-input" value={c.nome} onChange={(e) => set('nome', e.target.value)} placeholder="Leilão Arara 01/10" />
      </Linha>
      <Linha titulo="Código no link" ajuda="Letras minúsculas, números e hífen. Não muda depois de criada.">
        <input className="chip-input" value={c.slug} disabled={!novo} placeholder="leilao-arara-01-10"
               onChange={(e) => set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} />
      </Linha>
      <Linha titulo="Página" ajuda={AJUDA_MODO[paginas.find((p) => p.id === Number(c.pagina_id))?.modo] || ''}>
        <select className="chip-input" value={c.pagina_id} onChange={(e) => set('pagina_id', e.target.value)}>
          {paginas.map((p) => <option key={p.id} value={p.id}>{p.nome} ({NOME_MODO[p.modo]})</option>)}
        </select>
      </Linha>
      <Linha titulo="Produto" ajuda="Vazio: o da página.">
        <div className="chip-opcoes">
          {[['', 'O da página'], ['clt', 'CLT'], ['fgts', 'FGTS']].map(([k, t]) => (
            <button key={k} className={`chip-opcao ${(c.produto || '') === k ? 'on' : ''}`} onClick={() => set('produto', k)}>{t}</button>
          ))}
        </div>
      </Linha>
      <Linha titulo="campaign_id no disparo" ajuda="Vazio: vai o código do link.">
        <input className="chip-input" value={c.campaign_id || ''} onChange={(e) => set('campaign_id', e.target.value)} placeholder={c.slug || 'campaign_id'} />
      </Linha>
      {!novo && (
        <Linha titulo="Campanha ativa" ajuda="Desligada, o link mostra que a campanha terminou.">
          <Chave ligado={!!c.ativa} rotulo="Campanha ativa" onChange={(v) => set('ativa', v)} />
        </Linha>
      )}
      <span className="iac-rascunho">
        <button className="chip-salvar iac-btn-p" onClick={ok} disabled={salvando || c.slug.length < 2 || !c.pagina_id}>{salvando ? 'Salvando…' : 'Salvar campanha'}</button>
        <button className="reset-btn" onClick={onFechar} disabled={salvando}>Cancelar</button>
      </span>
    </div>
  )
}

function SecaoPaginas({ d, salvar, token, api }) {
  const lp = d.lp || { paginas: [], campanhas: [] }
  const [ed, setEd] = useState(null)   // { tipo: 'pagina'|'campanha', v }
  const [copiado, setCopiado] = useState('')
  const linkDe = (slug) => `${lp.base || ''}${slug}`
  const copiar = async (t, k) => {
    try { await navigator.clipboard.writeText(t); setCopiado(k); setTimeout(() => setCopiado(''), 1800) } catch { /* sem área de transferência */ }
  }
  const pagina = (id) => lp.paginas.find((p) => p.id === id)
  return (
    <>
      <p className="iac-intro">
        Páginas para campanhas. A LP atual (o link que a IA manda na conversa) continua igual; aqui ficam as duas novas,
        cada campanha com o seu link. No template da Arara use o link da campanha: a Arara acrescenta <code>?ref=</code> com
        o id da mensagem e a página abre a consulta do cliente; sem isso, ela pede CPF e celular.
      </p>

      <section className="iac-bloco">
        <p className="section-label">Páginas</p>
        {ed?.tipo === 'pagina'
          ? <EditorPagina inicial={ed.v} salvar={salvar} onFechar={() => setEd(null)} token={token} api={api} bancos={d.bancos || []} />
          : (
            <div className="iac-bancos">
              {lp.paginas.map((p) => (
                <div key={p.id} className="iac-banco" style={{ borderLeftColor: p.ativa ? 'var(--lime)' : 'var(--muted)' }}>
                  <div className="iac-banco-topo"><b>{p.nome}</b><span className="iac-tag">{p.ativa ? nomeProduto(p.produto) : 'desligada'}</span></div>
                  <small className="iac-miudo" style={{ margin: 0 }}>{NOME_MODO[p.modo]}{p.modo === 'prende' ? ` · espera ${Math.round(p.espera_s / 6) / 10} min · ${(p.whatsapp || []).length} WhatsApp` : ''}</small>
                  <small className="iac-miudo" style={{ margin: 0 }}>Aprovado recebe: {opcoesDe(p.envio).length ? opcoesDe(p.envio).map((o) => `${o.template}${NOME_PRODUTO_ENVIO[o.produto || 'todos']} · ${o.numero || ''}`).join(' | ') : 'nada ainda (escolha o template)'}</small>
                  <div className="iac-banco-acoes"><button className="iac-link" onClick={() => setEd({ tipo: 'pagina', v: p })}>Editar</button></div>
                </div>
              ))}
              <button className="iac-banco iac-kpi" onClick={() => setEd({ tipo: 'pagina', v: null })} style={{ alignItems: 'center', justifyContent: 'center' }}>
                <b>+ Nova página</b><small className="iac-miudo" style={{ margin: 0 }}>Devolve ao disparo ou prende na página</small>
              </button>
            </div>
          )}
      </section>

      <section className="iac-bloco">
        <p className="section-label">Campanhas e links</p>
        {ed?.tipo === 'campanha'
          ? <EditorCampanha inicial={ed.v} paginas={lp.paginas} salvar={salvar} onFechar={() => setEd(null)} />
          : (
            <div className="panel">
              {!lp.paginas.length && <p className="iac-miudo" style={{ marginTop: 0 }}>Crie uma página primeiro.</p>}
              {lp.campanhas.map((c) => (
                <div key={c.slug} className="iac-linha">
                  <div className="iac-linha-txt">
                    <b>{c.nome} {!c.ativa && <span className="iac-tag">desligada</span>}</b>
                    <small>{pagina(c.pagina_id)?.nome || '—'} · {nomeProduto(c.produto || pagina(c.pagina_id)?.produto)} · campaign_id {c.campaign_id || c.slug}</small>
                    <small>{c.ids} links · {c.abertos} abriram · {c.aprovados} aprovados · {c.cliques} tocaram no WhatsApp · {c.entregues} enviados ao disparo</small>
                    <small style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{linkDe(c.slug)}</small>
                  </div>
                  <div className="iac-linha-ctl" style={{ gap: 10 }}>
                    <button className="chip-salvar iac-btn-p" onClick={() => copiar(linkDe(c.slug), c.slug)}>{copiado === c.slug ? 'Copiado ✓' : 'Copiar link'}</button>
                    <button className="iac-link" onClick={() => setEd({ tipo: 'campanha', v: c })}>Editar</button>
                  </div>
                </div>
              ))}
              {lp.paginas.length > 0 && (
                <button className="iac-link" style={{ marginTop: 10 }} onClick={() => setEd({ tipo: 'campanha', v: null })}>+ Nova campanha</button>
              )}
            </div>
          )}
      </section>
    </>
  )
}

// ---------------------------------------------------------------- histórico
const NOME_PARAM = {
  lembrete_silencio: 'horário de silêncio', reativacao: 'retomada de conversas', flow_ativo: 'WhatsApp Flow',
  indicacoes_ativas: 'indicações', fgts_variantes: 'jornada do FGTS', clt_variantes: 'jornada do CLT',
  fgts_escada_ofertas: 'ordem das ofertas do FGTS', clt_escada_ofertas: 'ordem das ofertas do CLT',
  fgts_alto_valor: 'alto valor do FGTS', clt_alto_valor: 'alto valor do CLT', jornada_lead_horas: 'validade do link',
  clt_espera_parcial_s: 'espera da primeira oferta do CLT', clt_espera_cliente_s: 'espera da autorização do CLT',
}
function fraseHistorico(h, d) {
  const a = h.antes || {}, z = h.depois || {}
  if (h.tipo === 'banco' && h.chave === 'despausar') return `religou ${plural(z.bancos || 1, 'banco', 'bancos')} no fim da pausa`
  if (h.tipo === 'banco') {
    const [p, b] = String(h.chave || '').split('/')
    const nome = `${nomeBanco(b)} (${nomeProduto(p)})`
    if (z.pausado_ate && !a.pausado_ate) return `pausou ${nome} até ${hora(z.pausado_ate)}${z.pausa_motivo ? ` — ${z.pausa_motivo}` : ''}`
    if (a.ativo !== z.ativo) return `${z.ativo ? 'ligou' : 'desligou'} ${nome}`
    const m = []
    if (a.ordem !== z.ordem) m.push(`ordem ${a.ordem} → ${z.ordem}`)
    if (a.timeout_segundos !== z.timeout_segundos) m.push(`espera ${a.timeout_segundos}s → ${z.timeout_segundos}s`)
    if (a.max_tentativas !== z.max_tentativas) m.push(`tentativas ${a.max_tentativas} → ${z.max_tentativas}`)
    return `ajustou ${nome}${m.length ? `: ${m.join(', ')}` : ''}`
  }
  if (h.tipo === 'mensagem') {
    const t = `“${tituloTexto(h.chave || '')}”${a.produto ? ` (${nomeProduto(a.produto)})` : ''}`
    if (a.ativo !== z.ativo) return `${z.ativo ? 'voltou a usar' : 'desligou'} o texto ${t}`
    if (a.redigir !== z.redigir) return `${z.redigir ? 'deixou a IA adaptar' : 'fixou as palavras de'} ${t}`
    return `editou o texto ${t}`
  }
  if (h.tipo === 'parametro') {
    const nome = NOME_PARAM[h.chave] || h.chave
    return typeof z === 'boolean' ? `${z ? 'ligou' : 'desligou'} ${nome}` : `mudou ${nome}`
  }
  if (h.tipo === 'escalada') {
    if (a.ativa !== z.ativa) return `${z.ativa ? 'ligou' : 'desligou'} o acompanhamento de clientes sem resposta`
    return `mudou os tempos da escalada: aviso ${a.aviso_min} → ${z.aviso_min} min, ação ${a.acao_min} → ${z.acao_min} min`
  }
  if (h.tipo === 'followup') {
    const t = `${z.ordem || a.ordem}º lembrete de ${NOME_ETAPA[z.fase || a.fase] || z.fase} (${nomeProduto(z.produto || a.produto)})`
    if (a.ativo !== z.ativo) return `${z.ativo ? 'ligou' : 'desligou'} o ${t}`
    return `mudou o ${t}: ${duracao(a.apos_minutos)} → ${duracao(z.apos_minutos)}`
  }
  if (h.tipo === 'produto') {
    const nome = z.nome || h.chave
    if (a.ativo !== z.ativo) return `${z.ativo ? 'ligou' : 'desligou'} o produto ${nome}`
    return `mudou as rodadas de negociação de ${nome}: ${a.teto_rodadas_negociacao} → ${z.teto_rodadas_negociacao}`
  }
  return `${h.tipo} ${h.chave || ''}`
}
function SecaoHistorico({ d }) {
  return (
    <>
      <p className="iac-intro">As últimas 50 mudanças feitas aqui (e as religações automáticas de bancos pausados).</p>
      <div className="panel">
        <ul className="iac-hist">
          {d.historico.map((h) => (
            <li key={h.id}>
              <span className="iac-hist-q">{quando(h.em)}</span>
              <span><b>{h.usuario}</b> {fraseHistorico(h, d)}</span>
            </li>
          ))}
          {!d.historico.length && <li className="home-vazio">Nenhuma mudança ainda.</li>}
        </ul>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- resumo
function SecaoResumo({ d, salvar, irPara, dialogo }) {
  const ligados = d.bancos.filter((b) => b.ativo)
  const bons = ligados.filter((b) => ['bom', 'sem_uso'].includes(b.uso_24h?.saude))
  const avisos = []
  for (const b of d.bancos) {
    const u = b.uso_24h || {}, nome = `${nomeBanco(b.banco)} (${nomeProduto(b.produto)})`
    if (!b.ativo && b.pausado_ate) avisos.push({ nivel: 'pausa', texto: `${nome} está pausado até ${hora(b.pausado_ate)}.`, acao: ['Religar agora', () => salvar('banco', { produto: b.produto, banco: b.banco, ativo: true }, `${nomeBanco(b.banco)} religado`)] })
    else if (b.ativo && ['ruim', 'atencao'].includes(u.saude)) {
      const m = (u.motivos || []).find((x) => x.classe === 'banco')
      avisos.push({
        nivel: u.saude, texto: `${nome}: ${plural(u.falhas, 'falha', 'falhas')} do banco em ${u.chamadas} consultas${m ? ` (principal: ${m.motivo})` : ''}.`,
        acao: ['Pausar 1 h', async () => {
          if (await dialogo.confirmar({ titulo: `Pausar ${nomeBanco(b.banco)} por 1 hora?`, texto: 'Ele religa sozinho depois.', rotuloOk: 'Pausar' }))
            salvar('banco', { produto: b.produto, banco: b.banco, pausar_horas: 1, motivo: m?.motivo || 'falhas' }, `${nomeBanco(b.banco)} pausado por 1 h`)
        }],
      })
    }
    if (b.ativo && u.integracao > 0) {
      const m = (u.motivos || []).filter((x) => x.classe === 'integracao').map((x) => x.motivo).join(', ')
      avisos.push({ nivel: 'int', texto: `${nome}: ${plural(u.integracao, 'consulta parou', 'consultas pararam')} por algo que precisamos ajustar (${m}). Vale avisar o suporte técnico.` })
    }
  }
  for (const p of d.produtos.filter((x) => x.ativo)) {
    if (!d.bancos.some((b) => b.produto === p.codigo && b.ativo)) avisos.unshift({ nivel: 'ruim', texto: `${p.nome}: nenhum banco ligado. A IA não consegue consultar esse produto.` })
  }
  const e = d.escalada || {}
  const cards = [
    { t: 'Bancos', v: `${bons.length} de ${ligados.length}`, s: 'funcionando bem', ir: 'bancos', c: bons.length === ligados.length ? 'ok' : 'aviso' },
    { t: 'Produtos', v: d.produtos.filter((p) => p.ativo).map((p) => nomeProduto(p.codigo)).join(' + ') || '—', s: 'a IA atende', ir: 'ofertas' },
    { t: 'Lembretes', v: `${d.followups.filter((f) => f.ativo).length}`, s: 'lembretes ligados', ir: 'lembretes' },
    { t: 'Clientes sem resposta', v: e.ativa ? `${e.aviso_min}/${e.acao_min} min` : 'desligado', s: e.ativa ? 'aviso / ação' : 'ninguém é avisado', ir: 'escalada' },
  ]
  return (
    <>
      <div className="kpi-grid iac-kpis">
        {cards.map((c) => (
          <button key={c.t} className={`kpi iac-kpi ${c.c || ''}`} onClick={() => irPara(c.ir)}>
            <p className="kpi-label">{c.t}</p><p className="kpi-value">{c.v}</p><small>{c.s}</small>
          </button>
        ))}
      </div>
      <section className="iac-bloco">
        <p className="section-label">Pede atenção agora</p>
        <div className="panel">
          {avisos.length ? (
            <ul className="iac-avisos">
              {avisos.map((a, i) => (
                <li key={i} className={`n-${a.nivel}`}>
                  <span className="iac-dot" /><span>{a.texto}</span>
                  {a.acao && <button className="chip-opcao" onClick={a.acao[1]}>{a.acao[0]}</button>}
                </li>
              ))}
            </ul>
          ) : <p className="iac-tudo-ok">Tudo certo: todos os bancos ligados estão funcionando.</p>}
        </div>
      </section>
      <section className="iac-bloco">
        <p className="section-label">O que dá para fazer aqui</p>
        <div className="iac-atalhos">
          {[
            ['analises', 'Ver como a IA está convertendo', 'funil, onde os clientes param, bancos, tempos e custo'],
            ['bancos', 'Pausar ou desligar um banco', 'quando um banco está falhando'],
            ['mensagens', 'Mudar o que a IA escreve', 'saudação, pedido de CPF, proposta…'],
            ['lembretes', 'Ajustar os lembretes', 'quando e quantas vezes cobrar o cliente'],
            ['ofertas', 'Ofertas e jornada', 'produtos, ordem das ofertas, página ou chat'],
            ['escalada', 'Clientes sem resposta', 'avisos para vendedoras e supervisores'],
            ['historico', 'Ver o que mudou', 'quem mudou o quê e quando'],
          ].map(([k, t, s]) => (
            <button key={k} className="iac-atalho" onClick={() => irPara(k)}><b>{t}</b><small>{s}</small></button>
          ))}
        </div>
      </section>
      {d.historico.length > 0 && (
        <section className="iac-bloco">
          <p className="section-label">Últimas mudanças</p>
          <div className="panel">
            <ul className="iac-hist">
              {d.historico.slice(0, 5).map((h) => (
                <li key={h.id}><span className="iac-hist-q">{quando(h.em)}</span><span><b>{h.usuario}</b> {fraseHistorico(h, d)}</span></li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </>
  )
}

// ---------------------------------------------------------------- busca geral
function indiceBusca(d) {
  const r = []
  for (const b of d.bancos) r.push({ secao: 'bancos', t: `${nomeBanco(b.banco)} (${nomeProduto(b.produto)})`, s: `Banco · ${estadoBanco(b).txt}`, alvo: `banco-${b.produto}-${b.banco}`, k: 'banco pausar desligar ligar' })
  for (const m of d.mensagens) r.push({ secao: 'mensagens', t: tituloTexto(m.codigo), s: `Texto · ${m.produto ? nomeProduto(m.produto) : 'todos'} · ${NOME_ETAPA[etapaDo(m)] || ''}`, filtro: { busca: m.codigo, abrir: m.id }, k: `${m.codigo} ${quandoTexto(m.codigo)} ${m.conteudo}` })
  for (const [k, t] of Object.entries(NOME_PARAM)) r.push({ secao: ['lembrete_silencio', 'reativacao'].includes(k) ? 'lembretes' : 'ofertas', t: t.replace(/^./, (x) => x.toUpperCase()), s: 'Ajuste', alvo: `param-${k}`, k })
  r.push({ secao: 'lembretes', t: 'Tempo dos lembretes', s: 'Lembretes', k: 'followup cobrar sumiu parou de responder' })
  r.push({ secao: 'escalada', t: 'Clientes sem resposta', s: 'Escalada', k: 'vendedora supervisor aviso escalada demora' })
  r.push({ secao: 'ofertas', t: 'Rodadas de negociação', s: 'Produtos', k: 'negociar produto fgts clt teto' })
  r.push({ secao: 'historico', t: 'Histórico de mudanças', s: 'Histórico', k: 'quem mudou alteração log' })
  r.push({ secao: 'paginas', t: 'Páginas da LP e links de campanha', s: 'Campanhas', k: 'lp pagina link campanha disparo devolve prende whatsapp arara' })
  r.push({ secao: 'templates', t: 'Templates do WhatsApp (Meta)', s: 'Campanhas', k: 'template modelo meta whatsapp criar sugestao conversao disparo aprovado' })
  return r
}

// ---------------------------------------------------------------- tela
// Menu lateral do Painel (dono, 01/10: tudo da IA num lugar só, com abas na lateral)
const IC = {
  resumo: 'M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 7h6V4h-6z',
  analises: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  bancos: 'M3 10l9-6 9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18',
  mensagens: 'M4 5h16v11H8l-4 4z',
  lembretes: 'M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zM18 16V11a6 6 0 1 0-12 0v5l-2 2h16z',
  ofertas: 'M20 12l-8 8-9-9V3h8zM7.5 7.5h.01',
  escalada: 'M16 11a4 4 0 1 0-8 0M3 21a9 9 0 0 1 18 0M19 4v4M21 6h-4',
  historico: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3',
  paginas: 'M4 4h16v16H4zM4 9h16M9 9v11',
  templates: 'M4 5h16v11H8l-4 4zM8 9h8M8 12h5',
}
const GRUPOS = [
  ['Visão geral', [['resumo', 'Resumo'], ['analises', 'Análises']]],
  ['Ajustes da IA', [['bancos', 'Bancos'], ['mensagens', 'Mensagens'], ['lembretes', 'Lembretes'],
                     ['ofertas', 'Ofertas e jornada'], ['escalada', 'Clientes sem resposta']]],
  ['Campanhas', [['templates', 'Templates WhatsApp'], ['paginas', 'Páginas da LP']]],
  ['Registro', [['historico', 'Histórico']]],
]
const Icone = ({ k }) => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={IC[k]} /></svg>
)

function Entrar({ onToken }) {
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState('')
  const [ind, setInd] = useState(false)
  async function ir() {
    setInd(true); setErro('')
    const r = await api({ acao: 'entrar', senha })
    setInd(false)
    if (r.ok) { gravarToken(r.token); onToken(r.token) } else setErro('Senha não aceita. Use a senha da gestão.')
  }
  return (
    <div className="panel iac-entrar">
      <b>Confirme a senha da gestão</b>
      <p className="iac-miudo">Só na primeira vez neste navegador: a configuração muda o atendimento de todos os clientes.</p>
      <input type="password" className="chip-input" value={senha} autoFocus onChange={(e) => setSenha(e.target.value)}
             onKeyDown={(e) => e.key === 'Enter' && senha && ir()} placeholder="Senha" />
      {erro && <p className="chip-erro">{erro}</p>}
      <button className="chip-salvar" disabled={!senha || ind} onClick={ir}>{ind ? 'Entrando…' : 'Entrar'}</button>
    </div>
  )
}

export default function IAConfiguracao({ onVoltar }) {
  const dialogo = useDialogo()
  const [token, setToken] = useState(lerToken)
  const [d, setD] = useState(null)
  const [erro, setErro] = useState('')
  const [carregando, setCarregando] = useState(false)
  const [secao, setSecao] = useState(() => {
    try {
      const s = sessionStorage.getItem('iac_secao')
      return GRUPOS.some(([, l]) => l.some(([k]) => k === s)) ? s : 'resumo'
    } catch { return 'resumo' }
  })
  const [filtroMsg, setFiltroMsg] = useState(null)
  const [busca, setBusca] = useState('')
  const [aviso, setAviso] = useState(null)

  const carregar = useCallback(async () => {
    if (!token) return
    setCarregando(true); setErro('')
    const r = await api({ acao: 'ler', token })
    setCarregando(false)
    if (r.ok) setD(r)
    else if (r.motivo === 'sessao') { gravarToken(null); setToken(null) }
    else setErro('Não foi possível carregar agora. Tente Atualizar.')
  }, [token])
  useEffect(() => { carregar() }, [carregar])

  const avisoTimer = useRef(null)
  const mostrar = (texto, tipo = 'ok') => {
    setAviso({ texto, tipo }); clearTimeout(avisoTimer.current)
    avisoTimer.current = setTimeout(() => setAviso(null), 2600)
  }
  const salvar = useCallback(async (tipo, dados, msgOk) => {
    const r = await api({ acao: 'salvar', token, tipo, dados })
    if (r.ok) { mostrar(msgOk || 'Salvo'); await carregar(); return true }
    if (r.motivo === 'sessao') { gravarToken(null); setToken(null); return false }
    mostrar(r.motivo && r.motivo.length > 12 ? r.motivo : 'Não foi possível salvar.', 'erro')
    return false
  }, [token, carregar]) // eslint-disable-line react-hooks/exhaustive-deps

  const irPara = (s, filtro, alvo) => {
    setSecao(s); setBusca('')
    try { sessionStorage.setItem('iac_secao', s) } catch { /* ignora */ }
    if (s === 'mensagens') setFiltroMsg(filtro ? { ...filtro, n: Date.now() } : null)
    setTimeout(() => {
      const el = alvo && document.getElementById(alvo)
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('iac-piscar'); setTimeout(() => el.classList.remove('iac-piscar'), 1600) }
      else window.scrollTo({ top: 0, behavior: 'smooth' })
    }, 60)
  }
  const param = useCallback((k) => d?.parametros.find((p) => p.chave === k), [d])

  const resultados = useMemo(() => {
    if (!d || busca.trim().length < 2) return []
    const n = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    // palavras que nao ajudam a achar nada ("mudar o texto do CPF" -> "cpf")
    const VAZIAS = new Set(['o', 'a', 'os', 'as', 'do', 'da', 'dos', 'das', 'de', 'e', 'no', 'na', 'em', 'um', 'uma', 'para', 'pra',
      'com', 'que', 'quero', 'mudar', 'alterar', 'trocar', 'editar', 'ajustar', 'texto', 'textos', 'mensagem', 'mensagens'])
    const todos = n(busca).split(/\s+/).filter(Boolean)
    const termos = todos.filter((t) => !VAZIAS.has(t)).length ? todos.filter((t) => !VAZIAS.has(t)) : todos
    return indiceBusca(d)
      .map((x) => {
        const tit = n(x.t), resto = n(`${x.s} ${x.k}`)
        if (!termos.every((t) => tit.includes(t) || resto.includes(t))) return null
        // ajustes e bancos vem antes dos textos avulsos, que sao muitos
        return { ...x, pontos: termos.reduce((s, t) => s + (tit.includes(t) ? 3 : 0) + (n(x.s).includes(t) ? 1 : 0), 0) + (x.secao === 'mensagens' ? 0 : 1) }
      })
      .filter(Boolean).sort((a, b) => b.pontos - a.pontos).slice(0, 12)
  }, [d, busca])

  const ajustes = secao !== 'analises'
  return (
    <>
      <div className="topbar">
        <h1><span className="pulse" /> Painel <span className="iac-titulo-sub">IA de atendimento</span></h1>
        <div className="topbar-right">
          {d && ajustes && <span className="status-line">{carregando ? 'atualizando…' : `${d.usuario} · atualizado`}</span>}
          {onVoltar && <button className="reset-btn" onClick={onVoltar}>&#8592; Início</button>}
          {token && ajustes && <button className="refresh-btn" onClick={carregar} disabled={carregando}>&#8635; Atualizar</button>}
        </div>
      </div>

      <div className="iac-layout">
        <aside className="iac-lateral" aria-label="Seções do painel">
          {GRUPOS.map(([g, itens]) => (
            <div key={g} className="iac-grupo">
              <p>{g}</p>
              {itens.map(([k, t]) => (
                <button key={k} className={`iac-item ${secao === k ? 'on' : ''}`} onClick={() => irPara(k)}
                        aria-current={secao === k ? 'page' : undefined}>
                  <Icone k={k} /><span>{t}</span>
                </button>
              ))}
            </div>
          ))}
        </aside>

        <div className="iac-principal">
      {!ajustes && <IAAnalises embutido />}
      {ajustes && !token && <Entrar onToken={setToken} />}
      {ajustes && token && erro && <div className="state-msg error">{erro}</div>}
      {ajustes && token && !d && !erro && <div className="state-msg">Carregando a configuração…</div>}

      {ajustes && token && d && (
        <>
          <div className="iac-topo">
            <input className="chip-input iac-busca" value={busca} onChange={(e) => setBusca(e.target.value)}
                   placeholder="O que você quer ajustar? Ex.: pausar Facta, texto do CPF, lembrete, alto valor" />
            {resultados.length > 0 && (
              <div className="iac-resultados">
                {resultados.map((x, i) => (
                  <button key={i} onClick={() => irPara(x.secao, x.filtro, x.alvo)}>
                    <b>{x.t}</b><small>{x.s}</small>
                  </button>
                ))}
              </div>
            )}
            {busca.trim().length >= 2 && !resultados.length && <div className="iac-resultados"><p className="iac-miudo">Nada encontrado com “{busca}”.</p></div>}
          </div>
          <div className="iac-corpo">
            {secao === 'resumo' && <SecaoResumo d={d} salvar={salvar} irPara={irPara} dialogo={dialogo} />}
            {secao === 'bancos' && <SecaoBancos d={d} salvar={salvar} dialogo={dialogo} />}
            {secao === 'mensagens' && <SecaoMensagens d={d} salvar={salvar} filtroInicial={filtroMsg} />}
            {secao === 'lembretes' && <SecaoLembretes d={d} salvar={salvar} param={param} irPara={irPara} />}
            {secao === 'ofertas' && <SecaoOfertas d={d} salvar={salvar} param={param} />}
            {secao === 'escalada' && <SecaoEscalada d={d} salvar={salvar} />}
            {secao === 'templates' && <SecaoTemplates token={token} api={api} dialogo={dialogo} mostrar={mostrar} />}
            {secao === 'paginas' && <SecaoPaginas d={d} salvar={salvar} token={token} api={api} />}
            {secao === 'historico' && <SecaoHistorico d={d} />}
          </div>
        </>
      )}
        </div>
      </div>
      {aviso && <div className={`iac-toast ${aviso.tipo}`}>{aviso.texto}</div>}
    </>
  )
}
