import { create } from 'zustand'
import { X } from 'lucide-react'

export type ToastKind = 'info' | 'success' | 'error'

export interface Toast {
  id: number
  kind: ToastKind
  title: string
  detail?: string
}

interface ToastStore {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id'>) => void
  dismiss: (id: number) => void
}

let seq = 0

export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  push: (t) => {
    const id = ++seq
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), t.kind === 'error' ? 8000 : 4000)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}))

export const toast = {
  info: (title: string, detail?: string) => useToasts.getState().push({ kind: 'info', title, detail }),
  success: (title: string, detail?: string) => useToasts.getState().push({ kind: 'success', title, detail }),
  error: (title: string, detail?: string) => useToasts.getState().push({ kind: 'error', title, detail }),
}

const KIND_CLASS: Record<ToastKind, string> = {
  info: 'border-l-accent',
  success: 'border-l-live',
  error: 'border-l-danger',
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto panel animate-fade-up flex items-start gap-3 border-l-[3px] px-3 py-2.5 shadow-pop ${KIND_CLASS[t.kind]}`}
        >
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t.title}</div>
            {t.detail && <div className="mt-0.5 text-ink-muted text-[12.5px] break-words">{t.detail}</div>}
          </div>
          <button onClick={() => dismiss(t.id)} className="text-ink-faint hover:text-ink -mr-1 rounded-sm p-0.5" aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
