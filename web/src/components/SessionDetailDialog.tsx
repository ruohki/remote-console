import { ArrowDownToLine, ArrowUpFromLine, Clipboard, Hand, MessageSquare, MonitorSmartphone, Volume2 } from 'lucide-react'
import type { SessionSummary } from '@/protocol'
import { Dialog, EmptyState, Skeleton } from '@/components/ui'
import { CodecBadge, SessionStateBadge } from '@/components/badges'
import { useSessionEvents } from '@/hooks/useSessionEvents'
import { bytes, dateTime, duration, END_REASON_LABEL } from '@/lib/format'
import type { SessionEventRow } from '@/store/live'

export function SessionDetailDialog({ session, open, onClose }: { session: SessionSummary | null; open: boolean; onClose: () => void }) {
  const { rows, isPending, hiddenEarlier, showEarlier, total } = useSessionEvents(open ? session?.id : null)
  return (
    <Dialog open={open} onClose={onClose} title="Session" width="max-w-2xl">
      {session && (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
            <Item label="State">
              <SessionStateBadge state={session.state} />
            </Item>
            <Item label="Device">{session.device_name}</Item>
            <Item label="Operator">{session.operator_name}</Item>
            <Item label="Codec">
              <CodecBadge codec={session.codec} />
            </Item>
            <Item label="Started">{dateTime(session.started_at)}</Item>
            <Item label="Connected">{dateTime(session.connected_at)}</Item>
            <Item label="Duration">{duration(session.connected_at ?? session.started_at, session.ended_at)}</Item>
            <Item label="Outcome">{session.end_reason ? END_REASON_LABEL[session.end_reason] : session.state === 'ended' ? '—' : 'in progress'}</Item>
          </dl>
          <div className="border-t border-line pt-3">
            <div className="mb-2 eyebrow">Timeline</div>
            {isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : rows.length === 0 ? (
              <EmptyState title="Nothing happened yet" detail="Chat, file and clipboard events appear here." />
            ) : (
              <>
                {hiddenEarlier > 0 && (
                  <button type="button" onClick={showEarlier} className="mb-2 text-[12.5px] text-accent hover:underline">
                    Show {Math.min(hiddenEarlier, 200)} earlier events ({total} total)
                  </button>
                )}
                <SessionTimeline rows={rows} />
              </>
            )}
          </div>
        </div>
      )}
    </Dialog>
  )
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] text-ink-faint uppercase tracking-wide">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  )
}

export function SessionTimeline({ rows, compact }: { rows: SessionEventRow[]; compact?: boolean }) {
  return (
    <ol className={compact ? 'flex flex-col gap-1.5 text-[12.5px]' : 'flex max-h-[50vh] flex-col gap-2 overflow-y-auto pr-1 text-[13px]'}>
      {rows.map((r) => (
        <li key={r.id} className="flex items-start gap-2.5">
          <span className="mono mt-0.5 w-[62px] shrink-0 text-[11px] text-ink-faint">{new Date(r.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          <span className="mt-0.5 shrink-0 text-ink-muted">{iconFor(r)}</span>
          <span className="min-w-0 flex-1 break-words">{describe(r)}</span>
        </li>
      ))}
    </ol>
  )
}

function iconFor(r: SessionEventRow) {
  switch (r.event.type) {
    case 'chat':
      return <MessageSquare size={14} />
    case 'transfer_started':
    case 'transfer_completed':
    case 'transfer_failed':
      return r.event.type !== 'transfer_failed' && r.event.direction === 'to_device' ? <ArrowUpFromLine size={14} /> : <ArrowDownToLine size={14} />
    case 'clipboard_sync':
      return <Clipboard size={14} />
    case 'displays_changed':
      return <MonitorSmartphone size={14} />
    case 'audio_changed':
      return <Volume2 size={14} />
    case 'control_paused':
      return <Hand size={14} />
    default:
      return null
  }
}

function describe(r: SessionEventRow): React.ReactNode {
  const e = r.event
  switch (e.type) {
    case 'chat':
      return (
        <>
          <span className="font-medium">{e.from === 'operator' ? 'Operator' : 'Device'}:</span> {e.text}
        </>
      )
    case 'transfer_started':
      return (
        <>
          {e.direction === 'to_device' ? 'Upload' : 'Download'} started: <span className="font-medium">{e.name}</span> ({bytes(Number(e.size))}
          {Number(e.offset) > 0 ? `, resumed at ${bytes(Number(e.offset))}` : ''}){e.kind !== 'file' ? ' · clipboard' : ''}
        </>
      )
    case 'transfer_completed':
      return (
        <>
          {e.direction === 'to_device' ? 'Upload' : 'Download'} completed: <span className="font-medium">{e.name}</span> ({bytes(Number(e.size))}){e.path ? <span className="mono text-ink-faint"> → {e.path}</span> : null}
        </>
      )
    case 'transfer_failed':
      return (
        <span className="text-danger">
          Transfer failed: <span className="font-medium">{e.name}</span> — {e.reason}
        </span>
      )
    case 'clipboard_sync':
      return <>Clipboard {e.direction === 'to_device' ? 'sent to the device' : 'received from the device'}: {e.summary}</>
    case 'displays_changed':
      return <>Streaming displays: {e.active.length ? e.active.map((i) => `#${i + 1}`).join(', ') : 'none'}</>
    case 'audio_changed':
      return <>Audio {e.enabled ? 'enabled' : 'disabled'}</>
    case 'control_paused':
      return e.paused ? <span className="font-medium text-amber-300">Remote control paused by the person at the device</span> : <>Remote control resumed by the person at the device</>
    default:
      return JSON.stringify(e)
  }
}
