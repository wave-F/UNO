import {
  UNO_COLOR_CSS,
  cardLabel,
  type UnoCardData,
} from '../game/uno/types'
import { formatStackLine, type PickupFeedback } from '../systems/CardPickupSystem'
import { MATCH_WIN_SCORE } from '../../shared/config/match'

export class GameHud {
  private readonly root: HTMLDivElement
  private readonly stackEl: HTMLDivElement
  private readonly promptEl: HTMLDivElement
  private readonly chipsEl: HTMLDivElement
  private readonly homeEl: HTMLDivElement
  private promptTimer: number | null = null

  private readonly scoresEl: HTMLDivElement
  private readonly itemEl: HTMLDivElement
  private readonly timerEl: HTMLDivElement
  private readonly goalEl: HTMLDivElement
  private readonly resultEl: HTMLDivElement

  private matchEndsAt: number | null = null
  private timerRaf = 0

  constructor() {
    this.root = document.createElement('div')
    this.root.id = 'hud'

    this.root.innerHTML = `
      <div class="hud-title"><strong>UNO Guys · 运牌回家</strong></div>
      <div class="hud-help">锁定鼠标 · WASD · 捡<strong>狼牙棒</strong>左键挥击 · 数字牌运回<strong>自家</strong>计分</div>
      <div class="hud-timer" id="hud-timer" hidden>剩余 2:00</div>
      <div class="hud-goal" id="hud-goal" hidden>目标：先送达 ${MATCH_WIN_SCORE} 张</div>

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
    this.timerEl = this.root.querySelector('#hud-timer')!
    this.goalEl = this.root.querySelector('#hud-goal')!
    this.itemEl = document.createElement('div')
    this.itemEl.className = 'hud-item'
    this.itemEl.hidden = true
    this.root.insertBefore(this.itemEl, this.stackEl)
    this.renderStack([])
    this.renderHome(0)
    this.renderItem(null)

    this.resultEl = document.createElement('div')
    this.resultEl.id = 'match-result'
    this.resultEl.hidden = true
    document.body.appendChild(this.resultEl)
  }

  /** Server endsAt epoch ms; null clears timer. */
  setMatchClock(endsAt: number | null, winScore = MATCH_WIN_SCORE): void {
    this.matchEndsAt = endsAt
    if (endsAt == null) {
      this.timerEl.hidden = true
      this.goalEl.hidden = true
      if (this.timerRaf) {
        cancelAnimationFrame(this.timerRaf)
        this.timerRaf = 0
      }
      return
    }
    this.goalEl.hidden = false
    this.goalEl.textContent = `目标：先送达 ${winScore} 张 · 时间到比谁多`
    this.timerEl.hidden = false
    if (this.timerRaf) cancelAnimationFrame(this.timerRaf)
    this.tickTimer()
  }

  showMatchEnd(info: {
    reason: 'score' | 'timeout'
    winners: { id: string; name?: string; score: number }[]
    message: string
    winScore: number
  }, localId: string | null): void {
    this.setMatchClock(null, info.winScore)
    const youWin = info.winners.some((w) => w.id === localId)
    this.resultEl.hidden = false
    this.resultEl.className = youWin ? 'match-result win' : 'match-result'
    const title =
      info.reason === 'score' ? '🏁 率先达标！' : '⏱️ 时间到！'
    this.resultEl.innerHTML = `
      <div class="match-result-card">
        <h2>${title}</h2>
        <p class="match-result-msg">${escapeHtml(info.message)}</p>
        <p class="match-result-hint">返回大厅，房主可再开一局</p>
        <button type="button" class="match-result-btn" id="match-result-ok">知道了</button>
      </div>
    `
    this.resultEl.querySelector('#match-result-ok')?.addEventListener('click', () => {
      this.hideMatchEnd()
    })
    this.showPrompt(info.message, youWin ? 'ok' : 'bad')
  }

  hideMatchEnd(): void {
    this.resultEl.hidden = true
    this.resultEl.innerHTML = ''
  }

  private tickTimer = (): void => {
    if (this.matchEndsAt == null) return
    const left = Math.max(0, this.matchEndsAt - Date.now())
    const sec = Math.ceil(left / 1000)
    const m = Math.floor(sec / 60)
    const s = sec % 60
    this.timerEl.textContent = `剩余 ${m}:${s.toString().padStart(2, '0')}`
    this.timerEl.classList.toggle('urgent', left < 30_000)
    if (left > 0) {
      this.timerRaf = requestAnimationFrame(this.tickTimer)
    } else {
      this.timerEl.textContent = '剩余 0:00'
    }
  }

  setHeldItem(item: { kind?: string; rank?: string; color?: string | null } | null): void {
    this.renderItem(item)
  }

  private renderItem(item: { kind?: string; rank?: string; color?: string | null } | null): void {
    if (!item) {
      this.itemEl.hidden = true
      this.itemEl.textContent = ''
      return
    }
    this.itemEl.hidden = false
    this.itemEl.textContent =
      item.kind === 'stun_bat' || item.rank === 'stun'
        ? '🔨 手持：狼牙棒（左键挥击）'
        : '🎒 手持道具'
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
      case 'toast':
        this.showPrompt(fb.text, fb.kind)
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
      chip.style.background = c.color ? UNO_COLOR_CSS[c.color] : '#4c1d95'
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
