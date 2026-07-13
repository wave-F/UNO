import { randomBytes } from 'node:crypto'
import type { WebSocket } from 'ws'
import {
  DEV_QUICK_ROOM_CODE,
  MAX_PLAYERS,
  MAX_POSE_SPEED,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  WORLD_STATE_HZ,
  type ClientMessage,
  type GroundCardWire,
  type PlayerPose,
  type PublicPlayer,
  type RoomPhase,
  type ScoreEntry,
  type ServerMessage,
} from '../shared/protocol.ts'
import { getHomeSlot, HOME_SLOT_COUNT } from '../shared/config/home.ts'
import {
  TRAINING_DUMMY_ID,
  TRAINING_DUMMY_Y,
} from '../shared/config/dummy.ts'
import { BOT_HOME_STAND_Y, BotController } from './Bot.ts'
import { GameSim, type GroundCard } from './GameSim.ts'

export type Seat = {
  id: string
  name: string
  sessionToken: string
  ws: WebSocket | null
  connected: boolean
  ready: boolean
  isBot: boolean
  /** Fixed corner 0–3 for this seat (join order). */
  homeIndex: number
  graceTimer: ReturnType<typeof setTimeout> | null
  msgCount: number
  msgWindowStart: number
  pose: { x: number; y: number; z: number; yaw: number; seq: number } | null
  lastPoseAt: number
}

const RATE_LIMIT_MAX = 60
const RATE_LIMIT_WINDOW_MS = 1000
const ARENA = 22

function newId(): string {
  return randomBytes(8).toString('hex')
}

export function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function finiteNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

function toWire(g: GroundCard): GroundCardWire {
  return { card: g.card, x: g.x, y: g.y, z: g.z }
}

export class Room {
  readonly code: string
  readonly id: string
  hostId: string
  phase: RoomPhase = 'lobby'
  private seats = new Map<string, Seat>()
  private tokenIndex = new Map<string, string>()
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private lastTickAt = Date.now()
  private readonly game: GameSim
  private bots = new Map<string, BotController>()
  private botSerial = 0
  /** Called when room has no seats left. */
  onEmpty: (() => void) | null = null

  constructor(code: string, hostId: string) {
    this.code = code
    this.id = code
    this.hostId = hostId
    this.game = new GameSim({
      onSpawn: (cards, opts) => {
        this.broadcast({
          type: 'cards_spawned',
          cards: cards.map(toWire),
          burstFrom: opts?.burstFrom,
        })
      },
      onPicked: (info) => {
        this.broadcast({
          type: 'card_picked',
          playerId: info.playerId,
          cardId: info.groundCardId,
          card: info.card,
          stackCount: info.stackCount,
        })
      },
      onIllegal: (playerId, card, top, reason) => {
        this.sendTo(playerId, { type: 'card_illegal', card, top, reason })
      },
      onClearIllegal: (playerId) => {
        this.sendTo(playerId, { type: 'clear_illegal' })
      },
      onDeposited: (info) => {
        this.broadcast({
          type: 'deposited',
          playerId: info.playerId,
          count: info.cards.length,
          score: info.score,
          cards: info.cards,
        })
      },
      onHomeStolen: (info) => {
        this.broadcast({
          type: 'home_stolen',
          thiefId: info.thiefId,
          victimId: info.victimId,
          victimHomeIndex: info.victimHomeIndex,
          card: info.card,
          thiefStackCount: info.thiefStackCount,
          victimScore: info.victimScore,
        })
      },
      onPrivateState: (playerId, stack, score, item) => {
        this.sendTo(playerId, { type: 'private_state', stack, score, item })
        // Everyone sees backpack cards on avatars (same as local HeadCardDisplay)
        this.broadcast({ type: 'player_stack', playerId, stack })
        this.broadcast({ type: 'player_item', playerId, item })
      },
      onScores: (scores) => {
        this.broadcast({ type: 'scores', scores: this.enrichScores(scores) })
      },
      onStunned: (playerId, until, durationMs) => {
        this.broadcast({ type: 'player_stunned', playerId, until, durationMs })
      },
      onAttackHit: (attackerId, victimId, dropped) => {
        this.broadcast({ type: 'attack_hit', attackerId, victimId, dropped })
      },
      onAttackMiss: (attackerId) => {
        this.sendTo(attackerId, { type: 'attack_miss', attackerId })
      },
      onGroundSnapshot: (cards) => {
        this.broadcast({
          type: 'ground_snapshot',
          cards: cards.map(toWire),
        })
      },
    })
  }

