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
  onSoloPlay: (playerName) => {
    // Enter field first (paused), show how-to, then start clock/AI
    game.startOfflineSolo(playerName, 3)
    hud.showHowToPlay(() => {
      game.beginOfflineMatch()
    })
  },
  onMatchStart: () => {
    // Future LAN match start
  },
  onBackToLobby: () => {
    lobby.show()
  },
})

game
  .init()
  .then(() => {
    game.attachNet(net)
    game.setScoresListener((scores) =>
      hud.setScores(scores, game.isOfflineSolo() ? 'local_player' : net.playerId),
    )
    game.setItemListener((item) => hud.setHeldItem(item))
    game.setPointerLockListener((locked) => hud.setPointerLocked(locked))
    game.setMatchClockListener((endsAt, winScore) => {
      hud.setMatchClock(endsAt, winScore)
      if (endsAt != null) hud.setDummyButtonState(false)
    })
    game.setMatchEndListener((info) => {
      try {
        document.exitPointerLock()
      } catch {
        /* ignore */
      }
      const offlineLocal = info.scores.some((s) => s.id === 'local_player')
      hud.setDummyButtonState(false)
      if (offlineLocal) {
        // Solo: show settlement first; reset field + lobby only after dismiss
        // (avoid mid-reset “blue sky” + unclickable UI under pointer lock)
        hud.showMatchEnd(info, 'local_player', {
          solo: true,
          onDismiss: () => {
            game.cleanupAfterOfflineMatch()
            lobby.show()
            lobby.flashMatchEnd(info.message)
          },
        })
      } else {
        hud.showMatchEnd(info, net.playerId)
        lobby.show()
        lobby.flashMatchEnd(info.message)
      }
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
      if (game.isOfflineSolo()) {
        hud.handleFeedback({
          type: 'toast',
          text: '单机模式暂不支持调试加道具',
          kind: 'bad',
        })
        return
      }
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
      if (game.isOfflineSolo()) {
        hud.handleFeedback({
          type: 'toast',
          text: '单机模式暂不支持木头人',
          kind: 'bad',
        })
        return
      }
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
    })
    game.start()
  })
  .catch((err) => {
    console.error(err)
    hud.setError(String(err))
  })
