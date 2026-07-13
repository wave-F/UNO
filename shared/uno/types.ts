/** Only four UNO colors; number cards only. */
export type UnoColor = 'red' | 'yellow' | 'green' | 'blue'

export type UnoRank = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'

export type UnoCardData = {
  id: string
  color: UnoColor
  rank: UnoRank
}

export const UNO_COLOR_HEX: Record<UnoColor, number> = {
  red: 0xe63946,
  yellow: 0xffd60a,
  green: 0x2a9d8f,
  blue: 0x457b9d,
}

export const UNO_COLOR_CSS: Record<UnoColor, string> = {
  red: '#e63946',
  yellow: '#ffd60a',
  green: '#2a9d8f',
  blue: '#457b9d',
}

const COLOR_NAME: Record<UnoColor, string> = {
  red: '红',
  yellow: '黄',
  green: '绿',
  blue: '蓝',
}

export function rankLabel(rank: UnoRank): string {
  return rank
}

export function cardLabel(card: UnoCardData): string {
  return `${COLOR_NAME[card.color]} ${card.rank}`
}
