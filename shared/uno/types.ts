/** Four UNO colors; numbers use these. Function cards may omit color. */
export type UnoColor = 'red' | 'yellow' | 'green' | 'blue'

/** Number ranks are 0–7 only (no 8/9 in this build). */
export type UnoRank = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | 'stun' | 'skip'

export type UnoKind = 'number' | 'stun_bat' | 'skip_trap'

export type UnoCardData = {
  id: string
  /** Omitted / null for colorless function cards (e.g. stun / skip). */
  color?: UnoColor | null
  rank: UnoRank
  /** Default number when omitted. */
  kind?: UnoKind
}

export const UNO_COLOR_HEX: Record<UnoColor, number> = {
  red: 0xe63946,
  yellow: 0xffd60a,
  green: 0x2a9d8f,
  /** Vivid UNO-style blue (was muted slate #457b9d). */
  blue: 0x1a6dff,
}

export const UNO_COLOR_CSS: Record<UnoColor, string> = {
  red: '#e63946',
  yellow: '#ffd60a',
  green: '#2a9d8f',
  blue: '#1a6dff',
}

/** Face / UI color for colorless function cards. */
export const STUN_CARD_HEX = 0x4c1d95
export const STUN_CARD_CSS = '#4c1d95'
export const SKIP_CARD_HEX = 0x0f766e
export const SKIP_CARD_CSS = '#0f766e'

const COLOR_NAME: Record<UnoColor, string> = {
  red: '红',
  yellow: '黄',
  green: '绿',
  blue: '蓝',
}

export function isStunBat(card: UnoCardData): boolean {
  return card.kind === 'stun_bat' || card.rank === 'stun'
}

export function isSkipTrap(card: UnoCardData): boolean {
  return card.kind === 'skip_trap' || card.rank === 'skip'
}

/** Hand-held prop slot: mace or skip trap (mutually exclusive, never backpack). */
export function isHandItem(card: UnoCardData): boolean {
  return isStunBat(card) || isSkipTrap(card)
}

export function rankLabel(rank: UnoRank): string {
  if (rank === 'stun') return '晕'
  if (rank === 'skip') return '禁'
  return rank
}

export function cardLabel(card: UnoCardData): string {
  if (isStunBat(card)) return '狼牙棒'
  if (isSkipTrap(card)) return 'Skip陷阱'
  if (!card.color) return rankLabel(card.rank)
  return `${COLOR_NAME[card.color]} ${card.rank}`
}

/** Attack item constants (server + client). */
/** Stun after mace / slide hit (and related combat). */
export const STUN_DURATION_MS = 2000
/** Skip trap stun when stepped on. */
export const SKIP_TRAP_STUN_MS = 2000
/** Step-on radius for placed skip traps (XZ meters). */
export const SKIP_TRAP_RADIUS = 0.85
/** Mace hit: drop min(STUN_DROP_MAX, backpack length) from stack top. */
export const STUN_DROP_MAX = 4
/** Slide tackle: drop a random count in [SLIDE_DROP_MIN, SLIDE_DROP_MAX], capped by stack. */
export const SLIDE_DROP_MIN = 1
export const SLIDE_DROP_MAX = 4

/** Random 1–4 (or less if backpack smaller). */
export function randomSlideDropCount(
  stackLen: number,
  rng: () => number = Math.random,
): number {
  if (stackLen <= 0) return 0
  const span = SLIDE_DROP_MAX - SLIDE_DROP_MIN + 1
  const want = SLIDE_DROP_MIN + Math.floor(rng() * span)
  return Math.min(want, stackLen)
}
/** Melee reach (world units). */
export const ATTACK_RANGE = 1.6
/** Half-angle of forward cone (degrees). */
export const ATTACK_CONE_DEG = 55
export const ATTACK_COOLDOWN_MS = 700
/** Mace / slide hit: horizontal knock distance (meters). */
export const KNOCKBACK_DIST = 3.8
/** Client/server knock arc duration. */
export const KNOCKBACK_DURATION_MS = 550

/** Empty-hand slide tackle (铲球). */
export const SLIDE_BASE_DIST = 4.0
/** Each backpack card shortens slide by this fraction of base (clamped). */
export const SLIDE_DIST_PENALTY_PER_CARD = 0.1
/** Minimum slide distance mult (never shorter than this × base). */
export const SLIDE_DIST_MIN_MULT = 0.35
/** Active slide travel time. */
export const SLIDE_DURATION_MS = 300
/** Hard stun after slide stops (hit or miss same). */
export const SLIDE_RECOVER_MS = 300
/** Cooldown between slides (from slide start). */
export const SLIDE_COOLDOWN_MS = 5000
/** Hit radius along slide segment (meters). */
export const SLIDE_HIT_RADIUS = 0.95
