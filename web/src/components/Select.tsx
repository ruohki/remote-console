import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { cx } from './cx'

export interface SelectOption<T extends string | number> {
  value: T
  label: ReactNode
  /** Optional second line under the label. */
  description?: ReactNode
  disabled?: boolean
  /** Plain-text used for typeahead; falls back to `String(label)` when omitted. */
  keywords?: string
}

type Size = 'sm' | 'md'
type MenuTone = 'auto' | 'dark'

export interface SelectProps<T extends string | number> {
  value: T
  onChange: (value: T) => void
  options: SelectOption<T>[]
  placeholder?: string
  disabled?: boolean
  size?: Size
  /** Extra classes for the trigger button. */
  className?: string
  /** Icon shown before the value (used by the on-video HUD variant). */
  icon?: ReactNode
  /** 'hud' = transparent trigger for dark overlays. */
  variant?: 'field' | 'hud'
  /** Force a dark menu regardless of the app theme (for the video HUD). */
  menuTone?: MenuTone
  'aria-label'?: string
  id?: string
  name?: string
}

const TRIGGER_SIZE: Record<Size, string> = {
  sm: 'h-7 text-[12.5px]',
  md: 'h-8 text-[13px]',
}

export function Select<T extends string | number>({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  disabled,
  size = 'md',
  className,
  icon,
  variant = 'field',
  menuTone = 'auto',
  id,
  name,
  ...aria
}: SelectProps<T>) {
  const ariaLabel = aria['aria-label']
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number>(() => options.findIndex((o) => o.value === value))
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const typeahead = useRef({ buffer: '', at: 0 })
  const listboxId = useId()

  const selected = useMemo(() => options.find((o) => o.value === value), [options, value])
  const firstEnabled = options.findIndex((o) => !o.disabled)

  const close = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  const commit = useCallback(
    (index: number) => {
      const opt = options[index]
      if (!opt || opt.disabled) return
      onChange(opt.value)
      setOpen(false)
      triggerRef.current?.focus()
    },
    [options, onChange],
  )

  const openMenu = useCallback(() => {
    const start = options.findIndex((o) => o.value === value)
    setActiveIndex(start >= 0 ? start : options.findIndex((o) => !o.disabled))
    setOpen(true)
  }, [options, value])

  // Position the portal menu under (or above) the trigger.
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number; above: boolean } | null>(null)
  const place = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const below = window.innerHeight - r.bottom
    const above = r.top
    const openAbove = below < 240 && above > below
    const maxHeight = Math.max(140, Math.min(320, (openAbove ? above : below) - 12))
    setPos({ left: r.left, top: openAbove ? r.top : r.bottom, width: r.width, maxHeight, above: openAbove })
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    place()
    const onScroll = () => place()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  // Outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return
      if (listRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const step = (dir: 1 | -1) => {
    setActiveIndex((i) => {
      let n = i
      for (let k = 0; k < options.length; k++) {
        n = (n + dir + options.length) % options.length
        if (!options[n]?.disabled) return n
      }
      return i
    })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keep the viewer's global key capture from stealing these.
    e.stopPropagation()
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openMenu()
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        step(1)
        break
      case 'ArrowUp':
        e.preventDefault()
        step(-1)
        break
      case 'Home':
        e.preventDefault()
        setActiveIndex(firstEnabled)
        break
      case 'End': {
        e.preventDefault()
        for (let n = options.length - 1; n >= 0; n--)
          if (!options[n]?.disabled) {
            setActiveIndex(n)
            break
          }
        break
      }
      case 'Enter':
      case ' ':
        e.preventDefault()
        commit(activeIndex)
        break
      case 'Escape':
        e.preventDefault()
        close()
        break
      case 'Tab':
        setOpen(false)
        break
      default:
        if (e.key.length === 1) {
          const now = Date.now()
          typeahead.current.buffer = now - typeahead.current.at > 700 ? e.key : typeahead.current.buffer + e.key
          typeahead.current.at = now
          const q = typeahead.current.buffer.toLowerCase()
          const match = options.findIndex((o) => !o.disabled && (o.keywords ?? String(o.label)).toLowerCase().startsWith(q))
          if (match >= 0) setActiveIndex(match)
        }
    }
  }

  const isHud = variant === 'hud'
  const forceDark = menuTone === 'dark'

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        name={name}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        aria-disabled={disabled}
        disabled={disabled}
        onClick={() => (disabled ? undefined : open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        className={cx(
          'inline-flex w-full items-center gap-1.5 rounded-md text-left transition-colors focus:outline-none disabled:opacity-60',
          isHud
            ? 'px-1.5 py-1 text-[#c8ced8] hover:bg-white/10 focus-visible:ring-1 focus-visible:ring-white/40'
            : cx(
                'border border-line-strong bg-surface px-2.5 text-ink focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/40',
                TRIGGER_SIZE[size],
              ),
          className,
        )}
      >
        {icon}
        <span className={cx('min-w-0 flex-1 truncate', !selected && 'text-ink-faint')}>{selected ? selected.label : placeholder}</span>
        <ChevronDown size={isHud ? 12 : 14} className={cx('shrink-0 opacity-60 transition-transform', open && 'rotate-180')} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div className={cx(forceDark && 'dark')}>
            <div
              ref={listRef}
              id={listboxId}
              role="listbox"
              aria-label={ariaLabel}
              tabIndex={-1}
              style={{
                position: 'fixed',
                left: pos.left,
                top: pos.above ? undefined : pos.top + 4,
                bottom: pos.above ? window.innerHeight - pos.top + 4 : undefined,
                minWidth: pos.width,
                maxHeight: pos.maxHeight,
                zIndex: 100,
              }}
              className="animate-fade-up overflow-y-auto rounded-md border border-line-strong bg-surface p-1 text-[13px] text-ink shadow-pop"
            >
              {options.map((o, i) => {
                const isSel = o.value === value
                const isActive = i === activeIndex
                return (
                  <div
                    key={String(o.value)}
                    role="option"
                    aria-selected={isSel}
                    aria-disabled={o.disabled}
                    data-index={i}
                    onMouseEnter={() => !o.disabled && setActiveIndex(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => commit(i)}
                    className={cx(
                      'flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5',
                      o.disabled && 'cursor-not-allowed opacity-40',
                      isActive && !o.disabled && 'bg-accent-soft',
                    )}
                  >
                    <Check size={14} className={cx('mt-0.5 shrink-0', isSel ? 'text-accent' : 'invisible')} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{o.label}</span>
                      {o.description && <span className="mt-0.5 block text-[11.5px] text-ink-muted">{o.description}</span>}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
