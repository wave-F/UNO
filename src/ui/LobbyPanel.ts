import { PROTOCOL_VERSION } from '../../shared/protocol'
import { NetClient } from '../net/NetClient'

export type LobbyPanelOptions = {
  /** Single-player with local bots (no WebSocket). */
  onSoloPlay: (playerName: string) => void
  onMatchStart: () => void
  onBackToLobby?: () => void
}

/**
 * Simplified lobby: 单机游戏 + 局域对战（暂未开启）.
 */
export class LobbyPanel {
  readonly root: HTMLDivElement
  private readonly net: NetClient
  private readonly opts: LobbyPanelOptions
  private nameInput: HTMLInputElement
  private statusEl: HTMLElement

  constructor(net: NetClient, opts: LobbyPanelOptions) {
    this.net = net
    this.opts = opts
    this.root = document.createElement('div')
    this.root.id = 'lobby'
    this.root.innerHTML = `
      <div class="lobby-card lobby-card-lg lobby-card-simple">
        <div class="lobby-title">UNO Guys <span class="lobby-ver">v${PROTOCOL_VERSION}</span></div>
        <p class="lobby-hint">
          运牌回家，先送到 50 张或 2 分钟内比谁多。单机含 3 个机器人陪玩。
        </p>
        <label class="lobby-label">昵称
          <input id="lobby-name" type="text" maxlength="16" autocomplete="nickname" placeholder="你的名字" />
        </label>

        <div class="lobby-actions lobby-actions-stack" id="lobby-actions-entry">
          <button type="button" id="lobby-solo" class="lobby-solo">单机游戏</button>
          <button type="button" id="lobby-lan" class="lobby-lan" disabled title="后续版本开放">
            局域对战（暂未开启）
          </button>
        </div>

        <div class="lobby-status" id="lobby-status">选择模式开始</div>
      </div>
    `
    document.body.appendChild(this.root)

    this.nameInput = this.root.querySelector('#lobby-name')!
    this.statusEl = this.root.querySelector('#lobby-status')!
    this.nameInput.value = localStorage.getItem('bean-guys-name') || 'Player'

    this.root.querySelector('#lobby-solo')!.addEventListener('click', () => {
      const name = this.nameInput.value.trim() || 'Player'
      localStorage.setItem('bean-guys-name', name)
      this.statusEl.textContent = '单机开局中…'
      this.statusEl.dataset.kind = 'ok'
      this.hide()
      this.opts.onSoloPlay(name)
    })

    this.root.querySelector('#lobby-lan')!.addEventListener('click', (e) => {
      e.preventDefault()
      this.statusEl.textContent = '局域对战暂未开启，请用「单机游戏」'
      this.statusEl.dataset.kind = 'bad'
    })

    // Keep net hooks for future LAN; match end still uses flashMatchEnd
    this.net.on('matchEnd', (info) => {
      this.show()
      this.flashMatchEnd(info.message)
    })
    this.net.on('matchStart', () => {
      this.hide()
      this.opts.onMatchStart()
    })
    this.net.on('error', (_code, message) => {
      this.statusEl.textContent = `错误：${message}`
      this.statusEl.dataset.kind = 'bad'
    })
  }

  show(): void {
    this.root.hidden = false
  }

  hide(): void {
    this.root.hidden = true
  }

  /** After a round ends — surface result text in lobby status. */
  flashMatchEnd(message: string): void {
    this.statusEl.textContent = message
    this.statusEl.dataset.kind = 'ok'
  }
}
