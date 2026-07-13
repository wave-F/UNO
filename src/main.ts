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
    game.setPointerLockListener((locked) => hud.setPointerLocked(locked))
    game.start()
  })
  .catch((err) => {
    console.error(err)
    hud.setError(String(err))
  })
