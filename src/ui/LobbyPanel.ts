import {
  DEFAULT_WS_PORT,
  DEV_QUICK_ROOM_CODE,
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  type PublicPlayer,
  type RoomPhase,
} from '../../shared/protocol'
import { NetClient, defaultWsUrl, type NetStatus } from '../net/NetClient'

export type LobbyPanelOptions = {
  onOfflinePlay: () => void
  onMatchStart: () => void
  onBackToLobby?: () => void
}

/**
 * Full-screen LAN lobby: create/join room, host start (no ready).
 * Host WS URL is hidden under advanced (auto = page hostname:8787).
 */
export class LobbyPanel {
  readonly root: HTMLDivElement
  private readonly net: NetClient
  private readonly opts: LobbyPanelOptions
  private nameInput: HTMLInputElement
  private urlInput: HTMLInputElement
  private codeInput: HTMLInputElement
  private statusEl: HTMLElement
  private playersEl: HTMLElement
  private rttEl: HTMLElement
  private roomMetaEl: HTMLElement
  private roomCodeBigEl: HTMLElement
  private startBtn: HTMLButtonElement
  private addBotBtn: HTMLButtonElement
  private rmBotBtn: HTMLButtonElement
  private actionsLobby: HTMLElement
  private actionsRoom: HTMLElement
  private codeBlock: HTMLElement
  private copyBtn: HTMLButtonElement

