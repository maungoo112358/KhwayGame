import { Application, RendererType } from 'pixi.js'

export interface GameApp {
  app: Application
  backend: 'webgl' | 'webgpu'
}

export async function createApp(container: HTMLElement): Promise<GameApp> {
  const app = new Application()

  await app.init({
    resizeTo: container,
    background: 0xede6da,
    antialias: true,
    // autoDensity + resolution keep the canvas sharp on high dpi screens without us doing the scaling arithmetic ourselves
    autoDensity: true,
    resolution: window.devicePixelRatio,
    // Pinned to WebGL on purpose.
    // Tauri runs on the OS webview, where WebGPU is unreliable on macOS and Linux, so we develop against the backend the desktop build will get. D15.
    preference: 'webgl',
  })

  container.appendChild(app.canvas)

  return {
    app,
    backend: app.renderer.type === RendererType.WEBGL ? 'webgl' : 'webgpu',
  }
}
