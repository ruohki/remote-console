import { describe, expect, it } from 'vitest'
import { FAST_CHANNEL_GRACE_MS, LOCAL_CURSOR_TTL_MS, cursorDrawPoint, cursorOverlayMode, cursorPredictionAllowed, STRIP_CELLS, STRIP_MODULO, cursorPlacement, decodeStrip, encodeStrip, moveChannel, percentile, stripLatencyMs, viewportHint } from './perf'

describe('viewportHint', () => {
  const display = { width: 5120, height: 2160 }
  it('asks for a downscaled picture when the tile is smaller than the display', () => {
    const h = viewportHint({ width: 1280, height: 720 }, display, 2, false)
    // content area of a 5120×2160 picture inside 1280×720 (contain) is 1280×540 → ×2 dpr
    expect(h).toEqual({ width: 2560, height: 1080 })
  })
  it('keeps the aspect and even sizes', () => {
    const h = viewportHint({ width: 1001, height: 999 }, { width: 1919, height: 1081 }, 1, false)
    expect(h.width! % 2).toBe(0)
    expect(h.height! % 2).toBe(0)
    expect(Math.abs(h.width! / h.height! - 1919 / 1081)).toBeLessThan(0.01)
  })
  it('requests full resolution in fullscreen or when the tile is at least native size', () => {
    expect(viewportHint({ width: 800, height: 600 }, display, 2, true)).toEqual({ width: null, height: null })
    expect(viewportHint({ width: 2560, height: 1080 }, display, 2, false)).toEqual({ width: null, height: null })
    expect(viewportHint({ width: 0, height: 0 }, display, 2, false)).toEqual({ width: null, height: null })
  })
})

describe('cursorOverlayMode', () => {
  it('always draws the cursor the device reports: it is the only one in the picture', () => {
    // An agent that streams cursor updates captures without the system cursor, and the tile
    // hides the operator's own pointer while controlling — suppressing this leaves nothing.
    expect(cursorOverlayMode({ deviceVisible: true, controlling: true })).toBe('solid')
    expect(cursorOverlayMode({ deviceVisible: true, controlling: false })).toBe('solid')
  })

  it('dims for whoever is controlling when the device reports no cursor', () => {
    // Windows hides the pointer while typing, and tools like Parsec suppress it.
    expect(cursorOverlayMode({ deviceVisible: false, controlling: true })).toBe('dimmed')
  })

  it('shows nothing to an observer when the device has no cursor', () => {
    expect(cursorOverlayMode({ deviceVisible: false, controlling: false })).toBe('hidden')
  })
})

describe('cursorPredictionAllowed', () => {
  it('runs ahead only while nothing is being dragged', () => {
    expect(cursorPredictionAllowed({ controlling: true, buttons: 0 })).toBe(true)
    // Any held button means the device is dragging something that follows its real pointer.
    expect(cursorPredictionAllowed({ controlling: true, buttons: 1 })).toBe(false)
    expect(cursorPredictionAllowed({ controlling: true, buttons: 2 })).toBe(false)
    expect(cursorPredictionAllowed({ controlling: false, buttons: 0 })).toBe(false)
  })
})

describe('cursorDrawPoint', () => {
  const remote = { display: 0, x: 100, y: 100 }

  it('follows the operator while they are moving a tile they control', () => {
    const local = { display: 0, x: 900, y: 400, at: 1_000 }
    expect(cursorDrawPoint({ remote, local, controlling: true, now: 1_000 })).toEqual({ x: 900, y: 400 })
    // Still theirs one slow mouse report later.
    expect(cursorDrawPoint({ remote, local, controlling: true, now: 1_000 + LOCAL_CURSOR_TTL_MS })).toEqual({ x: 900, y: 400 })
  })

  it('settles onto the device once the operator stops moving', () => {
    const local = { display: 0, x: 900, y: 400, at: 1_000 }
    expect(cursorDrawPoint({ remote, local, controlling: true, now: 1_001 + LOCAL_CURSOR_TTL_MS })).toEqual({ x: 100, y: 100 })
  })

  it('never predicts for an observer, another display, or with no pointer on the tile', () => {
    const local = { display: 0, x: 900, y: 400, at: 1_000 }
    expect(cursorDrawPoint({ remote, local, controlling: false, now: 1_000 })).toEqual({ x: 100, y: 100 })
    expect(cursorDrawPoint({ remote, local: { ...local, display: 1 }, controlling: true, now: 1_000 })).toEqual({ x: 100, y: 100 })
    expect(cursorDrawPoint({ remote, local: null, controlling: true, now: 1_000 })).toEqual({ x: 100, y: 100 })
  })
})