  constructor(net: NetClient, opts: LobbyPanelOptions) {
    this.net = net
    this.opts = opts
    this.root = document.createElement('div')
    this.root.id = 'lobby'
    this.root.innerHTML = `
      <div class="lobby-card lobby-card-lg">
        <div class="lobby-title">UNO Guys · 大厅 <span class="lobby-ver">v${PROTOCOL_VERSION}</span></div>
        <p class="lobby-hint">
          主机电脑运行 <code>npm run server</code>，其他人用浏览器打开<strong>同一台电脑的页面地址</strong>。
          创建房间后告诉大家<strong>房间码</strong>即可。最多 ${MAX_PLAYERS} 人/房。
        </p>
        <label class="lobby-label">昵称
          <input id="lobby-name" type="text" maxlength="16" autocomplete="nickname" />
        </label>
        <label class="lobby-label">房间码（加入时填写，4 位数字）
          <input id="lobby-code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="如 0427" spellcheck="false" autocomplete="off" />
        </label>

        <details class="lobby-advanced">
          <summary>高级设置（一般不用改）</summary>
          <label class="lobby-label">主机 WebSocket
            <input id="lobby-url" type="text" spellcheck="false" />
          </label>
          <p class="lobby-advanced-hint">默认自动使用「当前网页主机名:8787」。仅当 server 在别的机器/端口时才改。</p>
        </details>

        <div class="lobby-actions" id="lobby-actions-entry">
          <button type="button" id="lobby-quick" class="lobby-quick">本地双开测试（一点即玩）</button>
          <button type="button" id="lobby-create">创建房间</button>
          <button type="button" id="lobby-join">加入房间</button>
          <button type="button" id="lobby-offline" class="ghost">单机游玩</button>
        </div>
        <p class="lobby-quick-hint">开发用：点「本地双开测试」→ 房 ${DEV_QUICK_ROOM_CODE} 自动开局并加 1 个机器人；也可用「加机器人」单人测。</p>

        <div id="lobby-code-block" class="lobby-code-block" hidden>
          <div class="lobby-code-label">房间码（发给同伴）</div>
          <div class="lobby-code-row">
            <span id="lobby-code-big" class="lobby-code-big">----</span>
            <button type="button" id="lobby-copy" class="ghost lobby-copy">复制</button>
          </div>
        </div>

        <div class="lobby-actions" id="lobby-actions-room" hidden>
          <button type="button" id="lobby-start">开始游戏</button>
          <button type="button" id="lobby-add-bot" class="ghost">加机器人</button>
          <button type="button" id="lobby-rm-bot" class="ghost">减机器人</button>
          <button type="button" id="lobby-leave" class="ghost">离开房间</button>
        </div>

        <div class="lobby-status" id="lobby-status">未连接</div>
        <div class="lobby-room-meta" id="lobby-room-meta"></div>
        <div class="lobby-rtt" id="lobby-rtt"></div>
        <div class="lobby-players-title">房间玩家</div>
        <ul class="lobby-players" id="lobby-players"></ul>
      </div>
    `
    document.body.appendChild(this.root)

    this.nameInput = this.root.querySelector('#lobby-name')!
    this.urlInput = this.root.querySelector('#lobby-url')!
    this.codeInput = this.root.querySelector('#lobby-code')!
    this.statusEl = this.root.querySelector('#lobby-status')!
    this.playersEl = this.root.querySelector('#lobby-players')!
    this.rttEl = this.root.querySelector('#lobby-rtt')!
    this.roomMetaEl = this.root.querySelector('#lobby-room-meta')!
    this.roomCodeBigEl = this.root.querySelector('#lobby-code-big')!
    this.startBtn = this.root.querySelector('#lobby-start')!
    this.addBotBtn = this.root.querySelector('#lobby-add-bot')!
    this.rmBotBtn = this.root.querySelector('#lobby-rm-bot')!
    this.actionsLobby = this.root.querySelector('#lobby-actions-entry')!
    this.actionsRoom = this.root.querySelector('#lobby-actions-room')!
    this.codeBlock = this.root.querySelector('#lobby-code-block')!
    this.copyBtn = this.root.querySelector('#lobby-copy')!

    this.nameInput.value = localStorage.getItem('bean-guys-name') || 'Player'
    this.urlInput.value =
      localStorage.getItem('bean-guys-ws-url') || defaultWsUrl(DEFAULT_WS_PORT)

    this.root.querySelector('#lobby-quick')!.addEventListener('click', () => this.quickTest())
    this.root.querySelector('#lobby-create')!.addEventListener('click', () => this.create())
    this.root.querySelector('#lobby-join')!.addEventListener('click', () => this.join())
    this.root.querySelector('#lobby-offline')!.addEventListener('click', () => {
      this.hide()
      this.opts.onOfflinePlay()
    })
    this.startBtn.addEventListener('click', () => this.net.startGame())
    this.addBotBtn.addEventListener('click', () => this.net.addBot())
    this.rmBotBtn.addEventListener('click', () => this.net.removeBot())
    this.root.querySelector('#lobby-leave')!.addEventListener('click', () => {
      this.net.leaveRoom()
      this.net.disconnect()
      this.showEntry()
      this.opts.onBackToLobby?.()
    })
    this.copyBtn.addEventListener('click', () => this.copyRoomCode())

    this.nameInput.addEventListener('change', () => {
      localStorage.setItem('bean-guys-name', this.nameInput.value.trim())
    })
    this.urlInput.addEventListener('change', () => {
      localStorage.setItem('bean-guys-ws-url', this.urlInput.value.trim())
    })

    this.net.on('status', (s, detail) => this.renderStatus(s, detail))
    this.net.on('roomState', (info) => {
      this.renderRoom(info.roomCode, info.phase, info.players)
    })
    this.net.on('welcome', (info) => {
      this.showRoom()
      this.renderRoom(info.roomCode, info.phase, info.players)
      this.statusEl.textContent =
        info.phase === 'playing'
          ? `已重连对局 · 房间 ${info.roomCode}`
          : `已在大厅 · 把房间码告诉同伴`
      this.statusEl.dataset.kind = 'ok'
      if (info.phase === 'playing') {
        this.hide()
        this.opts.onMatchStart()
      }
    })
    this.net.on('matchStart', () => {
      this.statusEl.textContent = '对局开始！先送到 20 张或 2 分钟比谁多'
      this.statusEl.dataset.kind = 'ok'
      this.hide()
      this.opts.onMatchStart()
    })
    this.net.on('matchEnd', (info) => {
      this.show()
      this.flashMatchEnd(info.message)
    })
    this.net.on('error', (_code, message) => {
      this.statusEl.textContent = `错误：${message}`
      this.statusEl.dataset.kind = 'bad'
    })
    this.net.on('pong', (rtt) => {
      this.rttEl.textContent =
        rtt < 1
          ? 'RTT < 1 ms（本机）'
          : `RTT ≈ ${rtt < 10 ? rtt.toFixed(1) : Math.round(rtt)} ms`
    })
  }

  show(): void {
    this.root.hidden = false
  }

  hide(): void {
    this.root.hidden = true
  }

  private wsUrl(): string {
    const saved = this.urlInput.value.trim()
    if (saved) return saved
    return defaultWsUrl(DEFAULT_WS_PORT)
  }

  private quickTest(): void {
    const name = this.nameInput.value.trim() || 'Player'
    const url = this.wsUrl()
    localStorage.setItem('bean-guys-name', name)
    localStorage.setItem('bean-guys-ws-url', url)
    this.urlInput.value = url
    this.codeInput.value = DEV_QUICK_ROOM_CODE
    this.net.quickTestJoin(url, name, DEV_QUICK_ROOM_CODE)
  }

