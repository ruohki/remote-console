import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cx } from '@/components/ui'

export interface MenuItem {
  label: string
  icon?: React.ReactNode
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  /** Draw a separator above this item. */
  divider?: boolean
}

export interface MenuAnchor {
  x: number
  y: number
}

/**
 * Right-click menu for the file panes: fixed at the pointer, kept inside the viewport, closed by
 * Escape, an outside press, scrolling or choosing an item. Arrow keys move, Enter activates.
 */
export function ContextMenu({ at, items, onClose }: { at: MenuAnchor; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)
  const [active, setActive] = useState(-1)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ x: Math.min(at.x, window.innerWidth - r.width - 8), y: Math.min(at.y, window.innerHeight - r.height - 8) })
  }, [at])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setActive((i) => {
          const enabled = items.map((it, idx) => (it.disabled ? -1 : idx)).filter((idx) => idx >= 0)
          if (!enabled.length) return -1
          const cur = enabled.indexOf(i)
          const next = e.key === 'ArrowDown' ? enabled[(cur + 1) % enabled.length]! : enabled[(cur - 1 + enabled.length) % enabled.length]!
          return next
        })
      } else if (e.key === 'Enter') {
        const it = items[active]
        if (it && !it.disabled) {
          e.preventDefault()
          e.stopPropagation()
          onClose()
          it.onClick()
        }
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [items, active, onClose])

  return (
    <div ref={ref} role="menu" className="fixed z-50 min-w-[180px] rounded-md border border-white/10 bg-[#161a21] py-1 text-[12.5px] text-[#e6e9ef] shadow-xl" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) => (
        <div key={it.label} className={cx(it.divider && i > 0 && 'mt-1 border-t border-white/10 pt-1')}>
          <button
            role="menuitem"
            disabled={it.disabled}
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              onClose()
              it.onClick()
            }}
            className={cx(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left disabled:opacity-40',
              active === i && !it.disabled && (it.danger ? 'bg-[#f87171]/15' : 'bg-white/10'),
              it.danger ? 'text-[#f87171]' : 'text-[#e6e9ef]',
            )}
          >
            <span className="flex w-4 shrink-0 items-center justify-center text-[#9aa3b2]">{it.icon}</span>
            {it.label}
          </button>
        </div>
      ))}
    </div>
  )
}