  get seatCount(): number {
    return this.seats.size
  }

  listPlayers(): PublicPlayer[] {
    return [...this.seats.values()].map((s) => ({
      id: s.id,
      name: s.name,
      connected: s.connected,
      ready: s.ready,
      isHost: s.id === this.hostId,
      homeIndex: s.homeIndex,
      isBot: s.isBot,
    }))
  }

  botCount(): number {
    return this.bots.size
  }

  /** Host adds a server-side AI seat. */
  addBot(requesterId: string): { ok: true; seat: Seat } | { error: ServerMessage } {
    if (requesterId !== this.hostId) {
      return {
        error: { type: 'error', code: 'not_host', message: '只有房主可以添加机器人' },
      }
    }
    if (this.seats.size >= MAX_PLAYERS) {
      return {
        error: {
          type: 'error',
          code: 'room_full',
          message: `房间已满（${MAX_PLAYERS} 人）`,
        },
      }
    }
    this.botSerial += 1
    const seat = this.addSeat(null, `Bot${this.botSerial}`, false, true)
    this.bots.set(seat.id, new BotController(seat.id))

    if (this.phase === 'playing') {
      this.game.addPlayer(seat.id, seat.homeIndex)
      const sp = getHomeSlot(seat.homeIndex).spawn
      seat.pose = { x: sp.x, y: BOT_HOME_STAND_Y, z: sp.z, yaw: 0, seq: 0 }
      seat.lastPoseAt = 0
      this.ensureTick()
    }

    this.broadcast({
      type: 'player_joined',
      player: {
        id: seat.id,
        name: seat.name,
        connected: true,
        ready: true,
        isHost: false,
        homeIndex: seat.homeIndex,
        isBot: true,
      },
    })
    this.broadcastRoomState()
    return { ok: true, seat }
  }

  /** Host removes one bot (most recently added). */
  removeBot(requesterId: string): { ok: true } | { error: ServerMessage } {
    if (requesterId !== this.hostId) {
      return {
        error: { type: 'error', code: 'not_host', message: '只有房主可以移除机器人' },
      }
    }
    const botIds = [...this.bots.keys()]
    if (!botIds.length) {
      return {
        error: { type: 'error', code: 'bad_message', message: '没有可移除的机器人' },
      }
    }
    const id = botIds[botIds.length - 1]!
    this.removeSeat(id, 'kicked')
    return { ok: true }
  }

  findSeatByToken(token: string): Seat | undefined {
    const id = this.tokenIndex.get(token)
    return id ? this.seats.get(id) : undefined
  }

  findSeatByWs(ws: WebSocket): Seat | undefined {
    for (const s of this.seats.values()) {
      if (s.ws === ws) return s
    }
    return undefined
  }

  /** Create host seat (room just created). */
  addHost(ws: WebSocket, name: string): Seat {
    return this.addSeat(ws, name, true)
  }

  tryAddPlayer(
    ws: WebSocket,
    name: string,
    opts?: { allowDuringPlay?: boolean },
  ): Seat | { error: ServerMessage } {
    const allowDuringPlay =
      opts?.allowDuringPlay === true || this.code === DEV_QUICK_ROOM_CODE
    if (this.phase === 'playing' && !allowDuringPlay) {
      return {
        error: {
          type: 'error',
          code: 'room_playing',
          message: '对局已开始，无法加入',
        },
      }
    }
    if (this.seats.size >= MAX_PLAYERS) {
      return {
        error: {
          type: 'error',
          code: 'room_full',
          message: `房间已满（${MAX_PLAYERS} 人）`,
        },
      }
    }
    return this.addSeat(ws, name, false)
  }

  /**
   * Late-join into an already running match (dev quick room).
   * Registers player in GameSim and places them at home spawn.
   */
  admitToRunningMatch(seatId: string): void {
    if (this.phase !== 'playing') return
    const seat = this.seats.get(seatId)
    if (!seat) return
    this.game.addPlayer(seat.id, seat.homeIndex)
    const sp = getHomeSlot(seat.homeIndex).spawn
    const y = seat.isBot ? BOT_HOME_STAND_Y : sp.y
    seat.pose = { x: sp.x, y, z: sp.z, yaw: 0, seq: 0 }
    seat.lastPoseAt = 0
    this.ensureTick()
  }

  /** Auto-start without host check (used by local dual-client test room). */
  forceStartMatch(): { ok: true } | { error: ServerMessage } {
    if (this.phase === 'playing') return { ok: true }
    return this.startGame(this.hostId, { skipHostCheck: true })
  }

