/** Shared LAN multiplayer protocol (client + server). */

import type { UnoCardData } from './uno/types.ts'

/** Phase 5: server-side bots. */
export const PROTOCOL_VERSION = 5

export const DEFAULT_WS_PORT = 8787
export const MAX_PLAYERS = 4
export const MAX_ROOMS = 32
export const RECONNECT_GRACE_MS = 15_000
export const POSE_SEND_HZ = 20
export const WORLD_STATE_HZ = 10
export const MAX_POSE_SPEED = 12

/** Fixed room for local dual-client testing (skip typing codes). */
export const DEV_QUICK_ROOM_CODE = '0000'

export type RoomPhase = 'lobby' | 'playing'

// ── Pose / cards on wire ────────────────────────────────────

export type PlayerPose = {
  id: string
  x: number
  y: number
  z: number
  yaw: number
}

export type GroundCardWire = {
  card: UnoCardData
  x: number
  y: number
  z: number
}

export type ScoreEntry = {
  id: string
  name?: string
  score: number
  stackCount: number
}

/** Public backpack stack for all clients (visible on avatar back). */
export type PlayerStackEntry = {
  playerId: string
  stack: UnoCardData[]
}

// ── Client → Server ─────────────────────────────────────────

export type ClientMessage =
  | {
      type: 'create_room'
      name: string
      protocolVersion: number
    }
  | {
      type: 'join_room'
      roomCode: string
      name: string
      protocolVersion: number
      sessionToken?: string
    }
  | {
      /** Join roomCode if exists (lobby), else create with that code (for dev quick room). */
      type: 'join_or_create'
      roomCode: string
      name: string
      protocolVersion: number
    }
  | {
      type: 'set_ready'
      ready: boolean
    }
  | {
      type: 'start_game'
    }
  | {
      type: 'leave_room'
    }
  | {
      type: 'add_bot'
    }
  | {
      type: 'remove_bot'
    }
  | {
      type: 'ping'
      t: number
    }
  | {
      type: 'pose'
      seq: number
      x: number
      y: number
      z: number
      yaw: number
    }
  | {
      /** Melee swing with top-of-stack item (e.g. stun bat). */
      type: 'attack'
      yaw: number
    }

// ── Server → Client ─────────────────────────────────────────

export type PublicPlayer = {
  id: string
  name: string
  connected: boolean
  ready: boolean
  isHost: boolean
  /** Corner home slot 0–3 (see shared/config/home.ts). */
  homeIndex: number
  /** Server-side AI seat. */
  isBot?: boolean
}

export type ServerMessage =
  | {
      type: 'welcome'
      playerId: string
      sessionToken: string
      protocolVersion: number
      players: PublicPlayer[]
      roomId: string
      roomCode: string
      hostId: string
      phase: RoomPhase
      /** Only meaningful when phase === 'playing' (reconnect mid-match). */
      groundCards: GroundCardWire[]
      yourStack: UnoCardData[]
      yourScore: number
      yourItem: UnoCardData | null
      scores: ScoreEntry[]
      /** Everyone's backpack for remote avatar visuals (incl. self). */
      playerStacks: PlayerStackEntry[]
    }
  | {
      type: 'room_state'
      roomCode: string
      hostId: string
      phase: RoomPhase
      players: PublicPlayer[]
    }
  | {
      type: 'match_start'
      groundCards: GroundCardWire[]
      scores: ScoreEntry[]
      /** Explicit home assignment so clients do not rely on stale roster. */
      homes: { playerId: string; homeIndex: number }[]
    }
  | {
      type: 'player_joined'
      player: PublicPlayer
    }
  | {
      type: 'player_left'
      playerId: string
      reason: 'left' | 'timeout' | 'kicked'
    }
  | {
      type: 'player_reconnected'
      playerId: string
    }
  | {
      type: 'world_state'
      t: number
      poses: PlayerPose[]
    }
  | {
      type: 'cards_spawned'
      cards: GroundCardWire[]
      /** If set, client plays burst fly-out from this point (e.g. stun drop). */
      burstFrom?: { x: number; y: number; z: number }
    }
  | {
      /** Full ground replace — client clears field then spawns these. */
      type: 'ground_snapshot'
      cards: GroundCardWire[]
    }
  | {
      type: 'card_picked'
      playerId: string
      cardId: string
      card: UnoCardData
      stackCount: number
    }
  | {
      type: 'card_illegal'
      card: UnoCardData
      top: UnoCardData
      /** stack = UNO 叠牌失败；home_once = 本趟已从该老家拿过 */
      reason?: 'stack' | 'home_once'
    }
  | {
      /** Stole top card from another player's home pile. */
      type: 'home_stolen'
      thiefId: string
      victimId: string
      victimHomeIndex: number
      card: UnoCardData
      thiefStackCount: number
      victimScore: number
    }
  | {
      type: 'clear_illegal'
    }
  | {
      type: 'deposited'
      playerId: string
      count: number
      score: number
      cards: UnoCardData[]
    }
  | {
      type: 'private_state'
      stack: UnoCardData[]
      score: number
      /** Hand weapon / item (not part of backpack). */
      item: UnoCardData | null
    }
  | {
      /** Public: who is holding a weapon item. */
      type: 'player_item'
      playerId: string
      item: UnoCardData | null
    }
  | {
      /** Broadcast: player backpack changed — update remote avatar cards. */
      type: 'player_stack'
      playerId: string
      stack: UnoCardData[]
    }
  | {
      type: 'scores'
      scores: ScoreEntry[]
    }
  | {
      /** Stun applied / refreshed. until = server epoch ms. */
      type: 'player_stunned'
      playerId: string
      until: number
      durationMs: number
    }
  | {
      type: 'attack_hit'
      attackerId: string
      victimId: string
      dropped: number
    }
  | {
      type: 'attack_miss'
      attackerId: string
    }
  | {
      type: 'pong'
      t: number
      serverTime: number
    }
  | {
      type: 'error'
      code:
        | 'bad_protocol'
        | 'room_full'
        | 'room_not_found'
        | 'room_playing'
        | 'invalid_name'
        | 'not_joined'
        | 'not_host'
        | 'not_ready'
        | 'bad_message'
        | 'rate_limited'
        | 'server_full'
      message: string
    }

export function isClientMessage(data: unknown): data is ClientMessage {
  if (!data || typeof data !== 'object') return false
  const t = (data as { type?: unknown }).type
  return (
    t === 'create_room' ||
    t === 'join_room' ||
    t === 'join_or_create' ||
    t === 'set_ready' ||
    t === 'start_game' ||
    t === 'leave_room' ||
    t === 'add_bot' ||
    t === 'remove_bot' ||
    t === 'ping' ||
    t === 'pose' ||
    t === 'attack'
  )
}
