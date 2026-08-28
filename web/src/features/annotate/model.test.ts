import { beforeEach, describe, expect, it } from 'vitest'
import { toRemotePixels } from '@/lib/geometry'
import type { ControlMessage } from '@/protocol'
import {
  FADE_HOLD_MS,
  FADE_MS,
  POINTER_TTL_MS,
  PointerThrottle,
  StrokeBatcher,
  emptyLayer,
  layerClear,
  layerEnd,
  layerHasContent,
  layerPointer,
  layerPrune,
  layerStroke,
  layerUndo,
  pointerAlpha,
  replayMessages,
  strokeAlpha,
  strokeWidthPx,
} from './model'

type StrokeMsg = Extract<ControlMessage, { t: 'annotate_stroke' }>

describe('StrokeBatcher', () => {
  beforeEach(() => StrokeBatcher.resetIds())

  it('assigns increasing ids per stroke and starts with the first flush', () => {
    const a = new StrokeBatcher(0, '#ef4444', 6)
    const b = new StrokeBatcher(1, '#3b82f6', 6)
    expect(a.id).toBe(1)
    expect(b.id).toBe(2)
    expect(a.flush()).toBeNull() // nothing recorded yet
    a.push([10, 10])
    const m = a.flush() as StrokeMsg
    expect(m).toEqual({ t: 'annotate_stroke', id: 1, display: 0, color: '#ef4444', width: 6, points: [[10, 10]] })
    expect(a.hasStarted).toBe(true)
  })

  it('thins points closer than 2 px and batches the rest per flush', () => {
    const s = new StrokeBatcher(0, '#000', 3)
    expect(s.push([0, 0])).toBe(true)
    expect(s.push([1, 0])).toBe(false) // too close
    expect(s.push([1.5, 1])).toBe(false)
    expect(s.push([2, 0])).toBe(true)
    expect(s.push([10, 10])).toBe(true)
    const m = s.flush() as StrokeMsg
    expect(m.points).toEqual([
      [0, 0],
      [2, 0],
      [10, 10],
    ])
    expect(s.flush()).toBeNull()
    s.push([20, 20])
    expect((s.flush() as StrokeMsg).points).toEqual([[20, 20]])
  })

  it('end() sends the remaining points then annotate_end, and nothing for an empty stroke', () => {
    const s = new StrokeBatcher(2, '#fff', 4)
    s.push([5, 5])
    s.flush()
    s.push([9, 9])
    const out = s.end()
    expect(out.map((m) => m.t)).toEqual(['annotate_stroke', 'annotate_end'])
    expect((out[1] as { id: number }).id).toBe(s.id)
    expect(s.push([1, 1])).toBe(false)

    const empty = new StrokeBatcher(0, '#fff', 4)
    expect(empty.end()).toEqual([])
  })
})

describe('PointerThrottle', () => {
  it('allows at most hz updates per second', () => {
    const t = new PointerThrottle(30)
    expect(t.allow(1000)).toBe(true)
    expect(t.allow(1010)).toBe(false)
    expect(t.allow(1034)).toBe(true)
  })
})

describe('coordinate mapping (shared with input)', () => {
  it('maps tile coordinates to physical pixels of the remote display', () => {
    // 1920×1080 remote picture shown letterboxed in a 960×600 tile → content 960×540 at top 30
    const p = toRemotePixels({ x: 480, y: 300 }, { width: 960, height: 600 }, { width: 1920, height: 1080 })
    expect(p).toEqual({ x: 960, y: 540 })
    expect(toRemotePixels({ x: 480, y: 10 }, { width: 960, height: 600 }, { width: 1920, height: 1080 })).toBeNull()
  })

  it('scales line widths with the display scale', () => {
    expect(strokeWidthPx('thin', 1)).toBe(3)
    expect(strokeWidthPx('thin', 2)).toBe(6)
    expect(strokeWidthPx('thick', 2)).toBe(12)
    expect(strokeWidthPx('thin', 0)).toBe(3)
  })
})

describe('annotation layer', () => {
  const stroke = (id: number, points: [number, number][]): StrokeMsg => ({ t: 'annotate_stroke', id, display: 0, color: '#ef4444', width: 6, points })

  it('creates and appends strokes, ends them and fades after the hold time', () => {
    let layer = layerStroke(emptyLayer, stroke(1, [[0, 0]]))
    layer = layerStroke(layer, stroke(1, [[10, 10]]))
    expect(layer.strokes).toHaveLength(1)
    expect(layer.strokes[0]!.points).toEqual([
      [0, 0],
      [10, 10],
    ])
    expect(strokeAlpha(layer.strokes[0]!, 999_999)).toBe(1) // still drawing → no fade
    layer = layerEnd(layer, 1, 1000)
    const s = layer.strokes[0]!
    expect(strokeAlpha(s, 1000 + FADE_HOLD_MS - 1)).toBe(1)
    expect(strokeAlpha(s, 1000 + FADE_HOLD_MS + FADE_MS / 2)).toBeCloseTo(0.5, 5)
    expect(strokeAlpha(s, 1000 + FADE_HOLD_MS + FADE_MS)).toBe(0)
    expect(layerHasContent(layer, 1000 + FADE_HOLD_MS + 10)).toBe(true)
    const pruned = layerPrune(layer, 1000 + FADE_HOLD_MS + FADE_MS + 1)
    expect(pruned.strokes).toHaveLength(0)
    expect(layerHasContent(pruned, 1000 + FADE_HOLD_MS + FADE_MS + 1)).toBe(false)
  })

  it('pointer expires after its TTL and clear removes everything', () => {
    let layer = layerPointer(emptyLayer, 0, [5, 5], '#facc15', 0)
    expect(pointerAlpha(layer.pointer, 0)).toBe(1)
    expect(pointerAlpha(layer.pointer, POINTER_TTL_MS * 0.7)).toBe(1)
    expect(pointerAlpha(layer.pointer, POINTER_TTL_MS)).toBe(0)
    expect(layerPrune(layer, POINTER_TTL_MS).pointer).toBeNull()
    layer = layerPointer(layer, 0, null, '#facc15', 1)
    expect(layer.pointer).toBeNull()
    layer = layerStroke(layer, stroke(3, [[1, 1]]))
    expect(layer.strokes).toHaveLength(1)
    expect(layerClear().strokes).toHaveLength(0)
  })

  it('undo removes the newest visible stroke and replay recreates the rest', () => {
    let layer = layerStroke(emptyLayer, stroke(1, [[0, 0], [5, 5]]))
    layer = layerEnd(layer, 1, 100)
    layer = layerStroke(layer, stroke(2, [[7, 7]]))
    const { layer: after, removed } = layerUndo(layer, 200)
    expect(removed?.id).toBe(2)
    expect(after.strokes.map((s) => s.id)).toEqual([1])
    const replay = replayMessages(after, 200)
    expect(replay.map((m) => m.t)).toEqual(['annotate_stroke', 'annotate_end'])
    expect((replay[0] as StrokeMsg).points).toEqual([
      [0, 0],
      [5, 5],
    ])
    // a fully faded stroke is not undoable nor replayed
    const faded = layerEnd(layerStroke(emptyLayer, stroke(9, [[1, 1]])), 9, 0)
    expect(layerUndo(faded, FADE_HOLD_MS + FADE_MS + 1).removed).toBeNull()
    expect(replayMessages(faded, FADE_HOLD_MS + FADE_MS + 1)).toEqual([])
  })
})
