import type { InputEvent, MouseButton } from '@/protocol'
import { wheelToLines } from './geometry'

/** `PointerEvent.button` → protocol button. Returns null for unknown buttons. */
export function mouseButton(button: number): MouseButton | null {
  switch (button) {
    case 0:
      return 'left'
    case 1:
      return 'middle'
    case 2:
      return 'right'
    case 3:
      return 'back'
    case 4:
      return 'forward'
    default:
      return null
  }
}

/**
 * Keys the browser will not let us intercept (the tab/window would act on them first);
 * the viewer shows a hint for these instead of pretending they were sent.
 */
export const RESERVED_SHORTCUTS = new Set([
  'Meta+KeyW',
  'Meta+KeyQ',
  'Meta+KeyT',
  'Meta+KeyN',
  'Meta+Shift+KeyT',
  'Control+KeyW',
  'Control+Shift+KeyW',
  'Control+KeyT',
  'Control+KeyN',
  'Control+Shift+KeyN',
  'Meta+Tab',
  'Alt+Tab',
  'Alt+F4',
])

export function shortcutKey(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Control')
  if (e.metaKey) parts.push('Meta')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(e.code)
  return parts.join('+')
}

/** Physical mode: every key with a `code` goes as a key press (the device's layout decides). */
export function keyboardToInput(e: KeyboardEvent, down: boolean): InputEvent | null {
  if (e.isComposing || e.code === '' || e.key === 'Process' || e.key === 'Dead') {
    return null
  }
  if (e.code === 'Unidentified') {
    // Virtual keyboards: fall back to typing the character on key down.
    return down && e.key.length === 1 ? { t: 'tx', text: e.key } : null
  }
  return down ? { t: 'kd', code: e.code } : { t: 'ku', code: e.code }
}

/**
 * How typing reaches the device.
 *
 * * `text` (default): what the operator's keyboard *types* arrives — letters, digits, punctuation,
 *   umlauts, AltGr / Option characters go as text, so a German operator on a US device (or any
 *   other mix) gets exactly the characters on their keys. Shortcuts and non-character keys
 *   (Ctrl/Alt/Win combinations, arrows, F-keys, Enter, Tab, Space) stay key presses.
 * * `physical`: every key is a key press at its physical position and the device's layout
 *   decides — for software that reads raw keys (games, VM consoles, some terminals).
 */
export type KeyboardMode = 'text' | 'physical'

const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
])

/** Modifiers that are held back until the next key shows what they are for (see below). */
function deferrable(code: string) {
  return MODIFIER_CODES.has(code) && !code.startsWith('Shift')
}

/** US `code` for a character, so `Ctrl+Z` on a German keyboard is Ctrl+Z, not Ctrl+Y. */
const PUNCTUATION_CODES: Record<string, string> = {
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
}

function shortcutCode(e: KeyboardEvent): string {
  const k = e.key
  if (k.length === 1) {
    const c = k.toLowerCase()
    if (c >= 'a' && c <= 'z') return `Key${c.toUpperCase()}`
    if (c >= '0' && c <= '9' && !e.code.startsWith('Numpad')) return `Digit${c}`
    const p = PUNCTUATION_CODES[k]
    if (p) return p
  }
  return e.code
}

