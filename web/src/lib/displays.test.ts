import { describe, expect, it } from 'vitest'
import type { DisplayInfo } from '@/protocol'
import { mapVideoTransceivers, primaryDisplay, tileGrid, videoTransceiverCount } from './displays'

const d = (index: number, primary = false): DisplayInfo => ({ index, name: `D${index}`, x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary })

describe('display ↔ transceiver mapping', () => {
  it('binds the i-th transceiver to the i-th display in index order', () => {
    const map = mapVideoTransceivers([d(2), d(0, true), d(1)], ['t0', 't1', 't2'])
    expect(map).toEqual([
      { display: 0, transceiver: 't0' },
      { display: 1, transceiver: 't1' },
      { display: 2, transceiver: 't2' },
    ])
  })

  it('falls back to positional indices when displays are unknown', () => {
    expect(mapVideoTransceivers([], ['a'])).toEqual([{ display: 0, transceiver: 'a' }])
    expect(videoTransceiverCount([])).toBe(1)
    expect(videoTransceiverCount([d(0), d(1)])).toBe(2)
  })

  it('picks the primary display', () => {
    expect(primaryDisplay([d(1), d(0, true)])).toBe(0)
    expect(primaryDisplay([d(3), d(2)])).toBe(2)
    expect(primaryDisplay([])).toBe(0)
  })

  it('lays tiles out in a compact grid', () => {
    expect(tileGrid(1)).toEqual({ cols: 1, rows: 1 })
    expect(tileGrid(2)).toEqual({ cols: 2, rows: 1 })
    expect(tileGrid(3)).toEqual({ cols: 2, rows: 2 })
    expect(tileGrid(5)).toEqual({ cols: 3, rows: 2 })
  })
})