  reconnectSeat(seat: Seat, ws: WebSocket, name: string): void {
    if (seat.graceTimer) {
      clearTimeout(seat.graceTimer)
      seat.graceTimer = null
    }
    if (seat.ws && seat.ws !== ws) {
      try {
        seat.ws.close()
      } catch {
        /* ignore */
      }
    }
    seat.ws = ws
    seat.connected = true
    seat.name = name
  }

  sendWelcome(ws: WebSocket, seat: Seat): void {
    const st = this.game.getPlayerState(seat.id)
    const playing = this.phase === 'playing'
    // Reconnect hygiene: drop leftover stun piles so refresh feels clean for testing
    if (playing) {
      this.game.clearStunDropCards()
    }
    send(ws, {
      type: 'welcome',
      playerId: seat.id,
      sessionToken: seat.sessionToken,
      protocolVersion: PROTOCOL_VERSION,
      players: this.listPlayers(),
      roomCode: this.code,
      roomId: this.id,
      hostId: this.hostId,
      phase: this.phase,
      groundCards: playing ? this.game.getGroundSnapshot().map(toWire) : [],
      yourStack: playing && st ? [...st.stack] : [],
      yourScore: playing && st ? st.score : 0,
      yourItem: playing && st ? st.item : null,
      scores: playing ? this.enrichScores(this.game.getScores()) : [],
      playerStacks: playing ? this.game.getAllStacks() : [],
    })
  }

  setReady(seatId: string, ready: boolean): void {
    if (this.phase !== 'lobby') return
    const seat = this.seats.get(seatId)
    if (!seat) return
    seat.ready = ready
    this.broadcastRoomState()
  }

  startGame(
    hostSeatId: string,
    opts?: { skipHostCheck?: boolean },
  ): { ok: true } | { error: ServerMessage } {
    if (this.phase !== 'lobby') {
      return {
        error: { type: 'error', code: 'bad_message', message: '已在对局中' },
      }
    }
    if (!opts?.skipHostCheck && hostSeatId !== this.hostId) {
      return {
        error: { type: 'error', code: 'not_host', message: '只有房主可以开始游戏' },
      }
    }
    const connected = [...this.seats.values()].filter((s) => s.connected)
    if (connected.length < 1) {
      return {
        error: { type: 'error', code: 'not_ready', message: '至少需要 1 名玩家' },
      }
    }

    this.phase = 'playing'
    this.game.resetMatch()
    const homes: { playerId: string; homeIndex: number }[] = []
    for (const s of this.seats.values()) {
      // Re-assert slot in case of any stale state
      if (s.homeIndex < 0 || s.homeIndex >= HOME_SLOT_COUNT) {
        s.homeIndex = this.allocHomeIndex()
      }
      this.game.addPlayer(s.id, s.homeIndex)
      // Start each player at their corner home (before first pose)
      const sp = getHomeSlot(s.homeIndex).spawn
      // Bots have no gravity — use standing height, not fall-in spawn Y (2.2)
      const y = s.isBot ? BOT_HOME_STAND_Y : sp.y
      s.pose = { x: sp.x, y, z: sp.z, yaw: 0, seq: 0 }
      // lastPoseAt=0 → first client pose after start is not speed-clamped
      // (allows snap to correct home if client was still at default SW spawn)
      s.lastPoseAt = 0
      homes.push({ playerId: s.id, homeIndex: s.homeIndex })
    }
    this.game.startMatch()
    this.ensureTick()

    const ground = this.game.getGroundSnapshot().map(toWire)
    const scores = this.enrichScores(this.game.getScores())
    this.broadcast({ type: 'match_start', groundCards: ground, scores, homes })
    this.broadcastRoomState()

    // Sync private empty stacks
    for (const s of this.seats.values()) {
      if (s.connected) {
        this.sendTo(s.id, {
          type: 'private_state',
          stack: [],
          score: 0,
          item: null,
        })
      }
    }
    // After clients enter match: fill dummy backpack (broadcasts player_stack)
    this.game.refillTrainingDummy()
    return { ok: true }
  }

