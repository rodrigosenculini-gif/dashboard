import React, { useCallback, useEffect, useState } from 'react'
import './Novas.css'

// Vendedoras novas (90 dias): card diário e página "Minha evolução" no portal da vendedora;
// aba "🌱 Novas" e alerta no topo para a gestão. Dados: RPCs dashboard_minha_evolucao,
// dashboard_novas, dashboard_novas_alerta (Supabase). O coach escreve notas privadas no CRM
// (n8n "Novas - coach em tempo real (VendeAI)"); aqui só se lê.

const CRM = 'https://crm.vendeaitecnologia.com.br/app/accounts/75/conversations/'

async function getJson(type, params = {}) {
  const qs = new URLSearchParams({ type, ...params })
  const r = await fetch(`/api/dashboard?${qs}`)
  const d = await r.json()
  if (!r.ok) throw new Error(d?.error || 'falha ao carregar')
  return d
}
async function post(type, body) {
  const r = await fetch(`/api/dashboard?type=${type}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const d = await r.json()
  if (!r.ok) throw new Error(d?.error || 'falha')
  return d
}

const hojeSP = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)
const fmtData = (s) => (s ? new Date(`${String(s).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '—')
const fmtHora = (s) => (s ? new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')
const pct = (x) => (x == null ? '—' : `${Math.round(Number(x) * 100)}%`)
const min = (x) => (x == null ? '—' : `${String(x).replace('.', ',')} min`)
const num = (x) => (x == null ? '—' : String(x).replace('.', ','))
const MOMENTO = {
  primeira_resposta: '1ª resposta', objecao: 'Objeção', documento: 'Documento', fechamento: 'Fechamento',
  encerramento: 'Nota final', sem_resposta: 'Cliente esperando', sumico: 'Cliente sumiu',
}
const CATEGORIA = {
  abertura: 'Abertura', objecao_taxa: 'Objeção de taxa', valor_baixo: 'Valor baixo', vou_pensar: '"Vou pensar"',
  desconfianca: 'Desconfiança', documento: 'Documentos', fechamento: 'Fechamento', follow_up: 'Follow-up',
  cross_sell: 'Outro produto', encerramento: 'Encerramento', outro: 'Outros',
}

export function useEvolucao(vendedor) {
  const [d, setD] = useState(null)
  const carregar = useCallback(() => {
    if (!vendedor) return
    getJson('minha_evolucao', { vendedor }).then(setD).catch(() => {})
  }, [vendedor])
  useEffect(() => {
    carregar()
    const t = setInterval(carregar, 2 * 60_000) // missões ao vivo: relê a cada 2 min
    return () => clearInterval(t)
  }, [carregar])
  return [d, carregar]
}

// confete leve, só CSS
function Confete({ ativo }) {
  if (!ativo) return null
  const cores = ['#a9d97f', '#d9b877', '#d99089', '#7fc4d9', '#eef1ee']
  return (
    <div className="nv-confete" aria-hidden="true">
      {Array.from({ length: 36 }).map((_, i) => (
        <i key={i} style={{ left: `${(i * 97) % 100}%`, background: cores[i % cores.length], animationDelay: `${(i % 9) * 0.12}s`, animationDuration: `${2.2 + (i % 5) * 0.3}s` }} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- quiz
function QuizPergunta({ vendedor, q, onRespondida }) {
  const [esc, setEsc] = useState(null)
  const [res, setRes] = useState(q.respondida ? { acertou: q.acertou, correta: q.correta, explicacao: q.explicacao } : null)
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState(null)
  const escolhida = q.respondida ? q.resposta : esc
  async function responder(i) {
    if (res || enviando) return
    setEsc(i); setEnviando(true)
    try {
      const r = await post('novas_quiz_responder', { vendedor, quiz_id: q.id, resposta: i })
      if (r?.erro) throw new Error(r.erro)
      setRes(r); onRespondida?.(r)
    } catch (e) { setErro(e.message) } finally { setEnviando(false) }
  }
  return (
    <div className="nv-quiz">
      <p className="nv-quiz-tag">{q.origem === 'erro' ? '🎯 Pergunta feita a partir de um atendimento seu' : `📚 ${q.produto}`}</p>
      <p className="nv-quiz-perg">{q.pergunta}</p>
      <div className="nv-quiz-opcoes">
        {(q.opcoes || []).map((o, i) => {
          const cls = res ? (i === res.correta ? 'certa' : i === escolhida ? 'errada' : 'apagada') : ''
          return (
            <button key={i} type="button" className={`nv-quiz-op ${cls}`} disabled={!!res || enviando} onClick={() => responder(i)}>
              <b>{String.fromCharCode(65 + i)}</b> {o}
            </button>
          )
        })}
      </div>
      {res && (
        <p className={`nv-quiz-res ${res.acertou ? 'ok' : 'ruim'}`}>
          {res.acertou ? '✅ Acertou! ' : '❌ Não foi dessa vez. '}{res.explicacao}
        </p>
      )}
      {erro && <p className="nv-quiz-res ruim">{erro}</p>}
    </div>
  )
}

// ---------------------------------------------------------------- card diário (portal) — simples e visual
// Aparece para a nova só quando há algo no dia: missão de hoje em andamento (progresso ao vivo),
// pergunta do dia (lúdica) ou retorno do dia ainda não visto. Some quando tudo foi feito/visto.
const MASCOTE = 'https://hotlinesolucoes.com.br/wp-content/uploads/2024/08/macote.png'

function Anel({ feito, alvo, rotulo, tam = 92 }) {
  const r = (tam - 12) / 2
  const c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(1, alvo ? feito / alvo : 0))
  const ok = p >= 1
  return (
    <div className={`nv-anel ${ok ? 'ok' : ''}`} style={{ width: tam }}>
      <svg width={tam} height={tam} viewBox={`0 0 ${tam} ${tam}`}>
        <circle cx={tam / 2} cy={tam / 2} r={r} className="nv-anel-fundo" />
        <circle cx={tam / 2} cy={tam / 2} r={r} className="nv-anel-valor"
                strokeDasharray={c} strokeDashoffset={c * (1 - p)} transform={`rotate(-90 ${tam / 2} ${tam / 2})`} />
      </svg>
      <span className="nv-anel-num" style={{ height: tam }}>{ok ? '🏅' : `${num(feito)}/${num(alvo)}`}</span>
      {rotulo && <span className="nv-anel-rot">{rotulo}</span>}
    </div>
  )
}

const FRASES_BOM_DIA = ['Bora fazer história hoje! 🔥', 'Dia novo, venda nova! 🚀', 'Hoje é dia de bater meta! 💪', 'Aquece que o cliente já chegou! 🔥']
const frase = (lista, semente) => lista[Math.abs(semente) % lista.length]

// balão do Esquentadinho (mesmo visual da comemoração de meta do portal)
export function EsquentadinhoComemora({ texto, detalhe, onFechar }) {
  useEffect(() => { const t = setTimeout(onFechar, 7000); return () => clearTimeout(t) }, [onFechar])
  return (
    <div className="nv-comemora" onClick={onFechar}>
      <Confete ativo />
      <div className="nv-comemora-balao" onClick={(e) => e.stopPropagation()}>
        <img src={MASCOTE} alt="Esquentadinho" className="nv-mascote-pula" />
        <p className="nv-comemora-texto">{texto}</p>
        {detalhe && <p className="nv-comemora-det">{detalhe}</p>}
        <button type="button" className="nv-chip-btn" onClick={onFechar}>Valeu!</button>
      </div>
    </div>
  )
}

export function NovaCardDiario({ vendedor, dados, recarregar, onAbrirEvolucao }) {
  const chaveMin = `nv_card_min_${vendedor}_${hojeSP()}`
  const chaveCel = `nv_celebradas_${vendedor}`
  const [minimizado, setMinimizado] = useState(() => { try { return localStorage.getItem(chaveMin) === '1' } catch { return false } })
  const [quizAberto, setQuizAberto] = useState(false)
  const [quizFeito, setQuizFeito] = useState(null)
  const [vistoAgora, setVistoAgora] = useState(false)
  const [comemora, setComemora] = useState(null)

  const missoesHoje = (dados?.missoes || []).filter((m) => m.situacao === 'hoje' || (m.concluida && String(m.data).slice(0, 10) === hojeSP()))
  // missão concluída hoje ainda não comemorada → Esquentadinho
  useEffect(() => {
    if (!dados?.nova) return
    let ja = []
    try { ja = JSON.parse(localStorage.getItem(chaveCel) || '[]') } catch { /* ignora */ }
    const nova = missoesHoje.find((m) => m.concluida && !ja.includes(m.codigo))
    if (nova) {
      setComemora({ texto: `Missão cumprida: ${nova.titulo}! 🏅`, detalhe: 'Você é fera! Bora pra próxima 🔥' })
      try { localStorage.setItem(chaveCel, JSON.stringify([...ja, nova.codigo])) } catch { /* ignora */ }
    }
  }, [dados]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!dados?.nova) return comemora ? <EsquentadinhoComemora {...comemora} onFechar={() => setComemora(null)} /> : null

  const q = dados.quiz_ativo ? dados.quiz_do_dia : null
  const quizPendente = q && !q.respondida && !quizFeito
  const fb = (dados.feedbacks || [])[0]
  const retornoNovo = fb && String(fb.dia).slice(0, 10) === hojeSP() && !fb.visto && !vistoAgora
  const emAndamento = missoesHoje.filter((m) => !m.concluida)
  const temAlgo = emAndamento.length || quizPendente || quizFeito || retornoNovo
  const celebracao = comemora && <EsquentadinhoComemora {...comemora} onFechar={() => setComemora(null)} />
  if (!temAlgo) return celebracao

  const minimizar = (v) => { setMinimizado(v); try { localStorage.setItem(chaveMin, v ? '1' : '0') } catch { /* ignora */ } }
  async function marcarVisto() {
    setVistoAgora(true)
    try { await post('novas_feedback_visto', { vendedor, id: fb.id }) } catch { /* reaparece se falhar */ }
    recarregar?.()
  }
  const faltam = emAndamento.reduce((s, m) => s + Math.max(0, (m.alvo || 0) - (m.feito || 0)), 0)
  const manha = new Date(Date.now() - 3 * 3600_000).getUTCHours() < 12
  const fala = retornoNovo ? (fb.texto?.titulo || 'Seu dia foi incrível! ⭐')
    : quizPendente && manha ? frase(FRASES_BOM_DIA, dados.dia)
    : emAndamento.length ? (faltam <= 2 ? `Tá quase! Falta${faltam > 1 ? 'm' : ''} só ${faltam} 🔥` : 'Bora completar a missão de hoje? 💪')
    : 'Mandou bem! 🎉'

  if (minimizado) {
    return (
      <>
        {celebracao}
        <button type="button" className="nv-card-min" onClick={() => minimizar(false)}>
          <img src={MASCOTE} alt="" /> {fala} <span>abrir</span>
        </button>
      </>
    )
  }
  return (
    <>
      {celebracao}
      <section className="nv-card nv-card-simples">
        <Confete ativo={retornoNovo && (fb.celebracoes || []).length > 0} />
        <img src={MASCOTE} alt="Esquentadinho" className="nv-mascote nv-mascote-pula" />
        <div className="nv-card-fala">
          <p className="nv-fala">{fala}</p>
          <p className="nv-fala-sub">Dia {dados.dia} de 90 · <button type="button" className="nv-link" onClick={onAbrirEvolucao}>minha evolução →</button></p>
          <div className="nv-card-chips">
            {quizPendente && !quizAberto && <button type="button" className="nv-chip-btn" onClick={() => setQuizAberto(true)}>🎲 Pergunta do dia</button>}
            {retornoNovo && <button type="button" className="nv-chip-btn ouro" onClick={() => { marcarVisto(); onAbrirEvolucao?.() }}>⭐ Ver meu dia</button>}
          </div>
        </div>
        <div className="nv-card-aneis">
          {missoesHoje.slice(0, 2).map((m) => <Anel key={m.codigo} feito={m.feito} alvo={m.alvo} rotulo={m.titulo} />)}
        </div>
        <button type="button" className="nv-x nv-x-canto" title="Minimizar até amanhã" onClick={() => minimizar(true)}>–</button>
        {(quizAberto || quizFeito) && q && (
          <div className="nv-card-quiz">
            <QuizPergunta vendedor={vendedor} q={q} onRespondida={(r) => {
              setQuizFeito(r)
              if (r?.acertou) setComemora({ texto: 'Acertou! 🎯', detalhe: 'Esse cérebro está on fire 🔥' })
            }} />
            {quizFeito && <button type="button" className="reset-btn nv-fechar" onClick={() => { setQuizAberto(false); setQuizFeito(null); recarregar?.() }}>Fechar</button>}
          </div>
        )}
      </section>
    </>
  )
}

// ---------------------------------------------------------------- "Minha evolução" da vendedora — poucas telas, visual
function Gauge({ titulo, valor, texto, sub, ok }) {
  return (
    <div className={`nv-gauge ${ok ? 'ok' : ''}`}>
      <Anel feito={Math.max(0, Math.min(100, valor ?? 0))} alvo={100} tam={120} />
      <span className="nv-gauge-texto">{texto}</span>
      <span className="nv-gauge-tit">{titulo}</span>
      {sub && <span className="nv-gauge-sub">{sub}</span>}
    </div>
  )
}

export function MinhaEvolucaoSimples({ vendedor, dados, onFechar }) {
  const d = dados
  if (!d) return null
  const metas = d.metas || {}
  const hoje = d.hoje || {}
  const sem = d.semana_atual || {}
  const eq = d.equipe_semana || {}
  const serie = (d.serie_dias || []).map((x) => ({ dia: fmtData(x.dia), clientes: x.clientes || 0, nota: x.nota }))
  const fb = (d.feedbacks || [])[0]
  const progresso = Math.min(100, Math.round(((d.dia || 1) / 90) * 100))
  const resp = hoje.mediana_resposta_min ?? sem.mediana_resposta_min
  const nota = sem.nota_coach_media
  const clientesHoje = serie.length ? serie[serie.length - 1].clientes : 0
  const fala = fb?.texto?.titulo || (nota >= 8 ? 'Você está brilhando! ✨' : nota >= 7 ? 'Tá voando, continua assim! 🚀' : 'Cada atendimento te deixa mais forte! 💪')
  return (
    <div className="nv-pagina-fundo" onClick={onFechar}>
      <div className="nv-pagina nv-simples" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="nv-x nv-x-canto" onClick={onFechar} title="Fechar">✕</button>
        <div className="nv-hero">
          <img src={MASCOTE} alt="Esquentadinho" className="nv-mascote-grande nv-mascote-pula" />
          <div>
            <p className="nv-hero-fala">{fala}</p>
            <div className="nv-trilha">
              <span className="nv-trilha-barra"><i style={{ width: `${progresso}%` }} /><b style={{ left: `${progresso}%` }}>🏃‍♀️</b></span>
              <span className="nv-trilha-fim">🎓</span>
            </div>
            <p className="nv-fala-sub">{d.formada ? 'Formada! 🎓' : `Dia ${d.dia} de 90 até o selo de formada`}</p>
          </div>
        </div>

        <div className="nv-gauges">
          <Gauge titulo="Rapidez (min)" texto={resp == null ? '—' : num(resp)}
                 valor={resp == null ? 0 : Math.max(5, 100 - (resp - 1) * 18)} ok={resp != null && resp <= (metas.primeira_resposta_min ?? 2)}
                 sub={eq.mediana_resposta_min != null ? `colegas: ${num(eq.mediana_resposta_min)} min` : null} />
          <Gauge titulo="Clientes hoje" texto={num(clientesHoje)} valor={Math.min(100, clientesHoje * 5)} ok={clientesHoje >= 10}
                 sub={hoje.vendas ? `${hoje.vendas} venda(s) 💰` : null} />
          <Gauge titulo="Sua nota" texto={nota == null ? '—' : num(nota)} valor={(nota ?? 0) * 10} ok={nota != null && nota >= (metas.nota_minima ?? 7)}
                 sub="de 0 a 10" />
        </div>

        {serie.length > 1 && (
          <div className="nv-grafico">
            <p className="nv-bloco-label">Clientes atendidos por dia</p>
            <div className="nv-barras">
              {serie.map((s) => {
                const max = Math.max(...serie.map((x) => x.clientes), 1)
                return (
                  <div key={s.dia} className="nv-barras-col" title={`${s.dia}: ${s.clientes} clientes`}>
                    <span className="nv-barras-v">{s.clientes || ''}</span>
                    <i style={{ height: `${Math.max(4, (s.clientes / max) * 100)}%` }} />
                    <small>{s.dia}</small>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <p className="nv-bloco-label">Missões da 1ª semana</p>
        <div className="nv-badges">
          {(d.missoes || []).map((m) => (
            <div key={m.codigo} className={`nv-badge ${m.situacao}`} title={`${m.titulo} — ${m.descricao}`}>
              {m.situacao === 'hoje' ? <Anel feito={m.feito} alvo={m.alvo} tam={54} />
                : <span className="nv-badge-ic">{m.concluida ? '🏅' : m.situacao === 'bloqueada' ? '🔒' : '✖'}</span>}
              <small>{m.titulo}</small>
            </div>
          ))}
        </div>

        {fb?.texto?.foco && <p className="nv-dica">💡 {fb.texto.foco}</p>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- visão completa do gestor por vendedora (aba Novas)
function Barra({ valor, equipe }) {
  const v = Math.max(0, Math.min(100, Number(valor) || 0))
  const e = equipe == null ? null : Math.max(0, Math.min(100, Number(equipe)))
  return (
    <span className="nv-barra">
      <i style={{ width: `${v}%` }} className={v >= 80 ? 'ok' : v < 50 ? 'ruim' : 'medio'} />
      {e != null && <em style={{ left: `${e}%` }} title={`equipe: ${e}%`} />}
    </span>
  )
}

function Comparativo({ dela, equipe, metas }) {
  const linhas = [
    ['Mediana da 1ª resposta', min(dela?.mediana_resposta_min), min(equipe?.mediana_resposta_min), dela?.mediana_resposta_min != null && dela.mediana_resposta_min <= (metas?.primeira_resposta_min ?? 2)],
    ['Clientes respondidos', pct(dela?.taxa_resposta), pct(equipe?.taxa_resposta), dela?.taxa_resposta != null && dela.taxa_resposta >= (metas?.taxa_resposta ?? 0.85)],
    ['Vendas lançadas', num(dela?.vendas), equipe?.vendas_por_vendedora != null ? `${num(equipe.vendas_por_vendedora)} por vendedora` : '—', (dela?.vendas ?? 0) > 0],
    ['Nota dos atendimentos (coach)', num(dela?.nota_coach_media), '—', dela?.nota_coach_media != null && dela.nota_coach_media >= (metas?.nota_minima ?? 7)],
    ['Nota da avaliação (0–10)', num(dela?.nota_qualidade_media), num(equipe?.nota_qualidade_media), dela?.nota_qualidade_media != null && equipe?.nota_qualidade_media != null && dela.nota_qualidade_media >= equipe.nota_qualidade_media],
  ]
  return (
    <table className="nv-tab">
      <thead><tr><th /><th>Você</th><th>Média das colegas</th><th /></tr></thead>
      <tbody>{linhas.map(([r, a, b, ok]) => <tr key={r}><td>{r}</td><td><b>{a}</b></td><td>{b}</td><td>{ok ? '✅' : ''}</td></tr>)}</tbody>
    </table>
  )
}

export function GestorVendedoraPagina({ vendedor, dados, onFechar }) {
  const [aba, setAba] = useState('resumo')
  const d = dados
  if (!d) return null
  const eq = Object.fromEntries((d.criterios_equipe || []).map((c) => [c.chave, c.pct]))
  const missoesFeitas = (d.missoes || []).filter((m) => m.concluida).length
  const progresso = Math.min(100, Math.round(((d.dia || 1) / 90) * 100))
  const modelos = (d.modelos || []).reduce((acc, m) => { (acc[m.categoria] ||= []).push(m); return acc }, {})
  const ABAS = [['resumo', 'Resumo'], ['criterios', 'Critérios'], ['semanas', 'Semana a semana'], ['retornos', 'Retornos e coach'],
    ['missoes', 'Missões'], ...(d.quiz_ativo ? [['quiz', 'Quiz']] : []), ['modelos', 'Respostas modelo']]
  return (
    <div className="nv-pagina-fundo" onClick={onFechar}>
      <div className="nv-pagina" onClick={(e) => e.stopPropagation()}>
        <div className="nv-pagina-topo">
          <div>
            <h2>🌱 {vendedor} — visão do gestor</h2>
            <p className="nv-sub">{vendedor} · dia {d.dia} de 90 · {d.semana}ª semana</p>
          </div>
          <button type="button" className="reset-btn" onClick={onFechar}>Fechar</button>
        </div>

        <div className="nv-selo">
          {d.formada
            ? <span className="nv-selo-ok">🎓 Formada! Selo conquistado {d.formada_em ? `em ${fmtData(d.formada_em)}` : ''}</span>
            : <>
                <span>Caminho até o selo de formada</span>
                <span className="nv-barra larga"><i className="ok" style={{ width: `${progresso}%` }} /></span>
                <span className="nv-sub">{90 - (d.dia || 0)} dias · {missoesFeitas}/{(d.missoes || []).length} missões · meta de nota {num(d.metas?.nota_formada ?? 7.5)}</span>
              </>}
        </div>

        <div className="nv-abas">
          {ABAS.map(([k, r]) => <button key={k} type="button" className={`nv-aba ${aba === k ? 'on' : ''}`} onClick={() => setAba(k)}>{r}</button>)}
        </div>

        {aba === 'resumo' && <>
          <p className="nv-bloco-label">Hoje</p>
          <Comparativo dela={d.hoje} equipe={d.equipe_semana} metas={d.metas} />
          <p className="nv-bloco-label">Últimos 7 dias</p>
          <Comparativo dela={d.semana_atual} equipe={d.equipe_semana} metas={d.metas} />
          {d.semana_atual?.melhor_atendimento && (
            <p className="nv-destaque">⭐ Seu melhor atendimento: nota {num(d.semana_atual.melhor_atendimento.nota)} —{' '}
              <a href={CRM + d.semana_atual.melhor_atendimento.conversation_id} target="_blank" rel="noreferrer">abrir conversa</a></p>
          )}
        </>}

        {aba === 'criterios' && <>
          <p className="nv-sub">Avaliação da IA nos seus atendimentos reais dos últimos 7 dias (% da nota máxima). O tracinho é a média das colegas.</p>
          {(d.criterios || []).map((c) => (
            <div key={c.chave} className="nv-crit">
              <span>{c.rotulo}</span>
              <Barra valor={c.pct} equipe={eq[c.chave]} />
              <b>{c.pct == null ? '—' : `${c.pct}%`}</b>
            </div>
          ))}
          {!(d.criterios || []).some((c) => c.pct != null) && <p className="home-vazio">Ainda sem atendimentos avaliados.</p>}
        </>}

        {aba === 'semanas' && (
          <table className="nv-tab">
            <thead><tr><th>Semana</th><th>1ª resposta</th><th>Respondidos</th><th>Vendas</th><th>Nota coach</th><th>Nota avaliação</th></tr></thead>
            <tbody>
              {(d.semanas || []).map((s) => (
                <tr key={s.semana}>
                  <td>{s.semana}ª <small>{fmtData(s.ini)}–{fmtData(s.fim)}</small></td>
                  <td>{min(s.m?.mediana_resposta_min)} <small>equipe {min(s.equipe?.mediana_resposta_min)}</small></td>
                  <td>{pct(s.m?.taxa_resposta)} <small>equipe {pct(s.equipe?.taxa_resposta)}</small></td>
                  <td>{num(s.m?.vendas)} <small>equipe {num(s.equipe?.vendas_por_vendedora)}</small></td>
                  <td>{num(s.m?.nota_coach_media)}</td>
                  <td>{num(s.m?.nota_qualidade_media)} <small>equipe {num(s.equipe?.nota_qualidade_media)}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {aba === 'retornos' && <>
          <p className="nv-bloco-label">Retornos</p>
          {(d.feedbacks || []).map((f) => (
            <div key={f.id} className="nv-ret">
              <p className="nv-ret-titulo">{fmtData(f.periodo_ini)}–{fmtData(f.dia)} · {f.texto?.titulo}</p>
              {(f.celebracoes || []).length > 0 && <div className="nv-celebra">{f.celebracoes.map((c, i) => <span key={i} className="nv-chip">{c.texto}</span>)}</div>}
              <p className="nv-ret-texto">{f.texto?.elogio}</p>
              {(f.texto?.pontos || []).map((p, i) => (
                <div key={i} className="nv-ponto">
                  <b>{p.o_que}</b>
                  {p.exemplo && <span className="nv-ex">“{p.exemplo}”</span>}
                  <span>👉 {p.como_fazer}</span>
                </div>
              ))}
              {f.texto?.comparacao && <p className="nv-sub">{f.texto.comparacao}</p>}
              {f.texto?.foco && <p className="nv-ret-foco">Foco: {f.texto.foco}</p>}
            </div>
          ))}
          {!(d.feedbacks || []).length && <p className="home-vazio">O primeiro retorno chega no fim do seu 1º dia (a partir das 18h).</p>}
          <p className="nv-bloco-label">Notas do coach nos seus atendimentos</p>
          {(d.notas || []).map((n, i) => (
            <div key={i} className="nv-nota">
              <span className="nv-nota-meta">{fmtHora(n.em)} · {MOMENTO[n.momento] || n.momento}{n.nota != null ? ` · nota ${num(n.nota)}` : ''} ·{' '}
                <a href={CRM + n.conversation_id} target="_blank" rel="noreferrer">#{n.conversation_id}</a></span>
              <span className="nv-nota-txt">{String(n.texto || '').replace(/^🎓 Coach \(nota interna[^)]*\)\n?/, '')}</span>
            </div>
          ))}
          {!(d.notas || []).length && <p className="home-vazio">Nenhuma nota ainda.</p>}
        </>}

        {aba === 'missoes' && <>
          <p className="nv-sub">Conferidas automaticamente ao longo do dia (a cada leitura). As marcadas com 🤖 dependem da avaliação da IA: o resultado pode chegar com atraso de alguns minutos (até ~1 h para a nota final do atendimento). No fim do dia (20h) fica registrado cumprida / não cumprida.</p>
          <div className="nv-missoes">
            {(d.missoes || []).map((m) => {
              const reg = (d.registro_missoes || []).find((r) => r.codigo === m.codigo)
              const situ = reg ? (reg.concluida ? 'concluida' : 'perdida') : m.situacao
              return (
                <div key={m.codigo} className={`nv-missao ${situ}`}>
                  <span className="nv-missao-ic">{situ === 'concluida' ? '🏅' : situ === 'hoje' ? '🎯' : situ === 'bloqueada' ? '🔒' : '✖'}</span>
                  <span><b>Dia {m.dia} · {m.titulo}{m.ia ? ' 🤖' : ''}</b><br /><small>{m.descricao}</small>
                    {situ === 'perdida' && <><br /><small className="nv-nao">não cumprida{reg ? ` (registrado ${fmtHora(reg.registrado_em)})` : ''}</small></>}</span>
                  <span className="nv-missao-prog">{num(reg ? reg.feito : m.feito)}/{num(m.alvo)}</span>
                </div>
              )
            })}
          </div>
        </>}

        {aba === 'quiz' && <>
          <p className="nv-sub">Acertos: {d.quiz?.acertos ?? 0} · uma pergunta por dia nos primeiros 18 dias. As perguntas com 🎯 foram feitas a partir dos seus atendimentos.</p>
          {(d.quiz_historico || []).map((q, i) => (
            <div key={i} className={`nv-quiz-hist ${q.acertou ? 'ok' : 'ruim'}`}>
              <b>{q.acertou ? '✅' : '❌'} {q.origem === 'erro' ? '🎯 ' : ''}{q.pergunta}</b>
              {!q.acertou && <span>Sua resposta: {q.resposta} · Certa: {q.correta}</span>}
              <small>{q.explicacao}</small>
            </div>
          ))}
          {!(d.quiz_historico || []).length && <p className="home-vazio">Nenhuma pergunta respondida ainda.</p>}
        </>}

        {aba === 'modelos' && <>
          <p className="nv-sub">Respostas reais das colegas veteranas que funcionaram (sem dados de clientes).</p>
          {Object.entries(modelos).map(([cat, lista]) => (
            <details key={cat} className="nv-modelos">
              <summary>{CATEGORIA[cat] || cat} <small>({lista.length})</small></summary>
              {lista.map((m, i) => (
                <div key={i} className="nv-modelo">
                  <span className="nv-modelo-cli">Cliente: {m.situacao}</span>
                  <span className="nv-modelo-resp">{m.resposta}</span>
                  {m.por_que && <small>Por que funciona: {m.por_que}</small>}
                </div>
              ))}
            </details>
          ))}
          {!Object.keys(modelos).length && <p className="home-vazio">A biblioteca está sendo montada a partir das melhores conversas.</p>}
        </>}
      </div>
    </div>
  )
}

// botão no cabeçalho do portal (só para quem entrou como nova) — abre a versão simples
export function MinhaEvolucaoBotao({ vendedor, dados, aberto, setAberto }) {
  if (!dados || dados.nova === false || !dados.dia) return null
  return (
    <>
      <button type="button" className="reset-btn nv-btn" onClick={() => setAberto(true)} title="Sua evolução e missões">
        🌱 Minha evolução
      </button>
      {aberto && <MinhaEvolucaoSimples vendedor={vendedor} dados={dados} onFechar={() => setAberto(false)} />}
    </>
  )
}

// ---------------------------------------------------------------- gestão: alerta no topo
export function NovasAlerta({ onAbrir }) {
  const [a, setA] = useState(null)
  useEffect(() => {
    const ler = () => getJson('novas_alerta').then(setA).catch(() => {})
    ler()
    const t = setInterval(ler, 5 * 60_000)
    return () => clearInterval(t)
  }, [])
  if (!a?.novas) return null
  return (
    <button type="button" className="nv-alerta" onClick={onAbrir} title="Abrir a aba Novas do robô">
      🌱 {a.novas} nova{a.novas > 1 ? 's' : ''} em acompanhamento
      {a.notas_hoje ? ` · ${a.notas_hoje} nota${a.notas_hoje > 1 ? 's' : ''} do coach hoje${a.modo === 'previa' ? ' (prévia)' : ''}` : ''}
      {a.sem_vinculo ? ` · ⚠ ${a.sem_vinculo} sem vínculo com o CRM` : ''}
    </button>
  )
}

// ---------------------------------------------------------------- gestão: aba 🌱 Novas
export function NovasPainel() {
  const [d, setD] = useState(null)
  const [erro, setErro] = useState(null)
  const [ocupado, setOcupado] = useState(false)
  const [filtro, setFiltro] = useState('todas')
  const [verTudo, setVerTudo] = useState(null) // { vendedora, dados }
  const abrirTudo = (v) => getJson('minha_evolucao', { vendedor: v }).then((x) => setVerTudo({ vendedora: v, dados: x })).catch((e) => setErro(e.message))
  const carregar = useCallback(() => getJson('novas').then((x) => { setD(x); setErro(null) }).catch((e) => setErro(e.message)), [])
  useEffect(() => { carregar(); const t = setInterval(carregar, 60_000); return () => clearInterval(t) }, [carregar])

  async function acao(fn) {
    setOcupado(true)
    try { await fn(); await carregar() } catch (e) { setErro(e.message) } finally { setOcupado(false) }
  }
  const modo = d?.config?.modo || 'previa'
  const trocarModo = () => {
    const novo = modo === 'ativo' ? 'previa' : 'ativo'
    const msg = novo === 'ativo'
      ? 'Ligar o coach? As notas passam a ser escritas como NOTA PRIVADA nas conversas das novas no CRM (o cliente não vê).'
      : 'Voltar para prévia? O coach continua avaliando, mas não escreve mais no CRM.'
    if (window.confirm(msg)) acao(() => post('novas_modo', { modo: novo }))
  }
  const notas = (d?.notas_recentes || []).filter((n) => filtro === 'todas' || n.nota_status === filtro)

  return (
    <div className="nv-gestao">
      {verTudo && <GestorVendedoraPagina vendedor={verTudo.vendedora} dados={verTudo.dados} onFechar={() => setVerTudo(null)} />}
      {erro && <div className="state-msg error">Erro: {erro}</div>}
      <section className="panel">
        <div className="nv-gestao-topo">
          <p className="section-label">Vendedoras novas · acompanhamento de 90 dias</p>
          <button type="button" className={`robo-modo ${modo === 'ativo' ? 'on' : ''}`} disabled={!d || ocupado} onClick={trocarModo}>
            {modo === 'ativo' ? '● Coach escrevendo no CRM — pausar' : '○ Coach em prévia — ligar notas no CRM'}
          </button>
        </div>
        <p className="nv-sub">Nova = login de vendedora criado a partir de 14/10 (marcado automaticamente). Volume reduzido: 1º dia 3 a cada 10 min; até o 14º dia, lote de 3 liberado quando ela responde todos. Missões conferidas automaticamente ao longo do dia; as com 🤖 dependem da avaliação da IA e podem atrasar alguns minutos (até ~1 h na nota final).
          {' '}Respostas modelo na biblioteca: {d?.modelos ?? 0}. Média das colegas (7 dias): 1ª resposta {min(d?.equipe_semana?.mediana_resposta_min)}, respondidos {pct(d?.equipe_semana?.taxa_resposta)}.</p>
        {!d?.novas?.length && <p className="home-vazio">Nenhuma vendedora nova no momento.</p>}
        <div className="nv-gestao-cards">
          {(d?.novas || []).map((n) => (
            <div key={n.vendedora} className="nv-gcard">
              <div className="nv-gcard-topo">
                <b>{n.vendedora}</b>
                <button type="button" className="nv-link" onClick={() => abrirTudo(n.vendedora)}>ver tudo →</button>
                <span className="nv-sub">{n.formada_em ? '🎓 formada' : `dia ${n.dia} · ${n.semana}ª semana`}</span>
              </div>
              {n.agent_id ? (
                <p className="nv-sub">CRM: {n.nome_crm} (#{n.agent_id}) {n.online_em ? `· visto ${fmtHora(n.online_em)}` : ''}</p>
              ) : (
                <div className="nv-vinc">
                  <span>⚠ Sem vínculo com o agente do CRM (o coach e o robô não a enxergam).</span>
                  <select disabled={ocupado} defaultValue="" onChange={(e) => {
                    const ag = (d.agentes_sem_vinculo || []).find((x) => String(x.agent_id) === e.target.value)
                    if (ag && window.confirm(`Vincular ${n.vendedora} ao agente "${ag.nome}" (#${ag.agent_id})? Ela passa a receber atendimentos do robô.`)) {
                      acao(() => post('novas_vincular', { vendedora: n.vendedora, agent_id: ag.agent_id, nome_crm: ag.nome }))
                    }
                  }}>
                    <option value="">escolher agente…</option>
                    {(d.agentes_sem_vinculo || []).map((x) => <option key={x.agent_id} value={x.agent_id}>{x.nome} (#{x.agent_id}, {x.msgs} msgs em 3 dias)</option>)}
                  </select>
                </div>
              )}
              {n.agent_id && (
                <label className="nv-chave">
                  <input type="checkbox" checked={!!n.nova_limite_ativo} disabled={ocupado}
                         onChange={(e) => acao(() => post('robo_vendedora_salvar', { agent_id: n.agent_id, nova_limite_ativo: e.target.checked }))} />
                  Volume reduzido {n.nova_limite_ativo && n.nova_ativada_em ? `(ligado ${fmtHora(n.nova_ativada_em)})` : ''}
                </label>
              )}
              <table className="nv-tab compacta">
                <thead><tr><th /><th>Hoje</th><th>7 dias</th></tr></thead>
                <tbody>
                  <tr><td>1ª resposta</td><td>{min(n.hoje?.mediana_resposta_min)}</td><td>{min(n.semana7?.mediana_resposta_min)}</td></tr>
                  <tr><td>Respondidos</td><td>{pct(n.hoje?.taxa_resposta)}</td><td>{pct(n.semana7?.taxa_resposta)}</td></tr>
                  <tr><td>Vendas</td><td>{num(n.hoje?.vendas)}</td><td>{num(n.semana7?.vendas)}</td></tr>
                  <tr><td>Nota coach</td><td>{num(n.hoje?.nota_coach_media)}</td><td>{num(n.semana7?.nota_coach_media)}</td></tr>
                  <tr><td>Clientes esperando (alertas)</td><td>{num(n.hoje?.alertas_espera)}</td><td>{num(n.semana7?.alertas_espera)}</td></tr>
                </tbody>
              </table>
              <p className="nv-sub">Coach hoje: {Object.entries(n.coach_hoje || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || 'nada ainda'}</p>
              <p className="nv-sub">Missões: {(n.missoes || []).filter((m) => m.concluida).length} cumpridas · {(n.missoes || []).filter((m) => m.situacao === 'perdida').length} não cumpridas · hoje: {(n.missoes || []).filter((m) => m.situacao === 'hoje').map((m) => `${m.titulo} ${num(m.feito)}/${num(m.alvo)}${m.ia ? ' 🤖' : ''}`).join(', ') || '—'}
                {n.ultimo_feedback ? ` · último retorno ${fmtData(n.ultimo_feedback.dia)}${n.ultimo_feedback.visto ? ' (visto)' : ' (não visto)'}` : ''}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="panel table-panel">
        <div className="nv-gestao-topo">
          <p className="section-label">Notas do coach (revise antes de ligar)</p>
          <select value={filtro} onChange={(e) => setFiltro(e.target.value)}>
            <option value="todas">todas</option><option value="previa">prévia</option><option value="enviada">enviadas</option>
            <option value="pulada">puladas</option><option value="fila">na fila</option><option value="erro">erro</option>
          </select>
        </div>
        {notas.map((n) => (
          <div key={n.id} className={`nv-nota ${n.nota_status}`}>
            <span className="nv-nota-meta">{fmtHora(n.em)} · {n.vendedora} · {MOMENTO[n.momento] || n.momento} · {n.nota_status}{n.motivo ? ` (${n.motivo})` : ''} ·{' '}
              <a href={CRM + n.conversation_id} target="_blank" rel="noreferrer">#{n.conversation_id}</a></span>
            <span className="nv-nota-txt">{n.texto || (n.avaliacao?.motivo ? `IA não interveio: ${n.avaliacao.motivo}` : '—')}</span>
          </div>
        ))}
        {!notas.length && <p className="home-vazio">Nenhuma nota.</p>}
      </section>
    </div>
  )
}
