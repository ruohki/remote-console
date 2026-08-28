/** Aggregates over the transfer list for the drawer's summary strip and badges. */

import { isTerminal, type Transfer } from './manager'

export interface TransferSummary {
  /** Not finished yet (queued, offered, transferring, paused, verifying). */
  active: number
  sending: number
  receiving: number
  failed: number
  done: number
  /** Bytes moved / bytes total over the active transfers. */
  bytesDone: number
  bytesTotal: number
  /** Sum of the current speeds. */
  speedBps: number
  etaS: number | null
  /** Bytes compression kept off the wire (all transfers in the list). */
  savedBytes: number
}

export function summarize(ts: Transfer[]): TransferSummary {
  const s: TransferSummary = { active: 0, sending: 0, receiving: 0, failed: 0, done: 0, bytesDone: 0, bytesTotal: 0, speedBps: 0, etaS: null, savedBytes: 0 }
  for (const t of ts) {
    s.savedBytes += Math.max(0, t.payloadBytes - t.wireBytes)
    if (isTerminal(t.status)) {
      if (t.status === 'done') s.done++
      else s.failed++
      continue
    }
    s.active++
    if (t.direction === 'to_device') s.sending++
    else s.receiving++
    s.bytesDone += Math.min(t.bytes, t.size)
    s.bytesTotal += t.size
    if (t.status === 'transferring') s.speedBps += t.speedBps
  }
  if (s.speedBps > 0 && s.bytesTotal > s.bytesDone) s.etaS = (s.bytesTotal - s.bytesDone) / s.speedBps
  return s
}

/** Compression ratio of one transfer (`null` until something went over the wire or when it did not help). */
export function compressionRatio(t: Transfer): number | null {
  if (t.wireBytes <= 0 || t.payloadBytes <= 0) return null
  const r = t.payloadBytes / t.wireBytes
  return r >= 1.05 ? r : null
}
