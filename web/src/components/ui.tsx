import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, forwardRef, useEffect, useRef, useState } from 'react'
import { Check, Copy, Loader2, X } from 'lucide-react'

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ')
}

/* ───────────── Button ───────────── */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 border-transparent',
  secondary: 'bg-surface text-ink border-line-strong hover:bg-raised',
  ghost: 'bg-transparent text-ink-muted hover:text-ink hover:bg-raised border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent hover:brightness-95 dark:hover:brightness-125',
}
const SIZE: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[12.5px] gap-1.5',
  md: 'h-8 px-3 text-[13px] gap-2',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center rounded-md border font-medium whitespace-nowrap transition-colors disabled:opacity-50',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  )
})

/* ───────────── Form controls ───────────── */

const FIELD =
  'h-8 w-full rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none disabled:opacity-60'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(FIELD, className)} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(FIELD, 'h-auto min-h-20 py-1.5 leading-normal', className)} {...rest} />
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx(FIELD, 'pr-7', className)} {...rest}>
      {children}
    </select>
  )
})

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-[12px] font-medium text-ink-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-ink-faint">{hint}</span>}
    </label>
  )
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 disabled:opacity-50"
    >
      <span className={cx('relative h-4.5 w-8 rounded-full border transition-colors', checked ? 'bg-accent border-accent' : 'bg-raised border-line-strong')}>
        <span className={cx('absolute top-0.5 size-3 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4' : 'translate-x-0.5')} />
      </span>
      {label && <span className="text-[13px]">{label}</span>}
    </button>
  )
}

/* ───────────── Surfaces ───────────── */

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'live' | 'warn' | 'danger'; className?: string }) {
  const TONE = {
    neutral: 'bg-raised text-ink-muted border-line',
    accent: 'bg-accent-soft text-accent border-transparent',
    live: 'bg-live-soft text-live border-transparent',
    warn: 'bg-warn-soft text-warn border-transparent',
    danger: 'bg-danger-soft text-danger border-transparent',
  }[tone]
  return <span className={cx('inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-[11.5px] font-medium whitespace-nowrap', TONE, className)}>{children}</span>
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-md bg-raised', className)} aria-hidden />
}

export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <div className="font-medium">{title}</div>
      {detail && <div className="max-w-sm text-ink-muted">{detail}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[18px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-0.5 text-ink-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function CopyButton({ text, label = 'Copy', size = 'sm' }: { text: string; label?: string; size?: Size }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      size={size}
      icon={done ? <Check size={13} className="text-live" /> : <Copy size={13} />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } catch {
          /* clipboard blocked; user can select the text */
        }
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  )
}

/* ───────────── Dialog ───────────── */

export function Dialog({ open, onClose, title, children, width = 'max-w-lg' }: { open: boolean; onClose: () => void; title: string; children: ReactNode; width?: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
      className={cx(
        'panel m-auto w-full p-0 text-ink shadow-pop backdrop:bg-black/50 backdrop:backdrop-blur-[2px] open:animate-fade-up',
        width,
      )}
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="font-semibold">{title}</h2>
        <button onClick={onClose} className="rounded-sm p-1 text-ink-faint hover:text-ink" aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <div className="px-4 py-4">{children}</div>
    </dialog>
  )
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel = 'Confirm',
  danger,
  loading,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  body: ReactNode
  confirmLabel?: string
  danger?: boolean
  loading?: boolean
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} width="max-w-md">
      <div className="text-ink-muted">{body}</div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  )
}

/* ───────────── Table ───────────── */

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('panel overflow-x-auto', className)}>
      <table className="w-full border-collapse text-left">{children}</table>
    </div>
  )
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={cx('eyebrow border-b border-line px-3 py-2 font-medium', className)}>{children}</th>
}

export function Td({ children, className, colSpan }: { children?: ReactNode; className?: string; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={cx('border-b border-line px-3 py-2 align-middle last:border-b-0', className)}>
      {children}
    </td>
  )
}
