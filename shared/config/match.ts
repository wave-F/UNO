/** Round rules (server + client display). */

/** Match length: 2 minutes. */
export const MATCH_DURATION_MS = 2 * 60 * 1000

/**
 * First player to deliver this many cards to their home wins immediately.
 * (Score = home pile count, not backpack.)
 */
export const MATCH_WIN_SCORE = 50

/**
 * When a player first reaches (WIN - this) home cards, fire one-time UNO moment.
 * e.g. win=50, remain=10 → announce at score >= 40（还差 10 张）。
 */
export const MATCH_UNO_REMAINING = 10
