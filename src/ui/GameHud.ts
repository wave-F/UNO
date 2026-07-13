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

  private readonly scoresEl: HTMLDivElement

  constructor() {
    this.root = document.createElement('div')
    this.root.id = 'hud'

    this.root.innerHTML = `
      <div class="hud-title"><strong>Bean Guys · 运牌回家</strong></div>
      <div class="hud-help">点击画面锁定鼠标 · 镜头/WASD 移动 · 捡牌后走回<strong>左下角老家</strong>自动卸货 · 联机后牌以服务器为准</div>
      <div class="hud-lock" id="hud-lock">点击画面开始控制镜头</div>
      <div class="hud-home" id="hud-home">老家已送达：0 张</div>
      <div class="hud-scores" id="hud-scores" hidden></div>
      <div class="hud-stack" id="hud-stack"></div>
      <div class="hud-chips" id="hud-chips"></div>
      <div class="hud-prompt" id="hud-prompt" hidden></div>
    `
    document.body.appendChild(this.root)

    this.stackEl = this.root.querySelector('#hud-stack')!
    this.chipsEl = this.root.querySelector('#hud-chips')!
    this.promptEl = this.root.querySelector('#hud-prompt')!
    this.homeEl = this.root.querySelector('#hud-home')!
    this.scoresEl = this.root.querySelector('#hud-scores')!
    this.renderStack([])
    this.renderHome(0)
  }

  setScores(
    scores: { id: string; name?: string; score: number; stackCount: number }[],
    localId: string | null,
  ): void {
    if (!scores.length) {
      this.scoresEl.hidden = true
      this.scoresEl.innerHTML = ''
      return
    }
    this.scoresEl.hidden = false
    const lines = scores
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((s) => {
        const you = s.id === localId ? ' ·你' : ''
        const name = s.name || s.id.slice(0, 6)
        return `${name}${you}: ${s.score}分 (背${s.stackCount})`
      })
    this.scoresEl.innerHTML = `<strong>联机得分</strong><br/>${lines.join('<br/>')}`
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
        this.showPrompt(`背上 ${cardLabel(fb.card)}`, 'ok')
        break
      case 'illegal':
        if (fb.reason === 'home_once') {
          this.showPrompt('本趟已从该老家拿过 1 张，卸货后再来', 'bad')
        } else {
          this.showPrompt(
            `不能接：需要接「${cardLabel(fb.top)}」，这张是「${cardLabel(fb.card)}」`,
            'bad',
          )
        }
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
