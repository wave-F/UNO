import {
  DEV_QUICK_ROOM_CODE,
  POSE_SEND_HZ,
  PROTOCOL_VERSION,
  type ClientMessage,
  type GroundCardWire,
  type PlayerPose,
  type PublicPlayer,
  type RoomPhase,
  type PlacedTrapWire,
  type ScoreEntry,
  type ServerMessage,
} from '../../shared/protocol'
import type { UnoCardData } from '../../shared/uno/types'

export type NetStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'in_room'
  | 'error'

export type NetClientEvents = {
  status: (status: NetStatus, detail?: string) => void
  welcome: (info: {
    playerId: string
    sessionToken: string
    players: PublicPlayer[]
    roomId: string
    roomCode: string
    hostId: string
    phase: RoomPhase
    groundCards: GroundCardWire[]
    yourStack: UnoCardData[]
    yourScore: number
    yourItem: UnoCardData | null
    scores: ScoreEntry[]
    playerStacks: { playerId: string; stack: UnoCardData[] }[]
    traps: PlacedTrapWire[]
    matchEndsAt?: number
    winScore?: number
    dummyActive?: boolean
  }) => void
  dummyState: (active: boolean) => void
  roomState: (info: {
    roomCode: string
    hostId: string
    phase: RoomPhase
    players: PublicPlayer[]
  }) => void
  matchStart: (
    groundCards: GroundCardWire[],
    scores: ScoreEntry[],
    homes: { playerId: string; homeIndex: number }[],
    meta: { endsAt: number; winScore: number; durationMs: number },
  ) => void
  matchEnd: (info: {
    reason: 'score' | 'timeout'
    winners: ScoreEntry[]
    scores: ScoreEntry[]
    winScore: number
    message: string
  }) => void
  unoMoment: (info: {
    playerId: string
    playerName: string
    score: number
    remaining: number
    winScore: number
    message: string
  }) => void
  playerJoined: (player: PublicPlayer) => void
  playerLeft: (playerId: string, reason: string) => void
  playerReconnected: (playerId: string) => void
  worldState: (t: number, poses: PlayerPose[]) => void
  cardsSpawned: (
    cards: GroundCardWire[],
    burstFrom?: { x: number; y: number; z: number },
  ) => void
  groundSnapshot: (cards: GroundCardWire[]) => void
  cardPicked: (info: {
    playerId: string
    cardId: string
    card: UnoCardData
    stackCount: number
  }) => void
  cardIllegal: (
    card: UnoCardData,
    top: UnoCardData,
    reason?: 'stack' | 'home_once',
  ) => void
  clearIllegal: () => void
  deposited: (info: {
    playerId: string
    count: number
    score: number
    cards: UnoCardData[]
  }) => void
  homeStolen: (info: {
    thiefId: string
    victimId: string
    victimHomeIndex: number
    card: UnoCardData
    thiefStackCount: number
    victimScore: number
  }) => void
  privateState: (
    stack: UnoCardData[],
    score: number,
    item: UnoCardData | null,
  ) => void
  /** Public backpack update for remote avatar HeadCardDisplay. */
  playerStack: (playerId: string, stack: UnoCardData[]) => void
  playerItem: (playerId: string, item: UnoCardData | null) => void
  scores: (scores: ScoreEntry[]) => void
  playerStunned: (playerId: string, until: number, durationMs: number) => void
  attackHit: (
    attackerId: string,
    victimId: string,
    dropped: number,
    knock?: {
      fromX: number
      fromY: number
      fromZ: number
      toX: number
      toY: number
      toZ: number
      durationMs: number
    },
  ) => void
  attackMiss: () => void
  playerSlide: (info: {
    playerId: string
    fromX: number
    fromY: number
    fromZ: number
    toX: number
    toY: number
    toZ: number
    durationMs: number
    recoverMs: number
    hitVictimId: string | null
  }) => void
  trapPlaced: (trap: PlacedTrapWire) => void
  trapRemoved: (trapId: string, reason: 'triggered' | 'cleared') => void
  trapTriggered: (info: {
    trapId: string
    ownerId: string
    victimId: string
  }) => void
  homeFences: (active: number[]) => void
  playerDied: (info: {
    playerId: string
    fenceHomeIndex: number
    until: number
    durationMs: number
  }) => void
  playerRespawned: (info: {
    playerId: string
    x: number
    y: number
    z: number
  }) => void
  error: (code: string, message: string) => void
  pong: (rttMs: number) => void
}

