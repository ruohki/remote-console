import { useEffect, useRef } from 'react'
import { CURSOR_DIMMED_OPACITY, cursorOverlayMode, cursorPlacement, type CursorShapeInfo } from '@/lib/perf'

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

type Listener = () => void

export class CursorStore {
  private shapes = new Map<number, CursorShape>()
  private position: CursorPosition | null = null
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

  reset() {
    this.shapes.clear()
    this.position = null
    this.emit()
  }

  get(): { position: CursorPosition | null; shape: CursorShape | null } {
    const position = this.position
    return { position, shape: position ? (this.shapes.get(position.shapeId) ?? null) : null }
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
 * browser's own pointer while controlling. It dims to show where the operator is pointing when
 * the device reports no cursor at all (typing on Windows, another remote tool suppressing it).
 * See [`cursorOverlayMode`]. Never intercepts pointer events.
 */
export function RemoteCursorLayer({
  store,
  display,
  getGeometry,
  controlling,
  enabled,
}: {
  store: CursorStore
  display: number
  getGeometry: () => { box: { width: number; height: number }; video: { width: number; height: number } } | null
  controlling: boolean
  enabled: boolean
}) {
  const imgRef = useRef<HTMLImageElement>(null)
  const controllingRef = useRef(controlling)
  useEffect(() => {
    controllingRef.current = controlling
  }, [controlling])

  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    let raf: number | null = null
    let lastUrl = ''
    const render = () => {
      raf = null
      const { position, shape } = store.get()
      const geo = getGeometry()
      if (!enabled || !position || !shape || position.display !== display || !geo) {
        img.style.display = 'none'
        return
      }
      const mode = cursorOverlayMode({ deviceVisible: position.visible, controlling: controllingRef.current })
      if (mode === 'hidden') {
        img.style.display = 'none'
        return
      }
      const p = cursorPlacement({ x: position.x, y: position.y }, shape, geo.box, geo.video)
      if (!p) {
        img.style.display = 'none'
        return
      }
      if (lastUrl !== shape.url) {
        img.src = shape.url
        lastUrl = shape.url
      }
      img.style.display = 'block'
      img.style.opacity = mode === 'dimmed' ? String(CURSOR_DIMMED_OPACITY) : '1'
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

  // Taking or dropping control does not move the cursor, so no store event fires for it: nudge
  // the store to re-render with the new mode.
  useEffect(() => {
    if (!imgRef.current) return
    store.setPosition(store.get().position ?? { display, x: -1, y: -1, shapeId: 0, visible: false })
  }, [controlling, store, display])

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
