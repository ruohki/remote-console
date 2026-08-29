/** One-line summary of an audit entry's payload for the table; the dialog shows the full JSON. */

const MAX_LEN = 140
const MAX_VALUE = 48

function parse(d: unknown): unknown {
  if (typeof d !== 'string') return d
  try {
    return JSON.parse(d)
  } catch {
    return d
  }
}

function short(v: unknown): string {
  let s: string
  if (v === null || v === undefined) s = '—'
  else if (typeof v === 'string') s = v
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v)
  else s = JSON.stringify(v)
  return s.length > MAX_VALUE ? s.slice(0, MAX_VALUE - 1) + '…' : s
}

export function summarizeDetails(details: unknown): string {
  const d = parse(details)
  if (d === null || d === undefined || d === '') return ''
  let out: string
  if (typeof d === 'object' && !Array.isArray(d)) {
    const pairs = Object.entries(d as Record<string, unknown>)
    if (pairs.length === 0) return ''
    out = pairs.map(([k, v]) => `${k}: ${short(v)}`).join(' · ')
  } else {
    out = short(d)
  }
  return out.length > MAX_LEN ? out.slice(0, MAX_LEN - 1) + '…' : out
}
