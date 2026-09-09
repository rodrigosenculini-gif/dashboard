import { useEffect, useState } from 'react'

// ---------------------------------------------------------------------
// Cache das consultas do dashboard.
//
// O problema que isto resolve: ao entrar numa view, ela disparava todas
// as consultas do zero e a tela ficava vazia até a mais lenta terminar.
//
// Como funciona agora:
//  1. Todo resultado é guardado (memória + localStorage). Ao voltar numa
//     view, o valor guardado é devolvido NA HORA — a tela nunca abre vazia.
//  2. Período fechado (date_to anterior a hoje) fica CONGELADO: nunca é
//     refeito sozinho, só no botão Atualizar. Dado de ontem não muda.
//  3. Período que inclui hoje revalida em segundo plano, no máximo a cada
//     3 minutos, e só se o Supabase realmente mudou (dashboard_versao).
//  4. Quando a revalidação traz dado novo, a revisão global muda e as
//     views que estão na tela se redesenham sozinhas.
// ---------------------------------------------------------------------

export const TTL_MS = 3 * 60_000          // 3 minutos
const PREFIXO = 'dash_cache_v1:'
const LIMITE_LOCAL = 220_000              // ~220KB por entrada; acima disso só memória

const memoria = new Map()                 // chave -> { dados, quando, versao }
const emVoo = new Map()                   // chave -> Promise (evita request duplicado)

// --- revisão global: as views observam isto para se redesenhar ---
let revisao = 0
const ouvintes = new Set()
function avisar() {
  revisao += 1
  ouvintes.forEach((f) => f(revisao))
}

export function useRevisaoCache() {
  const [r, setR] = useState(revisao)
  useEffect(() => {
    ouvintes.add(setR)
    return () => { ouvintes.delete(setR) }
  }, [])
  return r
}

// --- versão dos dados no Supabase, por domínio ---
const DOMINIO = [
  [/^(kpis|envios|campanhas|por_conversa|por_meta|por_mensagem|hoje_kpis|falha_por_minuto|por_template_hoje|funil|disparos|leilao)/, 'disparos'],
  [/^produtos|^funil_produtos|^entradas/, 'produtos'],
  [/^vendedoras/, 'vendedoras'],
  [/^vendas|^metas/, 'vendas'],
  [/^chips/, 'chips'],
  [/^trello/, 'trello'],
  [/^home$/, 'home'],
]
function dominioDe(type) {
  for (const [re, d] of DOMINIO) if (re.test(type)) return d
  return 'outro'
}

let versaoAtual = null
let versaoQuando = 0
let versaoEmVoo = null

async function buscarVersao() {
  if (versaoEmVoo) return versaoEmVoo
  if (versaoAtual && Date.now() - versaoQuando < TTL_MS) return versaoAtual
  versaoEmVoo = fetch('/api/dashboard?type=versao')
    .then((r) => r.json())
    .then((v) => { versaoAtual = v; versaoQuando = Date.now(); return v })
    .catch(() => versaoAtual)          // sem versão: cai no comportamento por tempo
    .finally(() => { versaoEmVoo = null })
  return versaoEmVoo
}

// A home depende de tudo; os demais domínios olham só o próprio carimbo.
function carimbo(type, v) {
  if (!v) return null
  const d = dominioDe(type)
  if (d === 'home') return `${v.hoje}|${v.disparos}|${v.produtos}|${v.vendedoras}|${v.vendas}`
  return `${v.hoje}|${v[d] ?? ''}`
}

// --- congelamento: a consulta cobre um período que já fechou? ---
function hojeISO() {
  return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
function congelado(params) {
  const fim = params?.date_to
  if (!fim) return false
  const dia = String(fim).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return false
  return dia < hojeISO()
}

const chaveDe = (type, params) => {
  const p = Object.entries(params || {})
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `${type}?${p.map(([k, v]) => `${k}=${v}`).join('&')}`
}

function lerLocal(chave) {
  try {
    const raw = localStorage.getItem(PREFIXO + chave)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
function gravarLocal(chave, entrada) {
  try {
    const txt = JSON.stringify(entrada)
    if (txt.length > LIMITE_LOCAL) return
    localStorage.setItem(PREFIXO + chave, txt)
  } catch {
    // cota estourada: limpa as entradas antigas e segue só com a memória
    try {
      const chaves = Object.keys(localStorage).filter((k) => k.startsWith(PREFIXO))
      chaves.slice(0, Math.ceil(chaves.length / 2)).forEach((k) => localStorage.removeItem(k))
    } catch { /* ignora */ }
  }
}

function pegar(chave) {
  if (memoria.has(chave)) return memoria.get(chave)
  const local = lerLocal(chave)
  if (local) { memoria.set(chave, local); return local }
  return null
}

async function buscarNaRede(type, params, chave, versao) {
  const qs = new URLSearchParams({ type, ...params })
  const res = await fetch(`/api/dashboard?${qs.toString()}`)
  const dados = await res.json()
  if (!res.ok) throw new Error(dados.error || `Erro ao buscar ${type}`)
  const entrada = { dados, quando: Date.now(), versao }
  memoria.set(chave, entrada)
  gravarLocal(chave, entrada)
  return dados
}

/**
 * Substitui o callApi antigo. Mesma assinatura.
 * @param {object} opts.forcar  ignora o cache (botão Atualizar)
 */
export async function callApi(type, params = {}, opts = {}) {
  const chave = chaveDe(type, params)
  const cache = pegar(chave)

  if (opts.forcar) {
    return buscarNaRede(type, params, chave, carimbo(type, await buscarVersao()))
  }

  // Período fechado: se já temos, é definitivo.
  if (cache && congelado(params)) return cache.dados

  if (cache) {
    const velho = Date.now() - cache.quando > TTL_MS
    if (!velho) return cache.dados

    // Passou dos 3 min: revalida em segundo plano, mas devolve o que já tem
    // agora mesmo, para a tela não piscar vazia.
    if (!emVoo.has(chave)) {
      const p = (async () => {
        const v = carimbo(type, await buscarVersao())
        if (v && cache.versao && v === cache.versao) {
          // Supabase não mudou: só renova o relógio, sem refazer a consulta.
          const renovada = { ...cache, quando: Date.now() }
          memoria.set(chave, renovada)
          gravarLocal(chave, renovada)
          return null
        }
        const novos = await buscarNaRede(type, params, chave, v)
        avisar()
        return novos
      })()
        .catch(() => null)
        .finally(() => emVoo.delete(chave))
      emVoo.set(chave, p)
    }
    return cache.dados
  }

  // Sem nada em cache: request normal, deduplicado.
  if (emVoo.has(chave)) return emVoo.get(chave)
  const p = (async () => carimbo(type, await buscarVersao()))()
    .then((v) => buscarNaRede(type, params, chave, v))
    .finally(() => emVoo.delete(chave))
  emVoo.set(chave, p)
  return p
}

/** true se todas as consultas já têm resposta guardada (tela abre cheia). */
export function temCache(type, params = {}) {
  return !!pegar(chaveDe(type, params))
}

export function limparCache() {
  memoria.clear()
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIXO))
      .forEach((k) => localStorage.removeItem(k))
  } catch { /* ignora */ }
  versaoAtual = null
  avisar()
}
