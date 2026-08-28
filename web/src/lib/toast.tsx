import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { X } from 'lucide-react'

export type ToastKind = 'info' | 'success' | 'error'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface Toast {
  id: number
  kind: ToastKind
  title: string
  detail?: string
  /** Optional call-to-action button; the toast is dismissed when it is used. */
  action?: ToastAction
  /** Auto-dismiss after this many ms (default 4 s, 8 s for errors). */
  ttlMs?: number
  /** Toasts sharing a group can be dismissed together (e.g. all chat previews). */
  group?: string
}

interface ToastStore {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id'>) => number
  dismiss: (id: number) => void
  dismissGroup: (group: string) => void
}

let seq = 0

export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  push: (t) => {
    const id = ++seq
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), t.ttlMs ?? (t.kind === 'error' ? 8000 : 4000))
    return id
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
  dismissGroup: (group) => set((s) => ({ toasts: s.toasts.filter((x) => x.group !== group) })),
}))

export const toast = {
  info: (title: string, detail?: string) => useToasts.getState().push({ kind: 'info', title, detail }),
  success: (title: string, detail?: string) => useToasts.getState().push({ kind: 'success', title, detail }),
  error: (title: string, detail?: string) => useToasts.getState().push({ kind: 'error', title, detail }),
  /** Full control (action button, ttl, group). */
  custom: (t: Omit<Toast, 'id'>) => useToasts.getState().push(t),
  dismissGroup: (group: string) => useToasts.getState().dismissGroup(group),
}

const KIND_CLASS: Record<ToastKind, string> = {
  info: 'border-l-accent',
  success: 'border-l-live',
  error: 'border-l-danger',
}

/** The element in fullscreen, if any: only its subtree is visible, so the stack must live inside it. */
function useFullscreenElement(): Element | null {
  const [el, setEl] = useState<Element | null>(() => (typeof document === 'undefined' ? null : document.fullscreenElement))
  useEffect(() => {
    const onChange = () => setEl(document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  return el
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  const fullscreenEl = useFullscreenElement()
  if (toasts.length === 0) return null
  const stack = (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2" role="status" aria-live="polite" data-testid="toaster">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto panel animate-fade-up flex items-start gap-3 border-l-[3px] px-3 py-2.5 shadow-pop ${KIND_CLASS[t.kind]}`}
        >
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t.title}</div>
            {t.detail && <div className="mt-0.5 text-ink-muted text-[12.5px] break-words">{t.detail}</div>}
            {t.action && (
              <button
                onClick={() => {
                  dismiss(t.id)
                  t.action?.onClick()
                }}
                className="mt-1.5 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-ink hover:opacity-90"
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button onClick={() => dismiss(t.id)} className="text-ink-faint hover:text-ink -mr-1 rounded-sm p-0.5" aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
  return fullscreenEl ? createPortal(stack, fullscreenEl) : stack
}
