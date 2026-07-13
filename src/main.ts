import './style.css'
import { Game } from './core/Game'
import { NetClient } from './net/NetClient'
import { GameHud } from './ui/GameHud'
import { LobbyPanel } from './ui/LobbyPanel'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) {
  throw new Error('#app not found')
}

const hud = new GameHud()
const net = new NetClient()

const game = new Game(app, (fb) => hud.handleFeedback(fb))

const lobby = new LobbyPanel(net, {
  onOfflinePlay: () => {
    // 单机：保持本地卡牌权威（Game 默认 offline）
  },
  onMatchStart: () => {
    // 联机对局开始，大厅已隐藏；Game 通过 net 事件加载牌
  },
  onBackToLobby: () => {
    lobby.show()
  },
})

game
  .init()
  .then(() => {
    game.attachNet(net)
    game.setScoresListener((scores) => hud.setScores(scores, net.playerId))
    game.setItemListener((item) => hud.setHeldItem(item))
    game.setPointerLockListener((locked) => hud.setPointerLocked(locked))
    game.setMatchClockListener((endsAt, winScore) => {
      hud.setMatchClock(endsAt, winScore)
      // New match: dummy hidden until user clicks left button
      if (endsAt != null) hud.setDummyButtonState(false)
    })
    game.setMatchEndListener((info) => {
      hud.showMatchEnd(info, net.playerId)
      hud.setDummyButtonState(false)
      lobby.show()
      lobby.flashMatchEnd(info.message)
    })
    game.setUnoMomentListener((info) => {
      hud.showUnoMoment(info.message)
    })
    game.setSlideCdListener(() => {
      hud.startSlideCooldown()
    })
    game.setDeathListener((info) => {
      if (info) hud.showDeath(info.until, info.durationMs)
      else hud.hideDeath()
    })
    hud.setDebugGiveListener((kind) => {
      if (!net.isPlaying) {
        hud.handleFeedback({
          type: 'toast',
          text: '请先进入对局再添加道具',
          kind: 'bad',
        })
        return
      }
      net.debugGiveItem(kind)
      hud.handleFeedback({
        type: 'toast',
        text: kind === 'stun_bat' ? '已添加狼牙棒到手持' : '已添加 Skip 到手持',
        kind: 'ok',
      })
    })
    game.setDummyStateListener((active) => {
      hud.setDummyButtonState(active)
      hud.handleFeedback({
        type: 'toast',
        text: active
          ? '已生成木头人（可打 · 有背包）'
          : '已移除木头人（逻辑与模型均关闭）',
        kind: 'ok',
      })
    })
    hud.setToggleDummyListener(() => {
      if (!net.isPlaying) {
        hud.handleFeedback({
          type: 'toast',
          text: '请先进入对局',
          kind: 'bad',
        })
        return
      }
      const next = !game.isDummyVisible()
      if (!game.requestDummyActive(next)) {
        hud.handleFeedback({
          type: 'toast',
          text: '木头人暂不可用',
          kind: 'bad',
        })
        return
      }
      // UI updates when server broadcasts dummy_state
    })
    game.start()
  })
  .catch((err) => {
    console.error(err)
    hud.setError(String(err))
  })