type HandlerMap = {
  [K in keyof NetClientEvents]?: NetClientEvents[K][]
}

const SESSION_KEY = 'bean-guys-session-token'

export class NetClient {
  private ws: WebSocket | null = null
  private handlers: HandlerMap = {}
  private _status: NetStatus = 'disconnected'
  private _playerId: string | null = null
  private _players: PublicPlayer[] = []
  private _roomCode: string | null = null
  private _hostId: string | null = null
  private _phase: RoomPhase = 'lobby'
  private pingTimer: number | null = null
  private lastPingSentAt = 0
  private poseSeq = 0
  private poseAcc = 0
  private readonly poseInterval = 1 / POSE_SEND_HZ
  private pendingAction:
    | { kind: 'create' }
    | { kind: 'join'; code: string }
    | { kind: 'join_or_create'; code: string }
    | null = null
  private pendingName = 'Player'

  get status(): NetStatus {
    return this._status
  }

  get playerId(): string | null {
    return this._playerId
  }

  get players(): readonly PublicPlayer[] {
    return this._players
  }

  get roomCode(): string | null {
    return this._roomCode
  }

  get hostId(): string | null {
    return this._hostId
  }

  get phase(): RoomPhase {
    return this._phase
  }

  get isHost(): boolean {
    return !!this._playerId && this._playerId === this._hostId
  }

  get isInRoom(): boolean {
    return this._status === 'in_room' && this._playerId !== null
  }

  get isPlaying(): boolean {
    return this.isInRoom && this._phase === 'playing'
  }

  on<K extends keyof NetClientEvents>(event: K, fn: NetClientEvents[K]): () => void {
    const list = (this.handlers[event] ??= []) as NetClientEvents[K][]
    list.push(fn)
    return () => {
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    }
  }

  /** Connect then create a room (you become host). */
  createRoom(wsUrl: string, name: string): void {
    this.pendingName = name.trim().slice(0, 16) || 'Player'
    this.pendingAction = { kind: 'create' }
    this.open(wsUrl)
  }

  /** Connect then join by room code. */
  joinRoom(wsUrl: string, name: string, roomCode: string): void {
    this.pendingName = name.trim().slice(0, 16) || 'Player'
    const digits = roomCode.replace(/\D/g, '').padStart(4, '0').slice(-4)
    this.pendingAction = { kind: 'join', code: digits }
    this.open(wsUrl)
  }

  /**
   * Local dual-client test: join fixed room (default 0000), create if missing.
   * First browser becomes host; second joins — no room code typing.
   */
  quickTestJoin(wsUrl: string, name: string, roomCode = DEV_QUICK_ROOM_CODE): void {
    this.pendingName = name.trim().slice(0, 16) || 'Player'
    const digits = roomCode.replace(/\D/g, '').padStart(4, '0').slice(-4)
    this.pendingAction = { kind: 'join_or_create', code: digits }
    this.open(wsUrl)
  }

  setReady(ready: boolean): void {
    this.send({ type: 'set_ready', ready })
  }

  startGame(): void {
    this.send({ type: 'start_game' })
  }

  addBot(): void {
    this.send({ type: 'add_bot' })
  }

  removeBot(): void {
    this.send({ type: 'remove_bot' })
  }

  /** Melee attack (stun bat) / place skip. yaw = facing. */
  attack(yaw: number): void {
    if (!this.isPlaying) return
    this.send({ type: 'attack', yaw })
  }

  /** Empty-hand slide tackle. */
  slide(yaw: number): void {
    if (!this.isPlaying) return
    this.send({ type: 'slide', yaw })
  }

  /** Drop hand item onto ground in front. */
  discardItem(yaw: number): void {
    if (!this.isPlaying) return
    this.send({ type: 'discard_item', yaw })
  }