  private create(): void {
    const name = this.nameInput.value.trim() || 'Player'
    const url = this.wsUrl()
    localStorage.setItem('bean-guys-name', name)
    localStorage.setItem('bean-guys-ws-url', url)
    this.urlInput.value = url
    this.net.createRoom(url, name)
  }

  private join(): void {
    const name = this.nameInput.value.trim() || 'Player'
    const url = this.wsUrl()
    const code = this.codeInput.value.replace(/\D/g, '').slice(0, 4)
    if (code.length !== 4) {
      this.statusEl.textContent = '请填写 4 位数字房间码'
      this.statusEl.dataset.kind = 'bad'
      return
    }
    this.codeInput.value = code
    localStorage.setItem('bean-guys-name', name)
    localStorage.setItem('bean-guys-ws-url', url)
    this.urlInput.value = url
    this.net.joinRoom(url, name, code)
  }

  private async copyRoomCode(): Promise<void> {
    const code = this.roomCodeBigEl.textContent?.trim() ?? ''
    if (!code || code === '----') return
    try {
      await navigator.clipboard.writeText(code)
      this.copyBtn.textContent = '已复制'
      window.setTimeout(() => {
        this.copyBtn.textContent = '复制'
      }, 1200)
    } catch {
      this.copyBtn.textContent = '失败'
    }
  }

  private showEntry(): void {
    this.actionsLobby.hidden = false
    this.actionsRoom.hidden = true
    this.codeBlock.hidden = true
    this.roomMetaEl.textContent = ''
    this.roomCodeBigEl.textContent = '----'
    this.renderPlayers([])
  }

  private showRoom(): void {
    this.actionsLobby.hidden = true
    this.actionsRoom.hidden = false
    this.codeBlock.hidden = false
  }

  /** After a round ends — surface result text in lobby status. */
  flashMatchEnd(message: string): void {
    this.statusEl.textContent = message
    this.statusEl.dataset.kind = 'ok'
  }

  private renderStatus(status: NetStatus, detail?: string): void {
    const labels: Record<NetStatus, string> = {
      disconnected: '未连接',
      connecting: '连接中…',
      connected: '已连接服务器',
      in_room: '已在房间',
      error: detail || '连接错误',
    }
    if (status !== 'in_room') {
      this.statusEl.textContent = labels[status]
    }
    this.statusEl.dataset.kind =
      status === 'error' ? 'bad' : status === 'in_room' ? 'ok' : ''
    if (status === 'disconnected' || status === 'error') {
      this.showEntry()
      this.rttEl.textContent = ''
    }
  }

  private renderRoom(roomCode: string, phase: RoomPhase, players: PublicPlayer[]): void {
    this.showRoom()
    this.roomCodeBigEl.textContent = roomCode
    const hostTag = this.net.isHost ? '你是房主' : '等待房主开始'
    this.roomMetaEl.textContent = `${phase === 'lobby' ? '大厅等待中' : '对局中'} · ${hostTag}`
    this.renderPlayers(players)

    this.startBtn.disabled = phase !== 'lobby' || !this.net.isHost
    this.startBtn.title = this.net.isHost
      ? '进入房间后即可开始（不必等准备）'
      : '仅房主可开始'
    const host = this.net.isHost
    this.addBotBtn.disabled = !host
    this.rmBotBtn.disabled = !host
    this.addBotBtn.title = host ? '添加服务器 AI（可单人测试）' : '仅房主'
    this.rmBotBtn.title = host ? '移除一名机器人' : '仅房主'
  }

  private renderPlayers(players: PublicPlayer[]): void {
    this.playersEl.innerHTML = ''
    if (!players.length) {
      const li = document.createElement('li')
      li.className = 'muted'
      li.textContent = '（空）'
      this.playersEl.appendChild(li)
      return
    }
    const corner = ['西南', '东南', '西北', '东北'] as const
    for (const p of players) {
      const li = document.createElement('li')
      const you = p.id === this.net.playerId ? ' ·你' : ''
      const host = p.isHost ? ' ·房主' : ''
      const bot = p.isBot ? ' ·机器人' : ''
      const offline = p.connected ? '' : ' ·断线'
      const home = corner[p.homeIndex ?? 0] ?? '西南'
      li.textContent = `${p.name}${you}${host}${bot} ·${home}${offline}`
      if (!p.connected) li.className = 'muted'
      this.playersEl.appendChild(li)
    }
  }
}
