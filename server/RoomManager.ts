import type { WebSocket } from 'ws'
import {
  DEV_QUICK_ROOM_CODE,
  MAX_ROOMS,
  PROTOCOL_VERSION,
  type ClientMessage,
} from '../shared/protocol.ts'
import { Room, send, type Seat } from './Room.ts'

/** 4-digit room code, zero-padded (e.g. 0427). */
function genCode(): string {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0')
}

type ConnCtx = {
  room: Room | null
  seatId: string | null
}

/**
 * Multi-room host: one WS server, many rooms (each with own host).
 */
export class RoomManager {
  private rooms = new Map<string, Room>()
  private byWs = new Map<WebSocket, ConnCtx>()
  private tokens = new Map<string, { roomCode: string; seatId: string }>()

  listSummary(): { code: string; phase: string; players: number }[] {
    return [...this.rooms.values()].map((r) => ({
      code: r.code,
      phase: r.phase,
      players: r.seatCount,
    }))
  }

  handleConnection(ws: WebSocket): void {
    this.byWs.set(ws, { room: null, seatId: null })

    ws.on('message', (data) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(data))
      } catch {
        send(ws, { type: 'error', code: 'bad_message', message: 'JSON 解析失败' })
        return
      }
      this.handleMessage(ws, parsed as ClientMessage)
    })

    ws.on('close', () => this.handleDisconnect(ws))
    ws.on('error', () => this.handleDisconnect(ws))
  }

  private handleMessage(ws: WebSocket, msg: ClientMessage): void {
    const ctx = this.byWs.get(ws)
    if (!ctx) return

    if (ctx.room && ctx.seatId) {
      const seat = ctx.room.findSeatByWs(ws)
      if (seat && !ctx.room.checkRateLimit(seat)) {
        send(ws, { type: 'error', code: 'rate_limited', message: '发送过于频繁' })
        return
      }
    }

    switch (msg.type) {
      case 'create_room':
        this.createRoom(ws, msg)
        break
      case 'join_room':
        this.joinRoom(ws, msg)
        break
      case 'join_or_create':
        this.joinOrCreate(ws, msg)
        break
      case 'set_ready':
        this.setReady(ws, msg.ready)
        break
      case 'start_game':
        this.startGame(ws)
        break
      case 'leave_room':
        this.leaveRoom(ws)
        break
      case 'add_bot':
        this.addBot(ws)
        break
      case 'remove_bot':
        this.removeBot(ws)
        break
      case 'ping': {
        if (!ctx.seatId) {
          send(ws, { type: 'error', code: 'not_joined', message: '请先加入房间' })
          return
        }
        send(ws, { type: 'pong', t: msg.t, serverTime: Date.now() })
        break
      }
      case 'pose': {
        if (!ctx.room || !ctx.seatId) return
        ctx.room.handlePose(ctx.seatId, msg)
        break
      }
      case 'attack': {
        if (!ctx.room || !ctx.seatId) return
        const yaw = typeof msg.yaw === 'number' && Number.isFinite(msg.yaw) ? msg.yaw : 0
        ctx.room.handleAttack(ctx.seatId, yaw)
        break
      }
      default:
        send(ws, { type: 'error', code: 'bad_message', message: '未知消息类型' })
    }
  }

  private createRoom(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'create_room' }>,
  ): void {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.badProtocol(ws, msg.protocolVersion)
      return
    }
    const name = (msg.name ?? '').trim().slice(0, 16)
    if (!name) {
      send(ws, { type: 'error', code: 'invalid_name', message: '昵称不能为空' })
      return
    }
    if (this.rooms.size >= MAX_ROOMS) {
      send(ws, { type: 'error', code: 'server_full', message: '服务器房间数已满' })
      return
    }

    this.detachFromRoom(ws)

    let code = genCode()
    while (this.rooms.has(code)) code = genCode()

    const room = new Room(code, '')
    room.onEmpty = () => {
      room.stop()
      this.rooms.delete(room.code)
    }
    this.rooms.set(code, room)

    const seat = room.addHost(ws, name)
    this.bind(ws, room, seat)
    room.sendWelcome(ws, seat)
    room.broadcastRoomState()
  }

  private joinRoom(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'join_room' }>,
  ): void {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.badProtocol(ws, msg.protocolVersion)
      return
    }
    const name = (msg.name ?? '').trim().slice(0, 16)
    if (!name) {
      send(ws, { type: 'error', code: 'invalid_name', message: '昵称不能为空' })
      return
    }

    if (msg.sessionToken) {
      const ref = this.tokens.get(msg.sessionToken)
      if (ref) {
        const room = this.rooms.get(ref.roomCode)
        const seat = room?.findSeatByToken(msg.sessionToken)
        if (room && seat) {
          this.detachFromRoom(ws)
          room.reconnectSeat(seat, ws, name)
          this.bind(ws, room, seat)
          room.sendWelcome(ws, seat)
          room.broadcast({ type: 'player_reconnected', playerId: seat.id }, seat.id)
          room.broadcastRoomState()
          return
        }
      }
    }

    const code = (msg.roomCode ?? '').replace(/\D/g, '').padStart(4, '0').slice(-4)
    if (!/^\d{4}$/.test(code)) {
      send(ws, {
        type: 'error',
        code: 'room_not_found',
        message: '房间码须为 4 位数字',
      })
      return
    }
    const room = this.rooms.get(code)
    if (!room) {
      send(ws, {
        type: 'error',
        code: 'room_not_found',
        message: `房间 ${code || '？'} 不存在`,
      })
      return
    }

    this.detachFromRoom(ws)

    const result = room.tryAddPlayer(ws, name)
    if ('error' in result) {
      send(ws, result.error)
      return
    }
    const seat = result
    this.bind(ws, room, seat)
    room.sendWelcome(ws, seat)
    room.broadcast(
      {
        type: 'player_joined',
        player: {
          id: seat.id,
          name: seat.name,
          connected: true,
          ready: seat.ready,
          isHost: seat.id === room.hostId,
          homeIndex: seat.homeIndex,
          isBot: seat.isBot,
        },
      },
      seat.id,
    )
    room.broadcastRoomState()
  }

  /**
   * Dev-friendly: join room if it exists in lobby, else create with the given code.
   * Used for fixed test room e.g. 0000 so two local browsers skip typing codes.
   */
  private joinOrCreate(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'join_or_create' }>,
  ): void {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.badProtocol(ws, msg.protocolVersion)
      return
    }
    const name = (msg.name ?? '').trim().slice(0, 16)
    if (!name) {
      send(ws, { type: 'error', code: 'invalid_name', message: '昵称不能为空' })
      return
    }
    const code = (msg.roomCode ?? '').replace(/\D/g, '').padStart(4, '0').slice(-4)
    if (!/^\d{4}$/.test(code)) {
      send(ws, {
        type: 'error',
        code: 'room_not_found',
        message: '房间码须为 4 位数字',
      })
      return
    }

    const isDevQuick = code === DEV_QUICK_ROOM_CODE
    const existing = this.rooms.get(code)

    if (existing) {
      if (existing.phase === 'playing') {
        const live = existing.listPlayers().some((p) => p.connected)
        if (!live) {
          this.forceDeleteRoom(code)
        } else if (isDevQuick) {
          // Dev: allow second browser to join mid-match (first already auto-started)
          this.detachFromRoom(ws)
          const result = existing.tryAddPlayer(ws, name, { allowDuringPlay: true })
          if ('error' in result) {
            send(ws, result.error)
            return
          }
          const seat = result
          existing.admitToRunningMatch(seat.id)
          this.bind(ws, existing, seat)
          existing.sendWelcome(ws, seat)
          existing.broadcast(
            {
              type: 'player_joined',
              player: {
                id: seat.id,
                name: seat.name,
                connected: true,
                ready: true,
                isHost: seat.id === existing.hostId,
                homeIndex: seat.homeIndex,
              },
            },
            seat.id,
          )
          existing.broadcastRoomState()
          return
        } else {
          send(ws, {
            type: 'error',
            code: 'room_playing',
            message: `房间 ${code} 对局中，无法加入`,
          })
          return
        }
      } else {
        // Lobby: join then auto-start for dev quick room
        this.detachFromRoom(ws)
        const result = existing.tryAddPlayer(ws, name)
        if ('error' in result) {
          send(ws, result.error)
          return
        }
        const seat = result
        this.bind(ws, existing, seat)
        existing.sendWelcome(ws, seat)
        existing.broadcast(
          {
            type: 'player_joined',
            player: {
              id: seat.id,
              name: seat.name,
              connected: true,
              ready: true,
              isHost: false,
              homeIndex: seat.homeIndex,
            },
          },
          seat.id,
        )
        existing.broadcastRoomState()
        if (isDevQuick) {
          existing.forceStartMatch()
        }
        return
      }
    }

    if (this.rooms.size >= MAX_ROOMS && !this.rooms.has(code)) {
      send(ws, { type: 'error', code: 'server_full', message: '服务器房间数已满' })
      return
    }

    this.detachFromRoom(ws)

    const room = new Room(code, '')
    room.onEmpty = () => {
      room.stop()
      this.rooms.delete(room.code)
    }
    this.rooms.set(code, room)

    const seat = room.addHost(ws, name)
    this.bind(ws, room, seat)
    room.sendWelcome(ws, seat)
    room.broadcastRoomState()
    // Dev quick room: auto bot + auto start
    if (isDevQuick) {
      room.addBot(seat.id)
      room.forceStartMatch()
    }
  }

  private setReady(ws: WebSocket, ready: boolean): void {
    const ctx = this.byWs.get(ws)
    if (!ctx?.room || !ctx.seatId) {
      send(ws, { type: 'error', code: 'not_joined', message: '请先加入房间' })
      return
    }
    ctx.room.setReady(ctx.seatId, ready)
  }

  private startGame(ws: WebSocket): void {
    const ctx = this.byWs.get(ws)
    if (!ctx?.room || !ctx.seatId) {
      send(ws, { type: 'error', code: 'not_joined', message: '请先加入房间' })
      return
    }
    const result = ctx.room.startGame(ctx.seatId)
    if ('error' in result) send(ws, result.error)
  }

  private leaveRoom(ws: WebSocket): void {
    this.detachFromRoom(ws)
  }

  private addBot(ws: WebSocket): void {
    const ctx = this.byWs.get(ws)
    if (!ctx?.room || !ctx.seatId) {
      send(ws, { type: 'error', code: 'not_joined', message: '请先加入房间' })
      return
    }
    const result = ctx.room.addBot(ctx.seatId)
    if ('error' in result) send(ws, result.error)
  }

  private removeBot(ws: WebSocket): void {
    const ctx = this.byWs.get(ws)
    if (!ctx?.room || !ctx.seatId) {
      send(ws, { type: 'error', code: 'not_joined', message: '请先加入房间' })
      return
    }
    const result = ctx.room.removeBot(ctx.seatId)
    if ('error' in result) send(ws, result.error)
  }

  private detachFromRoom(ws: WebSocket): void {
    const ctx = this.byWs.get(ws)
    if (!ctx?.room || !ctx.seatId) return
    const seat = ctx.room.findSeatByWs(ws)
    if (seat) this.tokens.delete(seat.sessionToken)
    ctx.room.leave(ctx.seatId)
    ctx.room = null
    ctx.seatId = null
  }

  private bind(ws: WebSocket, room: Room, seat: Seat): void {
    this.tokens.set(seat.sessionToken, { roomCode: room.code, seatId: seat.id })
    const ctx = this.byWs.get(ws)
    if (ctx) {
      ctx.room = room
      ctx.seatId = seat.id
    }
  }

  private handleDisconnect(ws: WebSocket): void {
    const ctx = this.byWs.get(ws)
    if (ctx?.room) {
      ctx.room.handleDisconnect(ws)
    }
    this.byWs.delete(ws)
  }

  private forceDeleteRoom(code: string): void {
    const room = this.rooms.get(code)
    if (!room) return
    room.stop()
    this.rooms.delete(code)
    for (const [tok, ref] of [...this.tokens.entries()]) {
      if (ref.roomCode === code) this.tokens.delete(tok)
    }
  }

  private badProtocol(ws: WebSocket, clientVer: number): void {
    send(ws, {
      type: 'error',
      code: 'bad_protocol',
      message: `协议版本不匹配：客户端 ${clientVer}，服务器 ${PROTOCOL_VERSION}`,
    })
    ws.close()
  }
}
