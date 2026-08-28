import { useEffect, useRef, useState } from 'react'
import { Send, X } from 'lucide-react'
import type { ChatLine } from '@/hooks/useViewerSession'
import { cx } from '@/components/ui'
import { timeOfDay } from '@/lib/format'

export function ChatDrawer({ lines, deviceName, connected, onSend, onClose }: { lines: ChatLine[]; deviceName: string; connected: boolean; onSend: (text: string) => boolean; onClose: () => void }) {
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = () => {
    if (!draft.trim()) return
    if (onSend(draft)) setDraft('')
  }

  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col border-l border-white/10 bg-[#0e1116] text-[13px] text-[#e6e9ef]">
      <div className="flex h-10 items-center gap-2 border-b border-white/10 px-3">
        <span className="font-medium">Chat with {deviceName}</span>
        <button onClick={onClose} className="ml-auto rounded-md p-1.5 text-[#9aa3b2] hover:bg-white/10 hover:text-white" aria-label="Close chat">
          <X size={14} />
        </button>
      </div>
      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-2">
        {lines.length === 0 && <div className="m-auto text-center text-[12.5px] text-[#6b7381]">Messages appear on the device in a small window. Keep it short and friendly.</div>}
        {lines.map((l) => (
          <div key={l.id} className={cx('flex flex-col', l.from === 'operator' ? 'items-end' : 'items-start')}>
            <div className={cx('max-w-[85%] rounded-lg px-2.5 py-1.5 break-words whitespace-pre-wrap', l.from === 'operator' ? 'bg-[#6cb6ff]/20 text-white' : 'bg-white/10')}>{l.text}</div>
            <div className="mono mt-0.5 text-[10.5px] text-[#6b7381]">
              {l.from === 'operator' ? 'You' : deviceName} · {timeOfDay(l.tsMs)}
            </div>
          </div>
        ))}
      </div>
      <form
        className="flex items-end gap-2 border-t border-white/10 p-2"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // The viewer captures keys for the remote machine; keep them here.
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          onKeyUp={(e) => e.stopPropagation()}
          rows={2}
          placeholder={connected ? 'Type a message… (Enter to send)' : 'Not connected'}
          disabled={!connected}
          className="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[13px] text-white placeholder:text-[#6b7381] focus:border-[#6cb6ff] focus:outline-none disabled:opacity-50"
        />
        <button type="submit" disabled={!connected || !draft.trim()} className="rounded-md bg-[#6cb6ff] p-2 text-[#0b1220] disabled:opacity-40" aria-label="Send">
          <Send size={14} />
        </button>
      </form>
    </aside>
  )
}
