import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'
import { cx } from './cx'

export interface RowMenuItem {
  label: string
  icon?: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** why the item is disabled, or a one-line explanation */
  title?: string
}

/**
 * "⋯" actions for a table row: labelled items instead of a row of look-alike icons. The list is
 * portaled (fixed position) so a scrolling table cannot clip it.
 */
export function RowMenu({ label, items }: { label: string; items: (RowMenuItem | false | null | undefined)[] }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number; up: boolean } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const list = items.filter(Boolean) as RowMenuItem[]

  useLayoutEffect(() => {
    if (!open || !trigger.current) return
    const r = trigger.current.getBoundingClientRect()
    const up = window.innerHeight - r.bottom < 40 + list.length * 32
    setPos({ top: up ? r.top : r.bottom, right: window.innerWidth - r.right, up })
  }, [open, list.length])

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const close = () => setOpen(false)
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (!menu.current?.contains(t) && !trigger.current?.contains(t)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
        trigger.current?.focus()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        className={cx('inline-flex size-7 items-center justify-center rounded-md text-ink-muted hover:bg-raised hover:text-ink', open && 'bg-raised text-ink')}
      >
        <MoreHorizontal size={15} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={label}
            className="panel animate-fade-up fixed z-[100] min-w-48 p-1 shadow-pop"
            style={{ right: pos.right, ...(pos.up ? { bottom: window.innerHeight - pos.top + 4 } : { top: pos.top + 4 }) }}
          >
            {list.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                title={item.title}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(false)
                  item.onSelect()
                }}
                className={cx(
                  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] focus:outline-none disabled:cursor-not-allowed disabled:opacity-45',
                  item.danger ? 'text-danger hover:bg-danger-soft focus:bg-danger-soft' : 'text-ink hover:bg-raised focus:bg-raised',
                )}
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-current opacity-80">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