  /** Dev/test: put stun bat or skip into hand. */
  debugGiveItem(kind: 'stun_bat' | 'skip_trap'): void {
    if (!this.isPlaying) return
    this.send({ type: 'debug_give_item', kind })
  }

  /** Dev/test: fully spawn/despawn training dummy on server. */
  debugSetDummy(active: boolean): void {
    if (!this.isPlaying) return
    this.send({ type: 'debug_set_dummy', active })
  }

  leaveRoom(): void {
    this.send({ type: 'leave_room' })
    this.resetRoomState()
    this.setStatus('connected')
  }

  disconnect(): void {
    this.stopPing()
    this.pendingAction = null
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.resetRoomState()
    this.setStatus('disconnected')
  }

  tickPose(dt: number, pose: { x: number; y: number; z: number; yaw: number }): void {
    if (!this.isPlaying) return
    this.poseAcc += dt
    if (this.poseAcc < this.poseInterval) return
    this.poseAcc = 0
    this.poseSeq += 1
    this.send({
      type: 'pose',
      seq: this.poseSeq,
      x: pose.x,
      y: pose.y,
      z: pose.z,
      yaw: pose.yaw,
    })
  }

  private open(wsUrl: string): void {
    // Reuse open socket if already connected
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.dispatchPending()
      return
    }
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      return
    }

    this.disconnectSoft()
    this.setStatus('connecting')

    let url = normalizeWsUrl(wsUrl)
    if (!url) {
      this.setStatus('error', 'WebSocket 地址为空')
      return
    }

    try {
      this.ws = new WebSocket(url)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/insecure WebSocket|SecurityError/i.test(msg) || msg.includes('HTTPS')) {
        this.setStatus(
          'error',
          'HTTPS 页面不能使用 ws://。请点「单机游玩」，或部署带 TLS 的 wss:// 联机服',
        )
      } else {
        this.setStatus('error', msg)
      }
      return
    }

    this.ws.addEventListener('open', () => {
      this.setStatus('connected')
      this.startPing()
      this.dispatchPending()
    })

    this.ws.addEventListener('message', (ev) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage
      } catch {
        this.emit('error', 'bad_message', '无法解析服务器消息')
        return
      }
      this.handleServer(msg)
    })

    this.ws.addEventListener('close', () => {
      this.stopPing()
      this.ws = null
      this.resetRoomState()
      this.setStatus('disconnected')
    })

    this.ws.addEventListener('error', () => {
      const onHttps = typeof window !== 'undefined' && window.location.protocol === 'https:'
      this.setStatus(
        'error',
        onHttps
          ? '联机连接失败。静态 HTTPS 站默认无 wss 服：请用「单机游玩」，或配置可达的 wss:// 地址'
          : 'WebSocket 连接失败（检查本机是否 npm run server）',
      )
    })
  }

  private disconnectSoft(): void {
    this.stopPing()
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
  }

  private dispatchPending(): void {
    const name = this.pendingName
    const action = this.pendingAction
    this.pendingAction = null
    if (!action) return
    if (action.kind === 'create') {
      this.send({
        type: 'create_room',
        name,
        protocolVersion: PROTOCOL_VERSION,
      })
    } else if (action.kind === 'join_or_create') {
      this.send({
        type: 'join_or_create',
        roomCode: action.code,
        name,
        protocolVersion: PROTOCOL_VERSION,
      })
    } else {
      const sessionToken = localStorage.getItem(SESSION_KEY) ?? undefined
      this.send({
        type: 'join_room',
        roomCode: action.code,
        name,
        protocolVersion: PROTOCOL_VERSION,
        sessionToken,
      })
    }
  }

  private handleServer(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        this._playerId = msg.playerId
        this._players = msg.players
        this._roomCode = msg.roomCode
        this._hostId = msg.hostId
        this._phase = msg.phase
        localStorage.setItem(SESSION_KEY, msg.sessionToken)
        this.setStatus('in_room')
        this.emit('welcome', {
          playerId: msg.playerId,
          sessionToken: msg.sessionToken,
          players: msg.players,
          roomId: msg.roomId,
          roomCode: msg.roomCode,
          hostId: msg.hostId,
          phase: msg.phase,
          groundCards: msg.groundCards,
          yourStack: msg.yourStack,
          yourScore: msg.yourScore,
          yourItem: msg.yourItem ?? null,
          scores: msg.scores,
          playerStacks: msg.playerStacks ?? [],
          traps: msg.traps ?? [],
          matchEndsAt: msg.matchEndsAt,
          winScore: msg.winScore,
          dummyActive: msg.dummyActive,
        })
        this.emit('roomState', {
          roomCode: msg.roomCode,
          hostId: msg.hostId,
          phase: msg.phase,
          players: msg.players,
        })
        if (msg.scores.length) this.emit('scores', msg.scores)
        if (msg.playerStacks?.length) {
          for (const e of msg.playerStacks) {
            this.emit('playerStack', e.playerId, e.stack)
          }
        }
        break
      case 'room_state':
        this._players = msg.players
        this._roomCode = msg.roomCode
        this._hostId = msg.hostId
        this._phase = msg.phase
        this.emit('roomState', {
          roomCode: msg.roomCode,
          hostId: msg.hostId,
          phase: msg.phase,
          players: msg.players,
        })
        break
      case 'match_start':
        this._phase = 'playing'
        this.poseSeq = 0
        this.poseAcc = 0
        this.emit(
          'matchStart',
          msg.groundCards,
          msg.scores,
          msg.homes ?? [],
          {
            endsAt: msg.endsAt,
            winScore: msg.winScore,
            durationMs: msg.durationMs,
          },
        )
        this.emit('scores', msg.scores)
        break
      case 'match_end':
        this._phase = 'lobby'
        this.emit('matchEnd', {
          reason: msg.reason,
          winners: msg.winners,
          scores: msg.scores,
          winScore: msg.winScore,
          message: msg.message,
        })
        break
      case 'uno_moment':
        this.emit('unoMoment', {
          playerId: msg.playerId,
          playerName: msg.playerName,
          score: msg.score,
          remaining: msg.remaining,
          winScore: msg.winScore,
          message: msg.message,
        })
        break
      case 'dummy_state':
        this.emit('dummyState', !!msg.active)
        break
      case 'player_joined':
        this.emit('playerJoined', msg.player)
        break
      case 'player_left':
        this.emit('playerLeft', msg.playerId, msg.reason)
        break
      case 'player_reconnected':
        this.emit('playerReconnected', msg.playerId)
        break
      case 'world_state':
        this.emit('worldState', msg.t, msg.poses)
        break
      case 'cards_spawned':
        this.emit('cardsSpawned', msg.cards, msg.burstFrom)
        break
      case 'ground_snapshot':
        this.emit('groundSnapshot', msg.cards)
        break
      case 'card_picked':
        this.emit('cardPicked', {
          playerId: msg.playerId,
          cardId: msg.cardId,
          card: msg.card,
          stackCount: msg.stackCount,
        })
        break
      case 'card_illegal':
        this.emit('cardIllegal', msg.card, msg.top, msg.reason)
        break
      case 'clear_illegal':
        this.emit('clearIllegal')
        break
      case 'deposited':
        this.emit('deposited', {
          playerId: msg.playerId,
          count: msg.count,
          score: msg.score,
          cards: msg.cards,
        })
        break
      case 'home_stolen':
        this.emit('homeStolen', {
          thiefId: msg.thiefId,
          victimId: msg.victimId,
          victimHomeIndex: msg.victimHomeIndex,
          card: msg.card,
          thiefStackCount: msg.thiefStackCount,
          victimScore: msg.victimScore,
        })
        break
      case 'private_state':
        this.emit('privateState', msg.stack, msg.score, msg.item ?? null)
        break
      case 'player_stack':
        this.emit('playerStack', msg.playerId, msg.stack)
        break
      case 'player_item':
        this.emit('playerItem', msg.playerId, msg.item)
        break
      case 'scores':
        this.emit('scores', msg.scores)
        break
      case 'player_stunned':
        this.emit('playerStunned', msg.playerId, msg.until, msg.durationMs)
        break
      case 'attack_hit':
        this.emit('attackHit', msg.attackerId, msg.victimId, msg.dropped, msg.knock)
        break
      case 'attack_miss':
        this.emit('attackMiss')
        break
      case 'player_slide':
        this.emit('playerSlide', {
          playerId: msg.playerId,
          fromX: msg.fromX,
          fromY: msg.fromY,
          fromZ: msg.fromZ,
          toX: msg.toX,
          toY: msg.toY,
          toZ: msg.toZ,
          durationMs: msg.durationMs,
          recoverMs: msg.recoverMs,
          hitVictimId: msg.hitVictimId,
        })
        break
      case 'trap_placed':
        this.emit('trapPlaced', msg.trap)
        break
      case 'trap_removed':
        this.emit('trapRemoved', msg.trapId, msg.reason)
        break
      case 'trap_triggered':
        this.emit('trapTriggered', {
          trapId: msg.trapId,
          ownerId: msg.ownerId,
          victimId: msg.victimId,
        })
        break
      case 'home_fences':
        this.emit('homeFences', msg.active)
        break
      case 'player_died':
        this.emit('playerDied', {
          playerId: msg.playerId,
          fenceHomeIndex: msg.fenceHomeIndex,
          until: msg.until,
          durationMs: msg.durationMs,
        })
        break
      case 'player_respawned':
        this.emit('playerRespawned', {
          playerId: msg.playerId,
          x: msg.x,
          y: msg.y,
          z: msg.z,
        })
        break
      case 'pong': {
        const rtt =
          this.lastPingSentAt > 0
            ? performance.now() - this.lastPingSentAt
            : Math.max(0, Date.now() - msg.t)
        this.emit('pong', Math.max(0, rtt))
        break
      }
      case 'error':
        this.emit('error', msg.code, msg.message)
        if (
          msg.code === 'bad_protocol' ||
          msg.code === 'server_full' ||
          msg.code === 'room_not_found'
        ) {
          this.setStatus('error', msg.message)
        }
        break
    }
  }

  private resetRoomState(): void {
    this._playerId = null
    this._players = []
    this._roomCode = null
    this._hostId = null
    this._phase = 'lobby'
    this.poseSeq = 0
    this.poseAcc = 0
  }

  private send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(msg))
  }

  private startPing(): void {
    this.stopPing()
    const sendPing = (): void => {
      this.lastPingSentAt = performance.now()
      this.send({ type: 'ping', t: Date.now() })
    }
    sendPing()
    this.pingTimer = window.setInterval(sendPing, 5000)
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private setStatus(status: NetStatus, detail?: string): void {
    this._status = status
    this.emit('status', status, detail)
  }

  private emit<K extends keyof NetClientEvents>(
    event: K,
    ...args: Parameters<NetClientEvents[K]>
  ): void {
    const list = this.handlers[event] as NetClientEvents[K][] | undefined
    if (!list) return
    for (const fn of list) {
      ;(fn as (...a: Parameters<NetClientEvents[K]>) => void)(...args)
    }
  }
}

/**
 * Prefer same security as the page: HTTPS → wss, HTTP → ws.
 * Browser blocks ws:// from HTTPS pages (mixed content / SecurityError).
 */
export function defaultWsUrl(port = 8787): string {
  const host = window.location.hostname || '127.0.0.1'
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${host}:${port}`
}

/** Normalize http(s) → ws(s); force wss when the page itself is HTTPS. */
export function normalizeWsUrl(raw: string): string {
  let url = raw.trim()
  if (!url) return url
  if (url.startsWith('http://')) url = 'ws://' + url.slice('http://'.length)
  if (url.startsWith('https://')) url = 'wss://' + url.slice('https://'.length)
  url = url.replace(/\/$/, '')
  // HTTPS document cannot open insecure WebSocket
  if (
    typeof window !== 'undefined' &&
    window.location.protocol === 'https:' &&
    url.startsWith('ws://')
  ) {
    url = 'wss://' + url.slice('ws://'.length)
  }
  return url
}
