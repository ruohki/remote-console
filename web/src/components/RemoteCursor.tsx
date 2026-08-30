import { useEffect, useRef } from 'react'
import { cursorDrawPoint, cursorPlacement, drawsCursorOverlay, type CursorShapeInfo } from '@/lib/perf'

/**
 * Client-side remote cursor. The agent captures the screen *without* the system cursor and
 * streams the cursor shape (PNG, once per shape) and its position (≤ 60 Hz) on the control
 * channel; drawing it here means it never lags the video and costs no bandwidth.
 *
 * Positions arrive far more often than React should re-render, so they live in a tiny
 * external store; the layer subscribes and moves its element directly.
 */

export interface CursorShape extends CursorShapeInfo {
  /** data: URL of the PNG */
  url: string
}

export interface CursorPosition {
  display: number
  x: number
  y: number
  shapeId: number
  visible: boolean
}

/** The operator's own pointer over a tile, in physical pixels of that display. */
export interface LocalCursor {
  display: number
  x: number
  y: number
  /** `performance.now()` when the pointer was there; the prediction expires. */
  at: number
}

type Listener = () => void

export class CursorStore {
  private shapes = new Map<number, CursorShape>()
  private position: CursorPosition | null = null
  private local: LocalCursor | null = null
  private listeners = new Set<Listener>()

  setShape(shape: CursorShape) {
    this.shapes.set(shape.id, shape)
    // Keep the map small: shapes are re-sent by the agent when they change.
    if (this.shapes.size > 64) {
      const oldest = this.shapes.keys().next().value
      if (oldest !== undefined) this.shapes.delete(oldest)
    }
    this.emit()
  }

  setPosition(pos: CursorPosition) {
    this.position = pos
    this.emit()
  }

  /**
   * Where the operator's pointer is right now. Drawing follows this instead of the device's
   * echo while they are controlling, so the cursor never trails their hand by a round trip.
   * `null` when the pointer leaves the tile or control ends.
   */
  setLocal(local: LocalCursor | null) {
    this.local = local
    this.emit()
  }

  reset() {
    this.shapes.clear()
    this.position = null
    this.local = null
    this.emit()
  }

  get(): { position: CursorPosition | null; shape: CursorShape | null; local: LocalCursor | null } {
    const position = this.position
    return {
      position,
      shape: position ? (this.shapes.get(position.shapeId) ?? null) : null,
      local: this.local,
    }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }

  private emit() {
    for (const l of this.listeners) l()
  }
}

/**
 * Overlay for one display tile — the only cursor there is, because an agent that streams
 * cursor updates captures the screen without the system cursor and the tile hides the
 * browser's own pointer while controlling. It stays put through the moments the device reports
 * no cursor (typing on Windows, an app hiding it at rest) and steps aside for a drag.
 * See [`drawsCursorOverlay`]. Never intercepts pointer events.
 */
export function RemoteCursorLayer({
  store,
  display,
  getGeometry,
  controlling,
  dragging,
  enabled,
}: {
  store: CursorStore
  display: number
  getGeometry: () => { box: { width: number; height: number }; video: { width: number; height: number } } | null
  controlling: boolean
  dragging: boolean
  enabled: boolean
}) {
  const imgRef = useRef<HTMLImageElement>(null)
  const modeRef = useRef({ controlling, dragging })
  useEffect(() => {
    modeRef.current = { controlling, dragging }
  }, [controlling, dragging])

  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    let raf: number | null = null
    let lastUrl = ''
    const render = () => {
      raf = null
      const { position, shape, local } = store.get()
      const geo = getGeometry()
      if (!enabled || !position || !shape || position.display !== display || !geo) {
        img.style.display = 'none'
        return
      }
      const draw = drawsCursorOverlay({
        deviceVisible: position.visible,
        controlling: modeRef.current.controlling,
        dragging: modeRef.current.dragging,
      })
      if (!draw) {
        img.style.display = 'none'
        return
      }
      const point = cursorDrawPoint({ remote: position, local, controlling: modeRef.current.controlling, now: performance.now() })
      const p = cursorPlacement(point, shape, geo.box, geo.video)
      if (!p) {
        img.style.display = 'none'
        return
      }
      if (lastUrl !== shape.url) {
        img.src = shape.url
        lastUrl = shape.url
      }
      img.style.display = 'block'
      img.style.width = `${p.width}px`
      img.style.height = `${p.height}px`
      img.style.transform = `translate(${p.left}px, ${p.top}px)`
    }
    const schedule = () => {
      if (raf === null) raf = requestAnimationFrame(render)
    }
    const unsub = store.subscribe(schedule)
    const ro = new ResizeObserver(schedule)
    if (img.parentElement) ro.observe(img.parentElement)
    schedule()
    return () => {
      unsub()
      ro.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [store, display, getGeometry, enabled])

  // Taking control or starting a drag does not move the cursor, so no store event fires for
  // it: nudge the store to re-render with the new mode.
  useEffect(() => {
    if (!imgRef.current) return
    store.setPosition(store.get().position ?? { display, x: -1, y: -1, shapeId: 0, visible: false })
  }, [controlling, dragging, store, display])

  return (
    <img
      ref={imgRef}
      alt=""
      draggable={false}
      aria-hidden
      data-testid={`remote-cursor-${display}`}
      className="pointer-events-none absolute top-0 left-0 z-[11] select-none will-change-transform"
      style={{ display: 'none', imageRendering: 'auto' }}
    />
  )
}
