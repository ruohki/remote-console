/**
 * Pure helpers for the performance pass: viewport hints, client-side cursor placement,
 * the latency-rig strip codec and the fast-input channel fallback. All side-effect free
 * so they are unit-testable.
 */
import { containRect } from './geometry'

/* ───────────── viewport hint ───────────── */

export interface ViewportHint {
  width: number | null
  height: number | null
}

/**
 * What the agent should encode for a tile that renders `tileCss` CSS pixels of a remote
 * display of `display` physical pixels. `null` sizes mean "full resolution" — used when the
 * tile is fullscreen or already shows the display at native size or larger (no point in
 * asking the agent to downscale, and upscaling makes no sense).
 */
export function viewportHint(
  tileCss: { width: number; height: number },
  display: { width: number; height: number },
  devicePixelRatio: number,
  fullscreen: boolean,
): ViewportHint {
  if (fullscreen || tileCss.width <= 0 || tileCss.height <= 0 || display.width <= 0 || display.height <= 0) {
    return { width: null, height: null }
  }
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1
  // The picture is letterboxed inside the tile; only the content area matters.
  const content = containRect(tileCss, display)
  const w = Math.ceil(content.width * dpr)
  const h = Math.ceil(content.height * dpr)
  if (w >= display.width || h >= display.height) return { width: null, height: null }
  // Keep the aspect exactly and even dimensions (encoders want them).
  const scale = Math.min(w / display.width, h / display.height)
  const width = Math.max(2, Math.floor((display.width * scale) / 2) * 2)
  const height = Math.max(2, Math.floor((display.height * scale) / 2) * 2)
  return { width, height }
}

export function sameHint(a: ViewportHint | null, b: ViewportHint): boolean {
  return !!a && a.width === b.width && a.height === b.height
}

/* ───────────── client-side cursor ───────────── */

export interface CursorShapeInfo {
  id: number
  hotspotX: number
  hotspotY: number
  width: number
  height: number
}

export interface CursorPlacement {
  left: number
  top: number
  width: number
  height: number
}

/**
 * CSS placement of the remote cursor image inside a tile. `pos` is the cursor's hotspot in
 * physical pixels of the remote *display* (`source` — its full physical size, not the encoded
 * picture, which may be downscaled by the viewport hint), `box` the tile size in CSS pixels.
 * The image is scaled with the picture so a 32-px cursor on a 5K display stays proportional.
 * Returns `null` when the cursor is outside the display.
 */
export function cursorPlacement(
  pos: { x: number; y: number },
  shape: CursorShapeInfo,
  box: { width: number; height: number },
  source: { width: number; height: number },
): CursorPlacement | null {
  const rect = containRect(box, source)
  if (rect.width === 0 || rect.height === 0) return null
  if (pos.x < 0 || pos.y < 0 || pos.x > source.width || pos.y > source.height) return null
  const s = rect.width / source.width
  return {
    left: rect.left + (pos.x - shape.hotspotX) * s,
    top: rect.top + (pos.y - shape.hotspotY) * s,
    width: Math.max(1, shape.width * s),
    height: Math.max(1, shape.height * s),
  }
}

/**
 * How the remote-cursor overlay should draw, given what the device reports and what the
 * operator is doing.
 *
 * An agent that streams cursor updates at all captures the screen *without* the system cursor
 * (`show_cursor: !client_cursor`), so this overlay is the only cursor in the picture — there is
 * never a second one to avoid, and the tile hides the browser's own pointer in control mode.
 * Hence: draw whenever the device has a cursor.
 *
 * A device can also report its cursor as hidden for reasons that have nothing to do with the
 * operator: Windows hides the pointer while someone types, and another remote tool on the same
 * machine (Parsec, RDP) suppresses it while it draws its own. Whoever is controlling still
 * needs to see where they are pointing, so the last known cursor is drawn dimmed — dimmed
 * because the device's own screen genuinely shows none. An observer, who is not moving
 * anything, sees nothing, which is the truth.
 *
 * While a button is held the overlay steps aside entirely. A drag is carried by the device —
 * the window moves with its own pointer, drawn in the picture — and a second cursor next to it
 * is noise. This overlay exists to make free movement feel immediate, which a drag is not.
 */
export type CursorOverlayMode = 'hidden' | 'solid' | 'dimmed'

export function cursorOverlayMode(s: {
  /** the device says its cursor is drawn on screen */
  deviceVisible: boolean
  /** the operator is controlling this device */
  controlling: boolean
  /** the operator is holding a button: the device is dragging something */
  dragging: boolean
}): CursorOverlayMode {
  if (s.dragging) return 'hidden'
  if (s.deviceVisible) return 'solid'
  return s.controlling ? 'dimmed' : 'hidden'
}

/** Opacity for a [`CursorOverlayMode`]; `hidden` is handled by not drawing at all. */
export const CURSOR_DIMMED_OPACITY = 0.55

/**
 * How long a locally predicted cursor position outranks the device's own report.
 *
 * Long enough that a continuous drag never falls back to the echo between two pointer events
 * (a 60 Hz mouse fires every ~16 ms, a slow one every ~125 ms), short enough that the cursor
 * settles onto the truth a blink after the operator stops moving.
 */
export const LOCAL_CURSOR_TTL_MS = 250

