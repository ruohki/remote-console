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

/** Key events with a physical `code` go as key presses; anything else (IME, dead keys) as text. */
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

export function wheelToInput(e: WheelEvent): InputEvent | null {
  const dx = wheelToLines(e.deltaX, e.deltaMode)
  const dy = wheelToLines(e.deltaY, e.deltaMode)
  if (dx === 0 && dy === 0) return null
  return { t: 'mw', dx: round2(dx), dy: round2(dy) }
}

function round2(v: number) {
  return Math.round(v * 100) / 100
}
