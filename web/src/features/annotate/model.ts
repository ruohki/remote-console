/**
 * Pure logic for operator annotations (pen strokes + laser pointer) drawn over the remote
 * screen. The browser renders its own copy locally (so the operator sees exactly what the
 * person at the device sees, independent of the video stream) and streams the same data to
 * the agent over the control channel.
 *
 * Coordinates everywhere here are **physical pixels of the remote display** (what the agent
 * expects); mapping from the tile happens in the canvas/tile code via `toRemotePixels`.
 */
import type { ControlMessage } from '@/protocol'

export type AnnotateTool = 'pen' | 'laser'
export type StrokeWidth = 'thin' | 'thick'

export const ANNOTATE_COLORS = [
  { id: 'red', value: '#ef4444', label: 'Red' },
  { id: 'yellow', value: '#facc15', label: 'Yellow' },
  { id: 'blue', value: '#3b82f6', label: 'Blue' },
  { id: 'green', value: '#22c55e', label: 'Green' },
] as const
export type AnnotateColorId = (typeof ANNOTATE_COLORS)[number]['id']

/** Line widths in CSS pixels of the *remote* display; multiplied by its scale for physical px. */
export const STROKE_WIDTH_CSS: Record<StrokeWidth, number> = { thin: 3, thick: 6 }

/** A finished stroke stays fully visible this long, then fades out. */
export const FADE_HOLD_MS = 4000
/** Duration of the fade-out itself. */
export const FADE_MS = 700
/** The laser dot disappears this long after the last position update. */
export const POINTER_TTL_MS = 1000
/** Minimum distance between two recorded points (physical pixels). */
export const MIN_POINT_DISTANCE = 2

export type Point = [number, number]

export interface Stroke {
  id: number
  display: number
  color: string
  /** physical pixels */
  width: number
  points: Point[]
  /** set when the stroke is finished (fade timer starts) */
  endedAt: number | null
}

export interface Pointer {
  display: number
  point: Point
  color: string
  at: number
}

export interface AnnotationLayer {
  strokes: Stroke[]
  pointer: Pointer | null
}

export const emptyLayer: AnnotationLayer = { strokes: [], pointer: null }

/** Physical stroke width for a remote display scale (Retina → 2×). */
export function strokeWidthPx(width: StrokeWidth, displayScale: number): number {
  return Math.max(1, Math.round(STROKE_WIDTH_CSS[width] * (displayScale > 0 ? displayScale : 1)))
}

function dist2(a: Point, b: Point): number {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  return dx * dx + dy * dy
}

/**
 * Collects pointer samples for one stroke and turns them into `annotate_stroke` messages.
 * Points closer than `MIN_POINT_DISTANCE` to the last recorded point are dropped; `flush`
 * is meant to be called once per animation frame and returns the batch to send (or null).
 * Ids come from a shared counter so every stroke of a session is unique.
 */
export class StrokeBatcher {
  private static nextId = 1
  readonly id: number
  readonly display: number
  readonly color: string
  readonly width: number
  private pending: Point[] = []
  private last: Point | null = null
  private started = false
  private ended = false

  constructor(display: number, color: string, width: number) {
    this.id = StrokeBatcher.nextId++
    this.display = display
    this.color = color
    this.width = width
  }

  /** Reset the id sequence (tests). */
  static resetIds(): void {
    StrokeBatcher.nextId = 1
  }

  /** Record a point; returns false when it was too close to the previous one. */
  push(p: Point): boolean {
    if (this.ended) return false
    if (this.last && dist2(this.last, p) < MIN_POINT_DISTANCE * MIN_POINT_DISTANCE) return false
    this.last = p
    this.pending.push(p)
    return true
  }

  /** Message for the points recorded since the last flush (the first message starts the stroke). */
  flush(): ControlMessage | null {
    if (this.pending.length === 0) return null
    const points = this.pending
    this.pending = []
    this.started = true
    return { t: 'annotate_stroke', id: this.id, display: this.display, color: this.color, width: this.width, points }
  }

  /** Messages to finish the stroke: a final point batch (if any) followed by `annotate_end`. */
  end(): ControlMessage[] {
    this.ended = true
    const out: ControlMessage[] = []
    const rest = this.flush()
    if (rest) out.push(rest)
    if (this.started) out.push({ t: 'annotate_end', id: this.id })
    return out
  }

  get hasStarted(): boolean {
    return this.started
  }
}

