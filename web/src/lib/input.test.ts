import { describe, expect, it } from 'vitest'
import { KeyboardTranslator } from './input'

type Init = {
  key: string
  code: string
  ctrl?: boolean
  alt?: boolean
  meta?: boolean
  shift?: boolean
  altGraph?: boolean
  repeat?: boolean
}

/** A KeyboardEvent-shaped object (the translator only reads these fields). */
function ev(i: Init): KeyboardEvent {
  return {
    key: i.key,
    code: i.code,
    ctrlKey: !!i.ctrl,
    altKey: !!i.alt,
    metaKey: !!i.meta,
    shiftKey: !!i.shift,
    repeat: !!i.repeat,
    isComposing: false,
    getModifierState: (m: string) => m === 'AltGraph' && !!i.altGraph,
  } as unknown as KeyboardEvent
}

/** Press and release one key, collecting everything sent. */
function tap(t: KeyboardTranslator, i: Init) {
  return [...t.keyDown(ev(i)), ...t.keyUp(ev(i))]
}

describe('KeyboardTranslator (text mode)', () => {
  it('sends what a German keyboard types, not the US key at that position', () => {
    const t = new KeyboardTranslator('text', false)
    // German Z sits where US has Y; German - where US has /; ö where US has ;.
    expect(tap(t, { key: 'z', code: 'KeyY' })).toEqual([{ t: 'tx', text: 'z' }])
    expect(tap(t, { key: '-', code: 'Slash' })).toEqual([{ t: 'tx', text: '-' }])
    expect(tap(t, { key: 'ö', code: 'Semicolon' })).toEqual([{ t: 'tx', text: 'ö' }])
    expect(tap(t, { key: 'ß', code: 'Minus' })).toEqual([{ t: 'tx', text: 'ß' }])
  })

  it('keeps Shift as a key and types the shifted character', () => {
    const t = new KeyboardTranslator('text', false)
    expect(t.keyDown(ev({ key: 'Shift', code: 'ShiftLeft', shift: true }))).toEqual([{ t: 'kd', code: 'ShiftLeft' }])
    expect(t.keyDown(ev({ key: 'A', code: 'KeyA', shift: true }))).toEqual([{ t: 'tx', text: 'A' }])
    expect(t.keyUp(ev({ key: 'A', code: 'KeyA', shift: true }))).toEqual([])
    expect(t.keyUp(ev({ key: 'Shift', code: 'ShiftLeft' }))).toEqual([{ t: 'ku', code: 'ShiftLeft' }])
  })

  it('types AltGr characters without the device ever seeing Ctrl+Alt (Windows/Linux)', () => {
    const t = new KeyboardTranslator('text', false)
    const out = [
      ...t.keyDown(ev({ key: 'Control', code: 'ControlLeft', ctrl: true })),
      ...t.keyDown(ev({ key: 'AltGraph', code: 'AltRight', ctrl: true, alt: true, altGraph: true })),
      ...t.keyDown(ev({ key: '@', code: 'KeyQ', ctrl: true, alt: true, altGraph: true })),
      ...t.keyUp(ev({ key: '@', code: 'KeyQ', ctrl: true, alt: true, altGraph: true })),
      ...t.keyUp(ev({ key: 'AltGraph', code: 'AltRight' })),
      ...t.keyUp(ev({ key: 'Control', code: 'ControlLeft' })),
    ]
    expect(out).toEqual([{ t: 'tx', text: '@' }])
  })

  it('types Option characters on a Mac', () => {
    const t = new KeyboardTranslator('text', true)
    const out = [
      ...t.keyDown(ev({ key: 'Alt', code: 'AltLeft', alt: true })),
      ...t.keyDown(ev({ key: '@', code: 'KeyL', alt: true })),
      ...t.keyUp(ev({ key: '@', code: 'KeyL', alt: true })),
      ...t.keyUp(ev({ key: 'Alt', code: 'AltLeft' })),
    ]
    expect(out).toEqual([{ t: 'tx', text: '@' }])
  })

  it('sends shortcuts as keys, by the letter the operator pressed', () => {
    const t = new KeyboardTranslator('text', false)
    // Ctrl+Z on a German keyboard: the Z key is the US Y position.
    const out = [
      ...t.keyDown(ev({ key: 'Control', code: 'ControlLeft', ctrl: true })),
      ...t.keyDown(ev({ key: 'z', code: 'KeyY', ctrl: true })),
      ...t.keyUp(ev({ key: 'z', code: 'KeyY', ctrl: true })),
      ...t.keyUp(ev({ key: 'Control', code: 'ControlLeft' })),
    ]
    expect(out).toEqual([
      { t: 'kd', code: 'ControlLeft' },
      { t: 'kd', code: 'KeyZ' },
      { t: 'ku', code: 'KeyZ' },
      { t: 'ku', code: 'ControlLeft' },
    ])
  })

  it('keeps Alt shortcuts on Windows/Linux (Alt+F, Alt+F4)', () => {
    const t = new KeyboardTranslator('text', false)
    expect([
      ...t.keyDown(ev({ key: 'Alt', code: 'AltLeft', alt: true })),
      ...t.keyDown(ev({ key: 'f', code: 'KeyF', alt: true })),
    ]).toEqual([
      { t: 'kd', code: 'AltLeft' },
      { t: 'kd', code: 'KeyF' },
    ])
    expect(t.keyDown(ev({ key: 'F4', code: 'F4', alt: true }))).toEqual([{ t: 'kd', code: 'F4' }])
  })

  it('sends a modifier tapped on its own as a tap (Win key opens Start)', () => {
    const t = new KeyboardTranslator('text', false)
    expect(t.keyDown(ev({ key: 'Meta', code: 'MetaLeft', meta: true }))).toEqual([])
    expect(t.keyUp(ev({ key: 'Meta', code: 'MetaLeft' }))).toEqual([
      { t: 'kd', code: 'MetaLeft' },
      { t: 'ku', code: 'MetaLeft' },
    ])
  })

  it('flushes held modifiers before a click (Ctrl+click)', () => {
    const t = new KeyboardTranslator('text', false)
    t.keyDown(ev({ key: 'Control', code: 'ControlLeft', ctrl: true }))
    expect(t.flushPending()).toEqual([{ t: 'kd', code: 'ControlLeft' }])
    expect(t.keyUp(ev({ key: 'Control', code: 'ControlLeft' }))).toEqual([{ t: 'ku', code: 'ControlLeft' }])
  })

  it('leaves special keys and Space as keys and repeats typed characters', () => {
    const t = new KeyboardTranslator('text', false)
    expect(tap(t, { key: 'Enter', code: 'Enter' })).toEqual([
      { t: 'kd', code: 'Enter' },
      { t: 'ku', code: 'Enter' },
    ])
    expect(tap(t, { key: ' ', code: 'Space' })).toEqual([
      { t: 'kd', code: 'Space' },
      { t: 'ku', code: 'Space' },
    ])
    expect(t.keyDown(ev({ key: 'a', code: 'KeyA', repeat: true }))).toEqual([{ t: 'tx', text: 'a' }])
  })

  it('types composed dead-key characters (^ then e → ê)', () => {
    const t = new KeyboardTranslator('text', false)
    expect(t.keyDown(ev({ key: 'Dead', code: 'Backquote' }))).toEqual([])
    expect(t.keyDown(ev({ key: 'ê', code: 'KeyE' }))).toEqual([{ t: 'tx', text: 'ê' }])
  })
})

describe('KeyboardTranslator (physical mode)', () => {
  it('sends every key at its physical position', () => {
    const t = new KeyboardTranslator('physical', false)
    expect(tap(t, { key: 'z', code: 'KeyY' })).toEqual([
      { t: 'kd', code: 'KeyY' },
      { t: 'ku', code: 'KeyY' },
    ])
    expect(t.keyDown(ev({ key: 'Control', code: 'ControlLeft', ctrl: true }))).toEqual([{ t: 'kd', code: 'ControlLeft' }])
  })
})
