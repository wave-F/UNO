import {
  UNO_COLOR_CSS,
  cardLabel,
  type UnoCardData,
} from '../game/uno/types'
import { formatStackLine, type PickupFeedback } from '../systems/CardPickupSystem'

export class GameHud {
  private readonly root: HTMLDivElement
  private readonly stackEl: HTMLDivElement
  private readonly promptEl: HTMLDivElement
  private readonly chipsEl: HTMLDivElement
  private readonly homeEl: HTMLDivElement
  private promptTimer: number | null = null

  constructor() {
    this.root = document.createElement('div')
    this.root.id = 'hud'

    this.root.innerHTML = `
      <div class="hud-title"><strong>Bean Guys · 运牌回家</strong></div>
      <div class="hud-help">点击画面锁定鼠标 · 镜头/WASD 移动 · 捡牌后走回<strong>左下角老家</strong>自动卸货</div>
      <div class="hud-lock" id="hud-lock">点击画面开始控制镜头</div>
      <div class="hud-home" id="hud-home">老家已送达：0 张</div>
      <div class="hud-stack" id="hud-stack"></div>
      <div class="hud-chips" id="hud-chips"></div>
      <div class="hud-prompt" id="hud-prompt" hidden></div>
    `
    document.body.appendChild(this.root)

    this.stackEl = this.root.querySelector('#hud-stack')!
    this.chipsEl = this.root.querySelector('#hud-chips')!
    this.promptEl = this.root.querySelector('#hud-prompt')!
    this.homeEl = this.root.querySelector('#hud-home')!
    this.renderStack([])
    this.renderHome(0)
  }

  setPointerLocked(locked: boolean): void {
    const el = this.root.querySelector<HTMLElement>('#hud-lock')
    if (!el) return
    el.hidden = locked
  }

  handleFeedback(fb: PickupFeedback): void {
    switch (fb.type) {
      case 'picked':
        this.renderStack(fb.stack)
        this.showPrompt(`捡到 ${cardLabel(fb.card)}`, 'ok')
        break
      case 'illegal':
        this.showPrompt(
          `不能接：需要接「${cardLabel(fb.top)}」，这张是「${cardLabel(fb.card)}」`,
          'bad',
        )
        break
      case 'clear_prompt':
        this.hidePrompt()
        break
      case 'deposited':
        this.renderStack([])
        this.renderHome(fb.deliveredTotal)
        this.showPrompt(
          `送达老家 ${fb.cards.length} 张！累计 ${fb.deliveredTotal} 张`,
          'ok',
        )
        break
    }
  }

  setError(msg: string): void {
    this.root.innerHTML = `<strong>启动失败</strong><br />${msg}`
  }

  private renderHome(total: number): void {
    this.homeEl.textContent = `老家已送达：${total} 张`
  }

  private renderStack(stack: readonly UnoCardData[]): void {
    this.stackEl.textContent = formatStackLine(stack)
    this.chipsEl.innerHTML = ''
    const show = stack.slice(-8)
    for (const c of show) {
      const chip = document.createElement('span')
      chip.className = 'card-chip'
      chip.textContent = cardLabel(c)
      chip.style.background = UNO_COLOR_CSS[c.color]
      chip.style.color = c.color === 'yellow' ? '#111' : '#fff'
      this.chipsEl.appendChild(chip)
    }
    if (stack.length > 8) {
      const more = document.createElement('span')
      more.className = 'card-chip more'
      more.textContent = `+${stack.length - 8}`
      this.chipsEl.appendChild(more)
    }
  }

  private showPrompt(text: string, kind: 'ok' | 'bad'): void {
    this.promptEl.hidden = false
    this.promptEl.textContent = text
    this.promptEl.className = `hud-prompt ${kind}`
    if (this.promptTimer !== null) window.clearTimeout(this.promptTimer)
    if (kind === 'ok') {
      this.promptTimer = window.setTimeout(() => this.hidePrompt(), 1600)
    }
  }

  private hidePrompt(): void {
    this.promptEl.hidden = true
    this.promptEl.textContent = ''
    if (this.promptTimer !== null) {
      window.clearTimeout(this.promptTimer)
      this.promptTimer = null
    }
  }
}