/**
 * Whether the overlay may run ahead of the device at all.
 *
 * Not while a button is held: then the device is dragging something that follows its *real*
 * pointer — a window, a selection rectangle, a scrollbar — and that content is a full round
 * trip behind. A predicted cursor separates from what it is dragging, which reads as two
 * cursors, one of them oddly attached to the window. During a drag the cursor rejoins the
 * thing it moves, even though both then lag. Free movement drags nothing, so it stays ahead.
 */
export function cursorPredictionAllowed(s: { controlling: boolean; buttons: number }): boolean {
  return s.controlling && s.buttons === 0
}

/**
 * Where to draw the cursor: the operator's own pointer, or the position the device reported.
 *
 * While the operator drives, the device's report is a full round trip old — the browser sends
 * a move, the agent applies it, its cursor thread samples at up to 60 Hz, and the position
 * travels back. Drawing that echo under a hidden local pointer is what makes control feel
 * heavy. So while the operator is moving the pointer over a tile they control, the overlay
 * follows *their* pointer immediately and the echo only supplies the shape.
 *
 * Everything else keeps the device's position: another display, an observer, a cursor the
 * device moved by itself, or an operator who has stopped moving — after which the prediction
 * expires and any divergence (a window edge the pointer could not cross, an app warping it)
 * corrects itself.
 */
export function cursorDrawPoint(s: {
  remote: { display: number; x: number; y: number }
  local: { display: number; x: number; y: number; at: number } | null
  controlling: boolean
  now: number
}): { x: number; y: number } {
  const { remote, local } = s
  const fresh = local !== null && s.now - local.at <= LOCAL_CURSOR_TTL_MS
  if (s.controlling && local && fresh && local.display === remote.display) {
    return { x: local.x, y: local.y }
  }
  return { x: remote.x, y: remote.y }
}

/* ───────────── latency-rig strip codec ───────────── */

/**
 * Cells along the top edge of the synthetic source, left to right: one always-white marker
 * cell (guarantees contrast and anchors the decoder), 12 timestamp bits (MSB first) and an
 * even-parity cell.
 */
export const STRIP_DATA_BITS = 12
export const STRIP_CELLS = 1 + STRIP_DATA_BITS + 1
export const STRIP_CELL_PX = 64
/** The timestamp is carried modulo this many milliseconds. */
export const STRIP_MODULO = 1 << STRIP_DATA_BITS

/** Bits (true = white cell): marker, low 12 bits of the timestamp MSB first, even parity. */
export function encodeStrip(tsMs: number): boolean[] {
  const v = ((Math.floor(tsMs) % STRIP_MODULO) + STRIP_MODULO) % STRIP_MODULO
  const bits: boolean[] = [true]
  let ones = 0
  for (let i = STRIP_DATA_BITS - 1; i >= 0; i--) {
    const b = ((v >> i) & 1) === 1
    if (b) ones++
    bits.push(b)
  }
  bits.push(ones % 2 === 1) // parity cell makes the total number of white cells even
  return bits
}

/**
 * Decode cell luminances (0..255, one per cell, left to right) into the timestamp.
 * `ok` is false when the parity does not match (partially drawn/decoded frame) or the
 * contrast is too low to be a strip at all.
 */
export function decodeStrip(luma: number[]): { ms: number; ok: boolean } {
  if (luma.length < STRIP_CELLS) return { ms: 0, ok: false }
  const cells = luma.slice(0, STRIP_CELLS)
  const min = Math.min(...cells)
  const max = Math.max(...cells)
  if (max - min < 64) return { ms: 0, ok: false }
  const threshold = (min + max) / 2
  const bits = cells.map((l) => l >= threshold)
  if (!bits[0]) return { ms: 0, ok: false } // marker cell must be white
  let v = 0
  let ones = 0
  for (let i = 1; i <= STRIP_DATA_BITS; i++) {
    v = (v << 1) | (bits[i] ? 1 : 0)
    if (bits[i]) ones++
  }
  const parity = bits[STRIP_DATA_BITS + 1]!
  const ok = (ones + (parity ? 1 : 0)) % 2 === 0
  return { ms: v, ok }
}

/** Glass-to-glass latency from a decoded strip value and the current wall clock (same host). */
export function stripLatencyMs(stripMs: number, nowMs: number): number {
  const now = ((Math.floor(nowMs) % STRIP_MODULO) + STRIP_MODULO) % STRIP_MODULO
  return (((now - stripMs) % STRIP_MODULO) + STRIP_MODULO) % STRIP_MODULO
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[idx]!
}

/* ───────────── fast input channel ───────────── */

export type FastChannelState = 'connecting' | 'open' | 'closed'

/** How long we wait for the agent to open `input-fast` before pointer moves use the reliable channel. */
export const FAST_CHANNEL_GRACE_MS = 3000

/**
 * Which channel a pointer move should use. While the fast channel is still connecting and
 * the grace period has not elapsed, moves are dropped rather than sent reliably: the next
 * move arrives within a frame anyway and mixing channels would reorder positions.
 */
export function moveChannel(fast: FastChannelState, sinceOfferMs: number): 'fast' | 'reliable' | 'drop' {
  if (fast === 'open') return 'fast'
  if (fast === 'closed') return 'reliable'
  return sinceOfferMs >= FAST_CHANNEL_GRACE_MS ? 'reliable' : 'drop'
}
