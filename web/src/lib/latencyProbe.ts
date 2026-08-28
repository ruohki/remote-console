/**
 * In-page glass-to-glass latency probe for the synthetic agent source.
 *
 * The agent (`REMOTE_AGENT_SYNTHETIC_SOURCE=1`) draws a strip of 13 black/white cells along
 * the top edge of the picture (see `perf.ts`): 12 timestamp bits + parity. On every decoded
 * video frame (`requestVideoFrameCallback`) the probe copies just that strip into a tiny
 * offscreen canvas, reads one luminance sample per cell and computes `now − timestamp`.
 * Both clocks are the same machine's wall clock in the rig, so the difference is the
 * capture → paint latency. Samples stay in memory for the stats overlay and the rig script.
 */
import { STRIP_CELLS, STRIP_CELL_PX, decodeStrip, percentile, stripLatencyMs } from './perf'

/** Native width of the synthetic source frame the strip is laid out for. */
const SOURCE_WIDTH_PX = 1920

export interface LatencySample {
  at: number
  latencyMs: number
}

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: DOMHighResTimeStamp, meta: { presentedFrames?: number }) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

export function rvfcSupported(): boolean {
  return typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype
}

export class LatencyProbe {
  private handle: number | null = null
  private canvas: HTMLCanvasElement | null = null
  private samples: LatencySample[] = []
  private decodeFailures = 0
  private lastStamp: number | null = null
  private frames = 0
  private readonly maxSamples: number
  private readonly video: VideoWithRvfc

  constructor(video: VideoWithRvfc, maxSamples = 2000) {
    this.video = video
    this.maxSamples = maxSamples
  }

  start() {
    if (this.handle !== null || !this.video.requestVideoFrameCallback) return
    this.canvas = document.createElement('canvas')
    this.canvas.width = STRIP_CELLS
    this.canvas.height = 1
    const tick = () => {
      this.handle = null
      this.sample()
      this.handle = this.video.requestVideoFrameCallback!(tick)
    }
    this.handle = this.video.requestVideoFrameCallback(tick)
  }

  stop() {
    if (this.handle !== null) this.video.cancelVideoFrameCallback?.(this.handle)
    this.handle = null
  }

  reset() {
    this.samples = []
    this.decodeFailures = 0
    this.lastStamp = null
    this.frames = 0
  }

  /** Copy of the samples collected so far (oldest first). */
  snapshot(): { samples: LatencySample[]; frames: number; decodeFailures: number; medianMs: number | null; p95Ms: number | null } {
    const values = this.samples.map((s) => s.latencyMs)
    return { samples: [...this.samples], frames: this.frames, decodeFailures: this.decodeFailures, medianMs: percentile(values, 50), p95Ms: percentile(values, 95) }
  }

  private sample() {
    const v = this.video
    const c = this.canvas
    if (!c || !v.videoWidth) return
    this.frames++
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    // Scale the strip (top-left 13 cells × 64 px) down to one pixel per cell: the average
    // luminance of a cell is robust against codec ringing at the cell edges.
    // The agent may encode a downscaled picture (viewport hint), so the strip geometry is
    // scaled by the decoded width relative to the synthetic source's native 1920 px.
    const scale = v.videoWidth / SOURCE_WIDTH_PX
    if (!(scale > 0)) return
    const stripW = STRIP_CELLS * STRIP_CELL_PX * scale
    ctx.drawImage(v, 0, 8 * scale, stripW, (STRIP_CELL_PX - 16) * scale, 0, 0, STRIP_CELLS, 1)
    const data = ctx.getImageData(0, 0, STRIP_CELLS, 1).data
    const luma: number[] = []
    for (let i = 0; i < STRIP_CELLS; i++) {
      const o = i * 4
      luma.push(0.2126 * data[o]! + 0.7152 * data[o + 1]! + 0.0722 * data[o + 2]!)
    }
    const d = decodeStrip(luma)
    if (!d.ok) {
      this.decodeFailures++
      return
    }
    // Idle refreshes repeat the previous picture with its old stamp; only a *new* stamp
    // measures change-to-visible latency, so repeated stamps are skipped (not failures).
    if (d.ms === this.lastStamp) return
    this.lastStamp = d.ms
    const latencyMs = stripLatencyMs(d.ms, Date.now())
    // Anything above 3 s is a wrap-around artifact (the strip only carries 12 bits).
    if (latencyMs > 3000) {
      this.decodeFailures++
      return
    }
    this.samples.push({ at: Date.now(), latencyMs })
    if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples)
  }
}