  handleAttack(seatId: string, yaw: number): void {
    if (this.phase !== 'playing') return
    if (this.game.isStunned(seatId)) return
    const poses = new Map<string, { x: number; y: number; z: number }>()
    for (const s of this.seats.values()) {
      if (!s.connected || !s.pose) continue
      poses.set(s.id, { x: s.pose.x, y: s.pose.y, z: s.pose.z })
    }
    // Must include training dummy — it is not a seat
    poses.set(TRAINING_DUMMY_ID, {
      x: 0,
      y: TRAINING_DUMMY_Y,
      z: 0,
    })
    this.game.tryAttack(seatId, yaw, poses)
  }

  handlePose(seatId: string, msg: Extract<ClientMessage, { type: 'pose' }>): void {
    if (this.phase !== 'playing') return
    const seat = this.seats.get(seatId)
    if (!seat || !seat.connected) return
    if (this.game.isStunned(seatId)) return

    if (
      !finiteNum(msg.x) ||
      !finiteNum(msg.y) ||
      !finiteNum(msg.z) ||
      !finiteNum(msg.yaw) ||
      !finiteNum(msg.seq)
    ) {
      return
    }
    if (seat.pose && msg.seq <= seat.pose.seq) return

    let x = Math.max(-ARENA, Math.min(ARENA, msg.x))
    let y = Math.max(0, Math.min(40, msg.y))
    let z = Math.max(-ARENA, Math.min(ARENA, msg.z))
    const yaw = msg.yaw
    const now = Date.now()

    if (seat.pose && seat.lastPoseAt > 0) {
      const dt = (now - seat.lastPoseAt) / 1000
      if (dt > 0 && dt < 1) {
        const dist = Math.hypot(x - seat.pose.x, z - seat.pose.z)
        const maxDist = MAX_POSE_SPEED * dt + 0.5
        // Allow a one-shot snap onto own home spawn (match start teleport)
        const home = getHomeSlot(seat.homeIndex).spawn
        const nearOwnHome = Math.hypot(x - home.x, z - home.z) < 1.25
        if (dist > maxDist && !nearOwnHome) {
          const s = maxDist / dist
          x = seat.pose.x + (x - seat.pose.x) * s
          z = seat.pose.z + (z - seat.pose.z) * s
        }
      }
    }

    seat.pose = { x, y, z, yaw, seq: msg.seq }
    seat.lastPoseAt = now
    this.game.interactOne(seatId, x, z)
  }

  handleDisconnect(ws: WebSocket): void {
    const seat = this.findSeatByWs(ws)
    if (!seat) return
    seat.ws = null
    seat.connected = false
    if (seat.graceTimer) clearTimeout(seat.graceTimer)
    this.broadcastRoomState()

    seat.graceTimer = setTimeout(() => {
      this.removeSeat(seat.id, 'timeout')
    }, RECONNECT_GRACE_MS)
  }

  leave(seatId: string): void {
    this.removeSeat(seatId, 'left')
  }

