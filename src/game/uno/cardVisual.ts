import * as THREE from 'three'
import {
  UNO_COLOR_HEX,
  cardLabel,
  rankLabel,
  type UnoCardData,
} from './types'

export const CARD_W = 0.72
export const CARD_H = 1.05
export const CARD_D = 0.04

export function makeFaceTexture(card: UnoCardData): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 384
  const ctx = canvas.getContext('2d')!

  const bg = `#${UNO_COLOR_HEX[card.color].toString(16).padStart(6, '0')}`

  ctx.fillStyle = bg
  roundRect(ctx, 0, 0, 256, 384, 24)
  ctx.fill()

  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 10
  roundRect(ctx, 14, 14, 228, 356, 18)
  ctx.stroke()

  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.beginPath()
  ctx.ellipse(128, 192, 78, 110, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = bg
  ctx.font = 'bold 96px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(rankLabel(card.rank), 128, 192)

  ctx.fillStyle = '#fff'
  ctx.font = 'bold 36px system-ui, sans-serif'
  ctx.fillText(cardLabel(card), 128, 48)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Upright card mesh; both faces show the card. Caller owns dispose. */
export function createCardMesh(
  card: UnoCardData,
  scale = 1,
): { mesh: THREE.Mesh; texture: THREE.CanvasTexture } {
  const texture = makeFaceTexture(card)
  const faceMat = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.45,
    metalness: 0.05,
  })
  const faceMatBack = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.45,
    metalness: 0.05,
  })
  const edgeMat = new THREE.MeshStandardMaterial({
    color: 0xf8fafc,
    roughness: 0.6,
  })
  const geo = new THREE.BoxGeometry(CARD_W * scale, CARD_H * scale, CARD_D * scale)
  const mesh = new THREE.Mesh(geo, [
    edgeMat,
    edgeMat,
    edgeMat,
    edgeMat,
    faceMat,
    faceMatBack,
  ])
  mesh.castShadow = true
  return { mesh, texture }
}

export function disposeCardMesh(mesh: THREE.Mesh, texture: THREE.CanvasTexture): void {
  mesh.geometry.dispose()
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  for (const m of mats) m.dispose()
  texture.dispose()
}
