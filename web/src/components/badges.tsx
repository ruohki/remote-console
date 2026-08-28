import { Apple, Monitor, Terminal } from 'lucide-react'
import type { DeviceMode, DeviceSummary, Os, SessionState, VideoCodec } from '@/protocol'
import { Badge, cx } from './ui'
import { CODEC_LABEL, MODE_LABEL, SESSION_STATE_LABEL } from '@/lib/format'

export function StatusLed({ device, className }: { device: Pick<DeviceSummary, 'online' | 'active_session_id' | 'mode'>; className?: string }) {
  const cls = !device.online ? 'led-off' : device.active_session_id ? 'led-busy' : 'led-live'
  const title = !device.online ? 'Offline' : device.active_session_id ? 'In a session' : 'Online'
  return <span className={cx('led', cls, className)} title={title} aria-label={title} />
}

export function OsIcon({ os, size = 14, className }: { os: Os; size?: number; className?: string }) {
  const c = cx('shrink-0 text-ink-faint', className)
  if (os === 'macos') return <Apple size={size} className={c} aria-label="macOS" />
  if (os === 'windows') return <Monitor size={size} className={c} aria-label="Windows" />
  return <Terminal size={size} className={c} aria-label="Linux" />
}

export function ModeBadge({ mode }: { mode: DeviceMode }) {
  return <Badge tone={mode === 'help_me' ? 'warn' : 'neutral'}>{MODE_LABEL[mode]}</Badge>
}

export function SessionStateBadge({ state }: { state: SessionState }) {
  const tone = state === 'connected' ? 'live' : state === 'awaiting_approval' ? 'warn' : state === 'ended' ? 'neutral' : 'accent'
  return (
    <Badge tone={tone}>
      {state === 'awaiting_approval' && <span className="led led-warn size-1.5" />}
      {SESSION_STATE_LABEL[state]}
    </Badge>
  )
}

export function CodecBadge({ codec }: { codec?: VideoCodec | null }) {
  if (!codec) return <span className="text-ink-faint">—</span>
  return <span className="mono text-ink-muted">{CODEC_LABEL[codec]}</span>
}

export function Tags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null
  return (
    <span className="inline-flex flex-wrap gap-1">
      {tags.map((t) => (
        <span key={t} className="rounded-sm bg-raised px-1.5 py-px text-[11px] text-ink-muted">
          {t}
        </span>
      ))}
    </span>
  )
}
