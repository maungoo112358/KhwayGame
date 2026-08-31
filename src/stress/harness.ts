// The measurement harness for Phase 5. Generic on purpose: frame times, pick latency, and drag latency
// all reduce to "a list of millisecond samples in, five numbers out", so nothing here knows what it is
// timing. Lives in src/stress/ (see D-note in phase5.md), under the same nothing-imports-stress boundary
// as main.ts, not a separate top level folder, so no dependency-cruiser rule needed for it.

import type { Container, Ticker } from 'pixi.js'

export interface Percentiles {
  p50: number
  p90: number
  p95: number
  p99: number
  max: number
}

// Nearest-rank method: sort, then index by the fraction of the way through the sorted list.
// Assumes samples is non-empty, callers always have real recorded data by the time this runs.
export function percentiles(samples: number[]): Percentiles {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!

  return {
    p50: at(0.5),
    p90: at(0.9),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1]!,
  }
}

export interface FrameRecorder {
  start(): void
  stop(): void
  samples(): number[]
}

// Hooks the Pixi ticker directly rather than requestAnimationFrame, so "a frame" here means exactly
// what Pixi itself just rendered, deltaMS included, not a second, slightly different clock.
export function createFrameRecorder(ticker: Ticker): FrameRecorder {
  let recording = false
  const times: number[] = []

  ticker.add((tick) => {
    if (recording) times.push(tick.deltaMS)
  })

  return {
    start() {
      times.length = 0
      recording = true
    },
    stop() {
      recording = false
    },
    samples() {
      return times
    },
  }
}

// Moves board.position by a fixed total distance over a fixed duration, driven by the ticker's own
// deltaMS each frame rather than a frame count, so the pan takes the same real time and covers the same
// real distance whether the page is running at 60fps or 20fps, which is what makes two runs comparable.
export function scriptedPan(ticker: Ticker, board: Container, distanceX: number, distanceY: number, durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    const startX = board.position.x
    const startY = board.position.y
    let elapsed = 0

    function onTick(tick: Ticker): void {
      elapsed += tick.deltaMS
      const progress = Math.min(elapsed / durationMs, 1)
      board.position.set(startX + distanceX * progress, startY + distanceY * progress)

      if (progress >= 1) {
        ticker.remove(onTick)
        resolve()
      }
    }

    ticker.add(onTick)
  })
}

// Same shape as scriptedPan, ticker-driven so two runs are comparable, but moves a plain probe point
// instead of the board, and calls the caller's pick function directly against it every tick, timed under
// the given label. The naive pick test costs roughly the same regardless of where the probe is (it checks
// every piece regardless of a hit), so the exact path matters far less here than it did for panning.
export function scriptedProbe(
  ticker: Ticker,
  startX: number,
  startY: number,
  distanceX: number,
  distanceY: number,
  durationMs: number,
  label: string,
  pick: (point: { x: number; y: number }) => void,
): Promise<void> {
  return new Promise((resolve) => {
    let elapsed = 0

    function onTick(tick: Ticker): void {
      elapsed += tick.deltaMS
      const progress = Math.min(elapsed / durationMs, 1)
      const point = { x: startX + distanceX * progress, y: startY + distanceY * progress }
      measure(label, () => pick(point))

      if (progress >= 1) {
        ticker.remove(onTick)
        resolve()
      }
    }

    ticker.add(onTick)
  })
}

// Same ticker-driven, progress-based shape as scriptedPan, but hands the caller each tick's incremental
// delta instead of setting one absolute position, since what moves here is many individual sprite
// positions (a whole cluster), not one container's own transform.
export function scriptedClusterMove(ticker: Ticker, distanceX: number, distanceY: number, durationMs: number, onMove: (deltaX: number, deltaY: number) => void): Promise<void> {
  return new Promise((resolve) => {
    let elapsed = 0;
    let movedX = 0;
    let movedY = 0;

    function onTick(tick: Ticker): void {
      elapsed += tick.deltaMS;
      const progress = Math.min(elapsed / durationMs, 1);
      const targetX = distanceX * progress;
      const targetY = distanceY * progress;
      onMove(targetX - movedX, targetY - movedY);
      movedX = targetX;
      movedY = targetY;

      if (progress >= 1) {
        ticker.remove(onTick);
        resolve();
      }
    }

    ticker.add(onTick);
  });
}

interface Measurement {
  label: string
  ms: number
}

// One shared list rather than a map of arrays, so measurementsFor's filter is the only place that
// needs to know about labels, adding a new one never means touching this file again.
const measurements: Measurement[] = []

// Generic timing hook: call it around picking or dragging code with a label, and it stays out of the
// way entirely, this is the "Claude never has to reach into your mechanics to time them" piece.
export function measure<T>(label: string, fn: () => T): T {
  const started = performance.now()
  const result = fn()
  measurements.push({ label, ms: performance.now() - started })
  return result
}

export function measurementsFor(label: string): number[] {
  return measurements.filter((entry) => entry.label === label).map((entry) => entry.ms)
}

// Not needed for a single run, but a benchmark button that can be pressed twice without a page reload
// needs a way to start clean, otherwise the second run's percentiles include the first run's samples too.
export function clearMeasurements(label: string): void {
  for (let i = measurements.length - 1; i >= 0; i--) {
    if (measurements[i]!.label === label) measurements.splice(i, 1)
  }
}

// The non-standard Chrome-only API this project already leans on Chromium for elsewhere (the pinned
// Playwright screenshots). Not in the default DOM lib, declared narrowly here rather than widened globally.
interface ChromeMemoryInfo {
  usedJSHeapSize: number
}

export interface MemoryReadout {
  heapMB: number | null
  vramEstimateMB: number
}

// VRAM is an estimate, not a measurement: the browser exposes no real GPU memory API. Atlas sheets are
// the only meaningful cost here (see docs/architecture.md's VRAM budget), RGBA at 4 bytes per pixel.
export function readMemory(atlasCount: number, sheetSize: number): MemoryReadout {
  const memory = (performance as Performance & { memory?: ChromeMemoryInfo }).memory

  return {
    heapMB: memory ? memory.usedJSHeapSize / 1e6 : null,
    vramEstimateMB: (atlasCount * sheetSize * sheetSize * 4) / 1e6,
  }
}

// 1000ms / 55fps, the phase's own gate number, named once here rather than repeated at every call site.
export const FRAME_BUDGET_MS = 1000 / 55

export function passesFrameBudget(p95: number): boolean {
  return p95 <= FRAME_BUDGET_MS
}

// Deliberately just textContent with newlines, not a table or styled rows: this panel is read once per
// benchmark run, not stared at continuously, and #readout already proved a plain monospace block is
// legible enough for that.
export function renderPanel(el: HTMLElement, lines: string[]): void {
  el.textContent = lines.join('\n')
}

// The simplest possible trigger: press a key anywhere on the page, run the callback. A caller wires this
// to whichever specific benchmark it wants started, this file has no opinion on what that is.
export function onKeyPress(key: string, handler: () => void): void {
  document.addEventListener('keydown', (event) => {
    if (event.key === key) handler()
  })
}
