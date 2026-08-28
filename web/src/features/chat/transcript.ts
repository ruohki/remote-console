import type { ChatParty } from '@/protocol'

/**
 * One line in the viewer chat transcript.
 *
 * Lines reach the viewer from three sources that are NOT clock-aligned:
 *  - `local`  — the operator's own line, echoed immediately (client clock).
 *  - `remote` — a device line arriving on the WebRTC `control` channel (agent clock).
 *  - `event`  — the agent's `SessionEvent::Chat`, relayed by the console over `/ws/ui` and
 *               replayed from `GET /api/sessions/:id/events` on reconnect (console clock).
 *
 * The console reports *every* line as a session event, so each operator line and each device
 * line also arrives as an `event` echo with a different timestamp. Keying on the timestamp
 * would double every message. Instead we dedupe on `(from, text)` with a "consume the earliest
 * unconfirmed match" rule and treat the `event` echo as a delivery confirmation.
 */
export interface ChatLine {
  id: string
  from: ChatParty
  text: string
  tsMs: number
  /** Stable identity of the persisted event that produced/confirmed this line, if any. */
  eventKey?: string
  /** An `event` echo has been matched to this line (it exists server-side). */
  confirmed?: boolean
  /** Operator line whose delivery the server has confirmed (renders a check). */
  delivered?: boolean
}

export type ChatSource = 'local' | 'remote' | 'event'

/** Identity used to make repeated seeding idempotent. */
function keyOf(line: ChatLine): string {
  if (line.eventKey) return line.eventKey
  if (line.id.startsWith('ev-') && !line.id.endsWith('undefined')) return line.id
  return `${line.tsMs}|${line.from}|${line.text}`
}

/** Earliest not-yet-confirmed line with the same author and text. */
function matchIndex(lines: ChatLine[], from: ChatParty, text: string): number {
  return lines.findIndex((l) => !l.confirmed && l.from === from && l.text === text)
}

/**
 * Fold one incoming line into the transcript.
 *
 *  - `local`  → append a pending operator bubble.
 *  - `remote` → append the authoritative device line.
 *  - `event`  → if an identical event was already folded in, do nothing (idempotent); else
 *               confirm the earliest matching pending line (marking operator lines delivered);
 *               else append it as an already-confirmed line (history the local side never saw,
 *               or an event that beat its control-channel twin).
 */
export function applyChatLine(lines: ChatLine[], incoming: ChatLine, source: ChatSource): ChatLine[] {
  if (source === 'event') {
    const key = keyOf(incoming)
    if (lines.some((l) => l.eventKey === key)) return lines
    const i = matchIndex(lines, incoming.from, incoming.text)
    const existing = i >= 0 ? lines[i] : undefined
    if (existing) {
      const next = lines.slice()
      next[i] = { ...existing, confirmed: true, eventKey: key, delivered: existing.from === 'operator' ? true : existing.delivered }
      return next
    }
    return [...lines, { ...incoming, eventKey: key, confirmed: true, delivered: incoming.from === 'operator' }]
  }
  // local / remote: a live line that a later event will confirm.
  return [...lines, { ...incoming, confirmed: false }]
}

/**
 * Merge a batch of persisted/live `event` lines (a reconnect seed or the live session-event
 * stream) into the transcript in chronological order. Safe to call repeatedly with a growing
 * cumulative batch — already-folded events are skipped.
 */
export function mergeChatSeed(lines: ChatLine[], seed: ChatLine[]): ChatLine[] {
  let out = lines
  for (const s of [...seed].sort((a, b) => a.tsMs - b.tsMs)) {
    out = applyChatLine(out, s, 'event')
  }
  return out
}