describe('cursorPlacement', () => {
  const shape = { id: 1, hotspotX: 4, hotspotY: 2, width: 32, height: 32 }
  it('maps the hotspot into the letterboxed picture and scales the image', () => {
    // 1920×1080 picture in a 960×600 box → scale 0.5, content 960×540 at top 30
    const p = cursorPlacement({ x: 100, y: 50 }, shape, { width: 960, height: 600 }, { width: 1920, height: 1080 })
    expect(p).toEqual({ left: (100 - 4) * 0.5, top: 30 + (50 - 2) * 0.5, width: 16, height: 16 })
  })
  it('maps against the display size, not a downscaled encoded picture', () => {
    // 2880×1800 display encoded at 1440×900 and shown in a 1440×900 box: the cursor at the
    // display's centre lands in the box's centre at half size.
    const p = cursorPlacement({ x: 1440, y: 900 }, { ...shape, hotspotX: 0, hotspotY: 0 }, { width: 1440, height: 900 }, { width: 2880, height: 1800 })
    expect(p).toEqual({ left: 720, top: 450, width: 16, height: 16 })
  })
  it('returns null outside the picture or without geometry', () => {
    expect(cursorPlacement({ x: -1, y: 0 }, shape, { width: 960, height: 600 }, { width: 1920, height: 1080 })).toBeNull()
    expect(cursorPlacement({ x: 10, y: 10 }, shape, { width: 0, height: 0 }, { width: 1920, height: 1080 })).toBeNull()
  })
})

describe('latency strip codec', () => {
  it('round-trips a timestamp through encode → luminance → decode', () => {
    for (const ts of [0, 1, 4095, 4096, 123456789, Date.now()]) {
      const bits = encodeStrip(ts)
      expect(bits).toHaveLength(STRIP_CELLS)
      const luma = bits.map((b) => (b ? 240 : 12))
      const d = decodeStrip(luma)
      expect(d.ok).toBe(true)
      expect(d.ms).toBe(ts % STRIP_MODULO)
    }
  })
  it('flags a parity failure and a flat (non-strip) region', () => {
    const luma = encodeStrip(1234).map((b) => (b ? 255 : 0))
    luma[3] = luma[3] === 255 ? 0 : 255
    expect(decodeStrip(luma).ok).toBe(false)
    const noMarker = encodeStrip(77).map((b) => (b ? 255 : 0))
    noMarker[0] = 0
    expect(decodeStrip(noMarker).ok).toBe(false)
    expect(decodeStrip(new Array(STRIP_CELLS).fill(128)).ok).toBe(false)
    expect(decodeStrip([1, 2]).ok).toBe(false)
  })
  it('computes latency modulo the strip range', () => {
    expect(stripLatencyMs(100, 160)).toBe(60)
    expect(stripLatencyMs(4090, 4096 + 10)).toBe(16)
    expect(stripLatencyMs(10, 4096 * 3 + 40)).toBe(30)
  })
  it('percentile picks nearest-rank values', () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([5, 1, 3], 50)).toBe(3)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10)
  })
})

describe('moveChannel', () => {
  it('uses the fast channel once open, drops while it is connecting, falls back after the grace period', () => {
    expect(moveChannel('open', 0)).toBe('fast')
    expect(moveChannel('connecting', 100)).toBe('drop')
    expect(moveChannel('connecting', FAST_CHANNEL_GRACE_MS)).toBe('reliable')
    expect(moveChannel('closed', 0)).toBe('reliable')
  })
})
