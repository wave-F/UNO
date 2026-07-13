/**
 * LAN multiplayer host: HTTP health + WebSocket multi-room manager.
 * Bind 0.0.0.0 so phones on the same Wi‑Fi can connect.
 */
import http from 'node:http'
import os from 'node:os'
import { WebSocketServer } from 'ws'
import { DEFAULT_WS_PORT, PROTOCOL_VERSION } from '../shared/protocol.ts'
import { RoomManager } from './RoomManager.ts'

const PORT = Number(process.env.PORT) || DEFAULT_WS_PORT
const manager = new RoomManager()

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        ok: true,
        service: 'uno-guys-lan',
        protocolVersion: PROTOCOL_VERSION,
        rooms: manager.listSummary(),
        hint: 'WS: create_room | join_room { roomCode }',
      }),
    )
    return
  }
  res.writeHead(404)
  res.end('Not found')
})

const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  manager.handleConnection(ws)
})

function lanIPv4(): string[] {
  const out: string[] = []
  const nets = os.networkInterfaces()
  for (const list of Object.values(nets)) {
    if (!list) continue
    for (const n of list) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address)
    }
  }
  return out
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanIPv4()
  console.log(`[lan] protocol v${PROTOCOL_VERSION} (multi-room)`)
  console.log(`[lan] HTTP/WS listening on 0.0.0.0:${PORT}`)
  console.log(`[lan] local:  http://127.0.0.1:${PORT}/health`)
  if (ips.length) {
    for (const ip of ips) {
      console.log(`[lan] LAN:    ws://${ip}:${PORT}`)
    }
  } else {
    console.log('[lan] No non-loopback IPv4 found; check Wi‑Fi')
  }
})
