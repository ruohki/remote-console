import { describe, expect, it } from 'vitest'
import { containRect, toRemotePixels, wheelToLines } from './geometry'

describe('containRect', () => {
  it('letterboxes a wide video in a tall box', () => {
    const r = containRect({ width: 1000, height: 1000 }, { width: 1920, height: 1080 })
    expect(r.width).toBeCloseTo(1000)
    expect(r.height).toBeCloseTo(562.5)
    expect(r.left).toBe(0)
    expect(r.top).toBeCloseTo(218.75)
  })

  it('pillarboxes a tall video in a wide box', () => {
    const r = containRect({ width: 2000, height: 1000 }, { width: 1080, height: 1920 })
    expect(r.height).toBeCloseTo(1000)
    expect(r.width).toBeCloseTo(562.5)
    expect(r.left).toBeCloseTo(718.75)
    expect(r.top).toBe(0)
  })

  it('returns an empty rect for unknown sizes', () => {
    expect(containRect({ width: 100, height: 100 }, { width: 0, height: 0 })).toEqual({ left: 0, top: 0, width: 0, height: 0 })
  })
})

describe('toRemotePixels', () => {
  const box = { width: 1000, height: 1000 }
  const video = { width: 2880, height: 1800 } // retina display, 16:10

  it('maps the content corners to the display corners', () => {
    const rect = containRect(box, video)
    expect(toRemotePixels({ x: rect.left, y: rect.top }, box, video)).toEqual({ x: 0, y: 0 })
    const br = toRemotePixels({ x: rect.left + rect.width - 0.001, y: rect.top + rect.height - 0.001 }, box, video)
    expect(br).toEqual({ x: 2879, y: 1799 })
  })

  it('maps the centre to the centre', () => {
    expect(toRemotePixels({ x: 500, y: 500 }, box, video)).toEqual({ x: 1440, y: 900 })
  })

  it('returns null in the letterbox bars', () => {
    expect(toRemotePixels({ x: 500, y: 10 }, box, video)).toBeNull()
    expect(toRemotePixels({ x: 500, y: 990 }, box, video)).toBeNull()
  })

  it('clamps to the last pixel at the exact edge', () => {
    const rect = containRect(box, video)
    expect(toRemotePixels({ x: rect.left + rect.width, y: rect.top + rect.height }, box, video)).toEqual({ x: 2879, y: 1799 })
  })

  it('never returns a coordinate outside the display', () => {
    for (let i = 0; i < 200; i++) {
      const p = toRemotePixels({ x: Math.random() * 1000, y: Math.random() * 1000 }, box, video)
      if (!p) continue
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThan(video.width)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThan(video.height)
    }
  })
})

describe('wheelToLines', () => {
  it('converts pixel deltas using the line height', () => {
    expect(wheelToLines(32, 0)).toBe(2)
  })
  it('passes line deltas through', () => {
    expect(wheelToLines(3, 1)).toBe(3)
  })
  it('expands page deltas', () => {
    expect(wheelToLines(1, 2)).toBe(20)
  })
})
