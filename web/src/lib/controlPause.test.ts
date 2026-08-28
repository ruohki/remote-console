import { describe, expect, it } from 'vitest'
import { effectiveControl, reduceControlPaused } from './controlPause'

describe('effectiveControl', () => {
  it('follows the toggle while not paused', () => {
    expect(effectiveControl({ connected: true, inputEnabled: true, controlPaused: false }).controlling).toBe(true)
    expect(effectiveControl({ connected: true, inputEnabled: false, controlPaused: false }).controlling).toBe(false)
    expect(effectiveControl({ connected: false, inputEnabled: true, controlPaused: false }).controlling).toBe(false)
    expect(effectiveControl({ connected: true, inputEnabled: true, controlPaused: false }).toggleLocked).toBe(false)
  })

  it('disables input regardless of the toggle while paused and locks the toggle', () => {
    const r = effectiveControl({ connected: true, inputEnabled: true, controlPaused: true })
    expect(r.controlling).toBe(false)
    expect(r.toggleLocked).toBe(true)
    expect(r.toggleTitle).toMatch(/paused by the person at the device/)
  })
})

describe('reduceControlPaused', () => {
  it('pauses, resumes and ignores repeats', () => {
    const p = reduceControlPaused({ controlPaused: false }, true)
    expect(p).toEqual({ controlPaused: true, notice: 'paused' })
    expect(reduceControlPaused({ controlPaused: true }, true)).toEqual({ controlPaused: true, notice: null })
    const r = reduceControlPaused({ controlPaused: true }, false)
    expect(r).toEqual({ controlPaused: false, notice: 'resumed' })
  })

  it('restores the previous toggle state on resume (toggle is not touched by the pause)', () => {
    // The toggle lives outside the reducer; resuming simply re-enables whatever it was.
    const before = { connected: true, inputEnabled: false, controlPaused: false }
    const paused = { ...before, controlPaused: true }
    expect(effectiveControl(paused).controlling).toBe(false)
    const resumed = { ...paused, controlPaused: false }
    expect(effectiveControl(resumed).controlling).toBe(false) // toggle was off before
    expect(effectiveControl({ ...resumed, inputEnabled: true }).controlling).toBe(true)
  })
})
