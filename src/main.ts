import './style.css'
import { Game } from './core/Game'
import { GameHud } from './ui/GameHud'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) {
  throw new Error('#app not found')
}

const hud = new GameHud()
const game = new Game(app, (fb) => hud.handleFeedback(fb))

game
  .init()
  .then(() => {
    game.setPointerLockListener((locked) => hud.setPointerLocked(locked))
    game.start()
  })
  .catch((err) => {
    console.error(err)
    hud.setError(String(err))
  })
