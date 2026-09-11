import { useEffect, useMemo } from 'react'

// Comemoracao de nivel batido. Componente apresentacional: quem busca e quem
// grava e o App.jsx. Aqui so decide o formato e avisa quando terminou.
//
// Regras combinadas:
//  - PRIMEIRO nivel do mes E com pelo menos um nivel INDIVIDUAL no lote:
//    balao do esquentadinho, com botao para fechar.
//  - Qualquer outro caso: confete por 3s, sem interromper.
//  - A COLETIVA nunca dispara o esquentadinho. Se o lote so tem faixa coletiva,
//    e confete mesmo sendo o primeiro do mes.
//  - UMA comemoracao por lote, dizendo quantos niveis subiu. Nunca N seguidas.
//  - Durante o congelamento da coletiva os niveis 'col:' sao escondidos: seria
//    vazar justamente o numero que a tela esta escondendo na conferencia.

const DURACAO_CONFETE = 3000
const QTD_CONFETES = 20

// metas_comemorar agrega tudo numa linha so. 'chaves' vem ordenado por
// (tipo, chave) e 'detalhe' e um string_agg na MESMA ordem, entao da para
// alinhar por indice. 'coletiva' < 'individual', logo as col: vem primeiro.
//
// FRAGIL: se alguma descricao de janela contiver ' · ', o split desalinha.
// Hoje as descricoes usam ' — '. Vale lembrar quando a IA da frente 1.3
// comecar a escrever descricao livre.
export function semColetiva(com) {
  if (!com) return null
  const qtdCol = com.chaves.filter((k) => k.startsWith('col:')).length
  if (qtdCol === 0) return com

  const chaves = com.chaves.slice(qtdCol)
  if (!chaves.length) return null

  const partes = String(com.detalhe || '').split(' · ').slice(qtdCol)
  return {
    ...com,
    qtd: chaves.length,
    chaves,
    detalhe: partes.join(' · '),
    titulo: chaves.length === 1 ? 'Meta batida' : `Você subiu ${chaves.length} níveis de uma vez`,
  }
}

export default function MetaComemoracao({ comemoracao, mascotUrl, congelada, onFechar }) {
  const com = useMemo(
    () => (congelada ? semColetiva(comemoracao) : comemoracao),
    [comemoracao, congelada]
  )

  // so individual dispara o balao
  const temIndividual = !!com && com.chaves.some((k) => k.startsWith('ind:'))
  const balao = !!com && com.primeiro && temIndividual

  useEffect(() => {
    if (!com || balao) return
    const t = setTimeout(() => onFechar(com.chaves), DURACAO_CONFETE)
    return () => clearTimeout(t)
  }, [com, balao, onFechar])

  if (!com) return null

  if (balao) {
    return (
      <div className="onboarding-overlay meta-comemora-overlay">
        <div className="onboarding-bubble">
          <img src={mascotUrl} alt="Esquentadinho" />
          <div className="onboarding-text">
            Parabéns, você alcançou mais um nível para o sucesso! Meta Batida
            <span className="meta-comemora-detalhe">
              {com.qtd > 1 ? `${com.titulo} — ` : ''}
              {com.detalhe}
            </span>
          </div>
          <button className="onboarding-next" onClick={() => onFechar(com.chaves)}>
            Fechar
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="meta-confete" aria-hidden="true">
      {Array.from({ length: QTD_CONFETES }, (_, i) => (
        <i
          key={i}
          className={'meta-confete-p c' + (i % 3)}
          style={{
            left: `${(i * 97) % 100}%`,
            animationDelay: `${(i % 7) * 120}ms`,
            animationDuration: `${1800 + (i % 5) * 260}ms`,
          }}
        />
      ))}
    </div>
  )
}
