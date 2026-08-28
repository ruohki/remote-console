/** Pure list logic of the remote file browser: sorting, filtering, selection ranges, focus. */

import type { FileEntry } from '@/protocol'

export type SortKey = 'name' | 'size' | 'modified'
export type SortDir = 'asc' | 'desc'

const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })

const CMP: Record<SortKey, (a: FileEntry, b: FileEntry) => number> = {
  name: byName,
  size: (a, b) => Number(a.size) - Number(b.size) || byName(a, b),
  modified: (a, b) => Number(a.modified_ms ?? 0) - Number(b.modified_ms ?? 0) || byName(a, b),
}

/** Folders always come first; within each group the chosen column decides. */
export function sortEntries(entries: FileEntry[], key: SortKey, dir: SortDir): FileEntry[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...entries].sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || sign * CMP[key](a, b))
}

/** Case-insensitive substring filter; hidden entries only when asked for. */
export function filterEntries(entries: FileEntry[], query: string, showHidden: boolean): FileEntry[] {
  const q = query.trim().toLowerCase()
  return entries.filter((e) => (showHidden || !e.hidden) && (!q || e.name.toLowerCase().includes(q)))
}

/** Names between `anchor` and `target` (inclusive) in list order; just `target` when the anchor is gone. */
export function rangeSelect(names: string[], anchor: string | null, target: string): string[] {
  const t = names.indexOf(target)
  if (t < 0) return []
  const a = anchor === null ? -1 : names.indexOf(anchor)
  if (a < 0) return [target]
  const [lo, hi] = a < t ? [a, t] : [t, a]
  return names.slice(lo, hi + 1)
}

/** Keyboard focus movement; clamps at the ends and starts at the first/last row when nothing is focused. */
export function moveFocus(names: string[], current: string | null, delta: number): string | null {
  if (!names.length) return null
  const i = current === null ? -1 : names.indexOf(current)
  if (i < 0) return delta > 0 ? names[0]! : names[names.length - 1]!
  return names[Math.min(names.length - 1, Math.max(0, i + delta))]!
}

export function toggleSort(current: { key: SortKey; dir: SortDir }, key: SortKey): { key: SortKey; dir: SortDir } {
  if (current.key !== key) return { key, dir: key === 'name' ? 'asc' : 'desc' }
  return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
}
