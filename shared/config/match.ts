/** Round rules (server + client display). */

/** Match length: 2 minutes. */
export const MATCH_DURATION_MS = 2 * 60 * 1000

/**
 * First player to deliver this many cards to their home wins immediately.
 * (Score = home pile count, not backpack.)
 */
export const MATCH_WIN_SCORE = 20

/**
 * When a player first reaches (WIN - this) home cards, fire one-time UNO moment banner.
 * e.g. win=20, remain=5 → announce at score >= 15.
 */
export const MATCH_UNO_REMAINING = 5
