const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' })

/** "just now", "5 min. ago", "yesterday" … */
export function relativeTime(iso?: string | null, now = Date.now()): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const diff = (t - now) / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return 'just now'
  for (const [unit, secs] of UNITS) {
    if (abs >= secs) return rtf.format(Math.round(diff / secs), unit)
  }
  return rtf.format(Math.round(diff / 60), 'minute')
}

const dtf = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

export function dateTime(iso?: string | null): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  return Number.isNaN(t) ? '—' : dtf.format(t)
}

export function duration(startIso?: string | null, endIso?: string | null, now = Date.now()): string {
  if (!startIso) return '—'
  const start = Date.parse(startIso)
  const end = endIso ? Date.parse(endIso) : now
  if (Number.isNaN(start) || Number.isNaN(end)) return '—'
  const s = Math.max(0, Math.round((end - start) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`
  if (m > 0) return `${m}m ${sec.toString().padStart(2, '0')}s`
  return `${sec}s`
}

export function kbps(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)} Mb/s` : `${Math.round(v)} kb/s`
}

export function shortId(id: string, keep = 8): string {
  return id.length <= keep + 4 ? id : `${id.slice(0, keep)}…`
}

export const OS_LABEL: Record<string, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
}

export const MODE_LABEL = {
  unattended: 'Unattended',
  help_me: 'Help me',
} as const

export const SESSION_STATE_LABEL = {
  requested: 'Requested',
  awaiting_approval: 'Waiting for approval',
  connecting: 'Connecting',
  connected: 'Connected',
  ended: 'Ended',
} as const

export const END_REASON_LABEL = {
  operator_closed: 'Closed by operator',
  device_user_closed: 'Closed at the device',
  denied: 'Denied at the device',
  approval_timeout: 'No answer at the device',
  agent_offline: 'Device went offline',
  connection_failed: 'Connection failed',
  error: 'Error',
} as const

export const CODEC_LABEL = { h265: 'H.265', h264: 'H.264' } as const

/** 1234567 → "1.2 MB" */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

/** bytes per second → "12.3 MB/s" */
export function throughput(bps: number): string {
  return bps > 0 ? `${bytes(bps)}/s` : '—'
}

/** remaining seconds → "2m 05s" */
export function eta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

const compactSameYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const compactOtherYear = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** Short absolute time for tables ("Aug 29, 12:55 PM"; the year only when it differs). */
export function compactDateTime(iso?: string | null, now = Date.now()): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear()
  return (sameYear ? compactSameYear : compactOtherYear).format(t)
}