function isMacPlatform() {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

/**
 * Stateful keyboard translation for the viewer (one per viewer).
 *
 * Ctrl, Alt and Meta are not sent the moment they go down: on Windows and Linux AltGr arrives as
 * Ctrl+Alt, and on a Mac Option is how `@ € [ ] { } | \ ~` are typed — sent ahead of a typed
 * character they would turn it into a shortcut on the device (or open a menu). They are held
 * until the next key: a typed character drops them, a shortcut key sends them first, a mouse
 * button or wheel sends them first ([`flushPending`]), and a modifier tapped on its own (Win key
 * for the Start menu, Alt for the menu bar) is sent as a tap when it is released.
 */
export class KeyboardTranslator {
  /** Deferred modifier codes, in press order. */
  private pending: string[] = []
  /** Modifier codes the device has seen go down. */
  private sentModifiers = new Set<string>()
  /** Physical code → the code sent for it (shortcut letters are re-mapped by character). */
  private sentKeys = new Map<string, string>()
  /** A non-modifier key or click happened since the pending modifiers went down. */
  private used = false

  mode: KeyboardMode
  private readonly mac: boolean

  constructor(mode: KeyboardMode = 'text', mac: boolean = isMacPlatform()) {
    this.mode = mode
    this.mac = mac
  }

  /** Forget everything (focus lost; the caller sends `rel`). */
  reset() {
    this.pending = []
    this.sentModifiers.clear()
    this.sentKeys.clear()
    this.used = false
  }

  /** Send the held modifiers now (before a click or wheel, so Ctrl+click works). */
  flushPending(): InputEvent[] {
    this.used = true
    const out: InputEvent[] = this.pending.map((code) => ({ t: 'kd', code }))
    for (const code of this.pending) this.sentModifiers.add(code)
    this.pending = []
    return out
  }

  /** The character this key event types, or null when it is a shortcut / non-character key. */
  private typedCharacter(e: KeyboardEvent): string | null {
    if (Array.from(e.key).length !== 1 || e.key === ' ') return null
    const altGraph = typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')
    if (e.metaKey) return null
    if (e.ctrlKey && !altGraph) return null
    // Plain Alt on Windows / Linux is a shortcut (Alt+F); on a Mac Option types characters.
    if (e.altKey && !altGraph && !this.mac) return null
    return e.key
  }

  keyDown(e: KeyboardEvent): InputEvent[] {
    if (this.mode === 'physical') {
      const ev = keyboardToInput(e, true)
      return ev ? [ev] : []
    }
    if (e.isComposing || e.key === 'Process' || e.key === 'Dead') return []
    if (e.code === '' || e.code === 'Unidentified') {
      return e.key.length === 1 ? [{ t: 'tx', text: e.key }] : []
    }
    if (MODIFIER_CODES.has(e.code)) {
      if (!deferrable(e.code)) return [{ t: 'kd', code: e.code }]
      if (!e.repeat && !this.pending.includes(e.code) && !this.sentModifiers.has(e.code)) {
        if (this.pending.length === 0) this.used = false
        this.pending.push(e.code)
      }
      return []
    }
    this.used = true
    const ch = this.typedCharacter(e)
    if (ch !== null) {
      // Typed text: the held modifiers (AltGr, Option) were only there to produce it.
      this.sentKeys.delete(e.code)
      return [{ t: 'tx', text: ch }]
    }
    const out = this.flushPending()
    const code = e.ctrlKey || e.metaKey || e.altKey ? shortcutCode(e) : e.code
    this.sentKeys.set(e.code, code)
    out.push({ t: 'kd', code })
    return out
  }

  keyUp(e: KeyboardEvent): InputEvent[] {
    if (this.mode === 'physical') {
      const ev = keyboardToInput(e, false)
      return ev ? [ev] : []
    }
    if (e.code === '' || e.code === 'Unidentified') return []
    if (MODIFIER_CODES.has(e.code)) {
      if (!deferrable(e.code)) return [{ t: 'ku', code: e.code }]
      const i = this.pending.indexOf(e.code)
      if (i >= 0) {
        this.pending.splice(i, 1)
        // Tapped on its own (Win key → Start menu): send the tap. Used for a typed
        // character (AltGr+Q → @): the device never needs to see it.
        return this.used ? [] : [{ t: 'kd', code: e.code }, { t: 'ku', code: e.code }]
      }
      if (this.sentModifiers.delete(e.code)) return [{ t: 'ku', code: e.code }]
      return []
    }
    const sent = this.sentKeys.get(e.code)
    if (sent === undefined) return []
    this.sentKeys.delete(e.code)
    return [{ t: 'ku', code: sent }]
  }
}

export function wheelToInput(e: WheelEvent): InputEvent | null {
  const dx = wheelToLines(e.deltaX, e.deltaMode)
  const dy = wheelToLines(e.deltaY, e.deltaMode)
  if (dx === 0 && dy === 0) return null
  return { t: 'mw', dx: round2(dx), dy: round2(dy) }
}

function round2(v: number) {
  return Math.round(v * 100) / 100
}
