import type { DisplayInfo } from '@/protocol'

/**
 * Multi-display negotiation helper.
 *
 * The browser adds one `recvonly` video transceiver per display **in `DisplayInfo` index
 * order** before creating the offer; the agent binds the i-th video m-line to display i.
 * `mapVideoTransceivers` turns the transceivers (in the order they were added) into a
 * `display index → transceiver` map so incoming tracks can be attributed.
 */
export interface DisplayBinding<T> {
  display: number
  transceiver: T
}

export function mapVideoTransceivers<T>(displays: readonly Pick<DisplayInfo, 'index'>[], transceivers: readonly T[]): DisplayBinding<T>[] {
  const ordered = [...displays].sort((a, b) => a.index - b.index)
  const out: DisplayBinding<T>[] = []
  for (let i = 0; i < transceivers.length; i++) {
    const d = ordered[i]
    out.push({ display: d ? d.index : i, transceiver: transceivers[i]! })
  }
  return out
}

/** How many video transceivers to create for a device (at least one). */
export function videoTransceiverCount(displays: readonly unknown[]): number {
  return Math.max(1, displays.length)
}

/** Primary display index (the `primary` flag wins, else the lowest index, else 0). */
export function primaryDisplay(displays: readonly DisplayInfo[]): number {
  const p = displays.find((d) => d.primary)
  if (p) return p.index
  return displays.length ? Math.min(...displays.map((d) => d.index)) : 0
}

/** Tile layout for the active displays: columns for a side-by-side strip that fits `aspect` best. */
export function tileGrid(count: number): { cols: number; rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 }
  if (count === 2) return { cols: 2, rows: 1 }
  const cols = Math.ceil(Math.sqrt(count))
  return { cols, rows: Math.ceil(count / cols) }
}