  checkRateLimit(seat: Seat): boolean {
    const now = Date.now()
    if (now - seat.msgWindowStart > RATE_LIMIT_WINDOW_MS) {
      seat.msgWindowStart = now
      seat.msgCount = 0
    }
    seat.msgCount += 1
    return seat.msgCount <= RATE_LIMIT_MAX
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  private allocHomeIndex(): number {
    const used = new Set([...this.seats.values()].map((s) => s.homeIndex))
    for (let i = 0; i < HOME_SLOT_COUNT; i++) {
      if (!used.has(i)) return i
    }
    return 0
  }

  private addSeat(
    ws: WebSocket | null,
    name: string,
    asHost: boolean,
    isBot = false,
  ): Seat {
    const id = newId()
    const sessionToken = newId() + newId()
    const homeIndex = this.allocHomeIndex()
    const sp = getHomeSlot(homeIndex).spawn
    const seat: Seat = {
      id,
      name,
      sessionToken,
      ws,
      connected: true,
      ready: asHost || isBot,
      isBot,
      homeIndex,
      graceTimer: null,
      msgCount: 0,
      msgWindowStart: Date.now(),
      pose: {
        x: sp.x,
        y: isBot ? BOT_HOME_STAND_Y : sp.y,
        z: sp.z,
        yaw: 0,
        seq: 0,
      },
      lastPoseAt: Date.now(),
    }
    this.seats.set(id, seat)
    if (!isBot) this.tokenIndex.set(sessionToken, id)
    if (asHost) this.hostId = id
    return seat
  }

  private removeSeat(seatId: string, reason: 'left' | 'timeout' | 'kicked'): void {
    const seat = this.seats.get(seatId)
    if (!seat) return
    if (seat.graceTimer) clearTimeout(seat.graceTimer)

    if (this.phase === 'playing') {
      const drop = seat.pose ? { x: seat.pose.x, z: seat.pose.z } : { x: 0, z: 0 }
      this.game.removePlayer(seatId, drop)
    }

    this.bots.delete(seatId)
    this.tokenIndex.delete(seat.sessionToken)
    this.seats.delete(seatId)
    this.broadcast({ type: 'player_left', playerId: seatId, reason })

    // Host migration: prefer humans
    if (seatId === this.hostId && this.seats.size > 0) {
      const next =
        [...this.seats.values()].find((s) => s.connected && !s.isBot) ??
        [...this.seats.values()].find((s) => s.connected) ??
        [...this.seats.values()][0]
      if (next) {
        this.hostId = next.id
        next.ready = true
      }
    }

    // No humans left → clear bots and dissolve
    const humans = [...this.seats.values()].filter((s) => !s.isBot)
    if (humans.length === 0 && this.seats.size > 0) {
      for (const id of [...this.bots.keys()]) {
        this.bots.delete(id)
        const b = this.seats.get(id)
        if (b && this.phase === 'playing') {
          this.game.removePlayer(id, b.pose ? { x: b.pose.x, z: b.pose.z } : null)
        }
        this.seats.delete(id)
        this.broadcast({ type: 'player_left', playerId: id, reason: 'kicked' })
      }
    }

    this.broadcastRoomState()

    if (this.seats.size === 0) {
      this.stop()
      this.onEmpty?.()
    }
  }

  private ensureTick(): void {
    if (this.tickTimer) return
    const ms = Math.round(1000 / WORLD_STATE_HZ)
    this.lastTickAt = Date.now()
    this.tickTimer = setInterval(() => this.tick(), ms)
  }

  private tick(): void {
    if (this.phase !== 'playing') return
    const now = Date.now()
    const dt = Math.min(0.25, (now - this.lastTickAt) / 1000)
    this.lastTickAt = now

    // Snapshot poses first (bots update this map as they move / attack)
    const poses = new Map<string, { x: number; y: number; z: number }>()
    for (const s of this.seats.values()) {
      if (!s.connected || !s.pose) continue
      poses.set(s.id, { x: s.pose.x, y: s.pose.y, z: s.pose.z })
    }
    // Training dummy fixed at arena center (hit target, not a seat)
    poses.set(TRAINING_DUMMY_ID, {
      x: 0,
      y: TRAINING_DUMMY_Y,
      z: 0,
    })

    // Bots move (+ optional stun swing), then sim uses final poses
    for (const [id, bot] of this.bots) {
      const seat = this.seats.get(id)
      if (seat) bot.tick(dt, seat, this.game, poses)
    }

    this.game.tick(dt, poses)

    const list: PlayerPose[] = []
    for (const s of this.seats.values()) {
      if (!s.connected || !s.pose) continue
      // Humans + bots both broadcast for remotes
      list.push({
        id: s.id,
        x: s.pose.x,
        y: s.pose.y,
        z: s.pose.z,
        yaw: s.pose.yaw,
      })
    }
    // Broadcast dummy so clients can sync stun / backpack if needed
    list.push({
      id: TRAINING_DUMMY_ID,
      x: 0,
      y: TRAINING_DUMMY_Y,
      z: 0,
      yaw: 0,
    })
    if (list.length) {
      this.broadcast({ type: 'world_state', t: Date.now(), poses: list })
    }
  }

  broadcastRoomState(): void {
    this.broadcast({
      type: 'room_state',
      roomCode: this.code,
      hostId: this.hostId,
      phase: this.phase,
      players: this.listPlayers(),
    })
  }

  private enrichScores(
    scores: { id: string; score: number; stackCount: number }[],
  ): ScoreEntry[] {
    return scores.map((s) => ({
      ...s,
      name:
        s.id === TRAINING_DUMMY_ID
          ? '木头人'
          : this.seats.get(s.id)?.name,
    }))
  }

  sendTo(playerId: string, msg: ServerMessage): void {
    const seat = this.seats.get(playerId)
    if (!seat?.ws || !seat.connected) return
    send(seat.ws, msg)
  }

  broadcast(msg: ServerMessage, exceptId?: string): void {
    const raw = JSON.stringify(msg)
    for (const s of this.seats.values()) {
      if (!s.connected || !s.ws) continue
      if (exceptId && s.id === exceptId) continue
      if (s.ws.readyState === s.ws.OPEN) s.ws.send(raw)
    }
  }
}
