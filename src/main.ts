import { Graphics } from 'pixi.js'
import { createApp } from './render/app'
import { PUZZLE_BUILD_VERSION } from './core'

const { app, backend } = await createApp(document.body)

console.log(`renderer backend: ${backend}`)
console.log(`core contract version: ${PUZZLE_BUILD_VERSION}`)

// Placeholder so there is something on screen.
// Pixi v8 chains shape then fill; v7 used beginFill / drawRoundedRect / endFill, which no longer exists.
const box = new Graphics().roundRect(0, 0, 160, 160, 20).fill(0xc88b6a)
box.pivot.set(80, 80)
box.position.set(app.screen.width / 2, app.screen.height / 2)
app.stage.addChild(box)

// The v8 ticker hands you a Ticker object, not a plain deltaTime number.
// deltaMS keeps the speed the same regardless of frame rate.
app.ticker.add((ticker) => {
  box.rotation += ticker.deltaMS * 0.0006
})
