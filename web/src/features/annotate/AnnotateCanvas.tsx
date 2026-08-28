import { useEffect, useRef } from 'react'
import { containRect } from '@/lib/geometry'
import { useAnnotate } from './store'
import { layerHasContent, pointerAlpha, strokeAlpha, type AnnotationLayer } from './model'

/**
 * Transparent canvas over one display tile that draws the operator's own strokes and laser
 * pointer exactly like the device overlay does (round caps, fade after the hold time). It is
 * `pointer-events: none`; the tile underneath owns the pointer.
 *
 * `videoSize` is the remote picture size (physical pixels of the display); `box` is the tile
 * size in CSS pixels. Both come from the `<video>` element so the mapping matches input.
 */
export function AnnotateCanvas({ display, getGeometry }: { display: number; getGeometry: () => { box: { width: number; height: number }; video: { width: number; height: number } } | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const layerRef = useRef<AnnotationLayer>(useAnnotate.getState().layer)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let running = true

    const draw = () => {
      rafRef.current = null
      if (!running) return
      const now = Date.now()
      const layer = layerRef.current
      const geo = getGeometry()
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.round((geo?.box.width ?? canvas.clientWidth) * dpr))
      const h = Math.max(1, Math.round((geo?.box.height ?? canvas.clientHeight) * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      if (!geo || geo.video.width === 0) {
        useAnnotate.getState().prune(now)
        return
      }
      const rect = containRect(geo.box, geo.video)
      const sx = rect.width / geo.video.width
      const sy = rect.height / geo.video.height
      const map = (p: [number, number]): [number, number] => [rect.left + p[0] * sx, rect.top + p[1] * sy]

      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (const s of layer.strokes) {
        if (s.display !== display || s.points.length === 0) continue
        const a = strokeAlpha(s, now)
        if (a <= 0) continue
        ctx.globalAlpha = a
        ctx.strokeStyle = s.color
        ctx.lineWidth = Math.max(1, s.width * sx)
        ctx.beginPath()
        const [x0, y0] = map(s.points[0]!)
        if (s.points.length === 1) {
          ctx.fillStyle = s.color
          ctx.arc(x0, y0, ctx.lineWidth / 2, 0, Math.PI * 2)
          ctx.fill()
          continue
        }
        ctx.moveTo(x0, y0)
        for (let i = 1; i < s.points.length; i++) {
          const [x, y] = map(s.points[i]!)
          ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
      const p = layer.pointer
      if (p && p.display === display) {
        const a = pointerAlpha(p, now)
        if (a > 0) {
          const [x, y] = map(p.point)
          const r = Math.max(5, 7 * sx * (geo.video.width > 3000 ? 2 : 1))
          ctx.globalAlpha = a * 0.35
          ctx.fillStyle = p.color
          ctx.beginPath()
          ctx.arc(x, y, r * 2.2, 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = a
          ctx.beginPath()
          ctx.arc(x, y, r, 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = a
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = 1.5
          ctx.stroke()
        }
      }
      ctx.globalAlpha = 1
      useAnnotate.getState().prune(now)
      if (layerHasContent(layerRef.current, now)) schedule()
    }
    const schedule = () => {
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(draw)
    }

    const unsub = useAnnotate.subscribe((s) => {
      if (s.layer !== layerRef.current) {
        layerRef.current = s.layer
        schedule()
      }
    })
    const ro = new ResizeObserver(schedule)
    ro.observe(canvas)
    schedule()
    return () => {
      running = false
      unsub()
      ro.disconnect()
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [display, getGeometry])

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-10 h-full w-full" data-testid={`annotate-canvas-${display}`} aria-hidden />
}