/** Throttle helper for the laser pointer (≤ `hz` updates per second). */
export class PointerThrottle {
  private lastSent = 0
  private readonly hz: number
  constructor(hz = 30) {
    this.hz = hz
  }
  /** Returns true when a message may be sent now. */
  allow(now: number): boolean {
    if (now - this.lastSent < 1000 / this.hz) return false
    this.lastSent = now
    return true
  }
}

/* ───────────── local layer reducer ───────────── */

/** Append points to a stroke (creating it on first sight). */
export function layerStroke(layer: AnnotationLayer, msg: Extract<ControlMessage, { t: 'annotate_stroke' }>): AnnotationLayer {
  const idx = layer.strokes.findIndex((s) => s.id === msg.id)
  if (idx === -1) {
    const stroke: Stroke = { id: msg.id, display: msg.display, color: msg.color, width: msg.width, points: [...msg.points], endedAt: null }
    return { ...layer, strokes: [...layer.strokes, stroke] }
  }
  const strokes = layer.strokes.slice()
  const s = strokes[idx]!
  strokes[idx] = { ...s, points: s.points.concat(msg.points), endedAt: null }
  return { ...layer, strokes }
}

/** Mark a stroke finished at `now`. Strokes ended within `FADE_HOLD_MS` of an earlier one fade together. */
export function layerEnd(layer: AnnotationLayer, id: number, now: number): AnnotationLayer {
  const idx = layer.strokes.findIndex((s) => s.id === id)
  if (idx === -1) return layer
  const strokes = layer.strokes.slice()
  strokes[idx] = { ...strokes[idx]!, endedAt: now }
  return { ...layer, strokes }
}

export function layerPointer(layer: AnnotationLayer, display: number, point: Point | null, color: string, now: number): AnnotationLayer {
  return { ...layer, pointer: point ? { display, point, color, at: now } : null }
}

export function layerClear(): AnnotationLayer {
  return emptyLayer
}

/** Remove the last stroke that has not fully faded yet. Returns the new layer and the removed stroke. */
export function layerUndo(layer: AnnotationLayer, now: number): { layer: AnnotationLayer; removed: Stroke | null } {
  const live = layer.strokes.filter((s) => strokeAlpha(s, now) > 0)
  if (live.length === 0) return { layer, removed: null }
  const removed = live[live.length - 1]!
  return { layer: { ...layer, strokes: layer.strokes.filter((s) => s.id !== removed.id) }, removed }
}

/** 1 while drawing / holding, then linearly down to 0 over `FADE_MS`. */
export function strokeAlpha(s: Stroke, now: number): number {
  if (s.endedAt === null) return 1
  const t = now - s.endedAt - FADE_HOLD_MS
  if (t <= 0) return 1
  if (t >= FADE_MS) return 0
  return 1 - t / FADE_MS
}

export function pointerAlpha(p: Pointer | null, now: number): number {
  if (!p) return 0
  const age = now - p.at
  if (age >= POINTER_TTL_MS) return 0
  // stays solid for most of its life, fades in the last 30 %
  const fadeStart = POINTER_TTL_MS * 0.7
  return age <= fadeStart ? 1 : 1 - (age - fadeStart) / (POINTER_TTL_MS - fadeStart)
}

/** Drop everything that is invisible now. */
export function layerPrune(layer: AnnotationLayer, now: number): AnnotationLayer {
  const strokes = layer.strokes.filter((s) => strokeAlpha(s, now) > 0)
  const pointer = pointerAlpha(layer.pointer, now) > 0 ? layer.pointer : null
  if (strokes.length === layer.strokes.length && pointer === layer.pointer) return layer
  return { strokes, pointer }
}

/** Whether the layer still has anything worth drawing (drives the render loop). */
export function layerHasContent(layer: AnnotationLayer, now: number): boolean {
  return layer.strokes.some((s) => strokeAlpha(s, now) > 0) || pointerAlpha(layer.pointer, now) > 0
}

/** Messages that recreate the still-visible strokes on the device (used by Undo after a clear). */
export function replayMessages(layer: AnnotationLayer, now: number): ControlMessage[] {
  const out: ControlMessage[] = []
  for (const s of layer.strokes) {
    if (strokeAlpha(s, now) <= 0 || s.points.length === 0) continue
    out.push({ t: 'annotate_stroke', id: s.id, display: s.display, color: s.color, width: s.width, points: s.points })
    if (s.endedAt !== null) out.push({ t: 'annotate_end', id: s.id })
  }
  return out
}
