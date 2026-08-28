/**
 * Pure logic of the side-by-side file manager: the local pane's state machine, where a drop
 * lands, how fetched files are written and how internal drags are told apart from OS drags.
 */

import type { SortDir } from './browseModel'

/* ───────────────────────── local pane ───────────────────────── */

export interface LocalEntry {
  name: string
  isDir: boolean
  size: number
  modifiedMs: number
}

export type LocalSortKey = 'name' | 'size' | 'modified'

/**
 * `closed`: no folder chosen; `prompt`: a remembered folder needs its permission re-granted
 * (the browser only keeps handles, not grants, across page loads); `granted`: browsable.
 */
export type LocalAccess = 'closed' | 'prompt' | 'granted'

export interface LocalState {
  rootName: string | null
  access: LocalAccess
  /** Folder names below the root, outermost first. */
  segments: string[]
  entries: LocalEntry[]
  loading: boolean
  error: string | null
  selected: Set<string>
  anchor: string | null
  focus: string | null
  sort: { key: LocalSortKey; dir: SortDir }
  showHidden: boolean
  query: string
  /** Bumped by every navigation so a slow listing of a folder we already left is dropped. */
  generation: number
}

export type LocalAction =
  | { type: 'root'; name: string; access: 'granted' | 'prompt' }
  | { type: 'granted' }
  | { type: 'close' }
  | { type: 'enter'; name: string }
  | { type: 'up' }
  | { type: 'goto'; depth: number }
  | { type: 'refresh' }
  | { type: 'listed'; generation: number; entries: LocalEntry[] }
  | { type: 'error'; generation: number; message: string }
  | { type: 'select'; name: string; mode: 'single' | 'toggle' | 'range' }
  | { type: 'select-all' }
  | { type: 'clear' }
  | { type: 'move'; delta: 1 | -1; extend: boolean }
  | { type: 'sort'; key: LocalSortKey }
  | { type: 'hidden'; show: boolean }
  | { type: 'query'; value: string }

export function initialLocalState(): LocalState {
  return {
    rootName: null,
    access: 'closed',
    segments: [],
    entries: [],
    loading: false,
    error: null,
    selected: new Set(),
    anchor: null,
    focus: null,
    sort: { key: 'name', dir: 'asc' },
    showHidden: false,
    query: '',
    generation: 0,
  }
}

const byName = (a: LocalEntry, b: LocalEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
const LOCAL_CMP: Record<LocalSortKey, (a: LocalEntry, b: LocalEntry) => number> = {
  name: byName,
  size: (a, b) => a.size - b.size || byName(a, b),
  modified: (a, b) => a.modifiedMs - b.modifiedMs || byName(a, b),
}

/** Rows the pane shows: hidden filter, substring filter, folders first, chosen column order. */
export function visibleLocal(s: LocalState): LocalEntry[] {
  const q = s.query.trim().toLowerCase()
  const sign = s.sort.dir === 'asc' ? 1 : -1
  return s.entries
    .filter((e) => (s.showHidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || sign * LOCAL_CMP[s.sort.key](a, b))
}

/** Human path of the folder shown, e.g. `Projects/site/img`. */
export function localPathLabel(s: LocalState): string {
  return [s.rootName ?? '', ...s.segments].filter(Boolean).join('/')
}

function navigate(s: LocalState, segments: string[]): LocalState {
  return { ...s, segments, entries: [], loading: true, error: null, selected: new Set(), anchor: null, focus: null, query: '', generation: s.generation + 1 }
}

function rangeNames(names: string[], anchor: string | null, target: string): string[] {
  const t = names.indexOf(target)
  if (t < 0) return []
  const a = anchor === null ? -1 : names.indexOf(anchor)
  if (a < 0) return [target]
  const [lo, hi] = a < t ? [a, t] : [t, a]
  return names.slice(lo, hi + 1)
}

export function localReducer(s: LocalState, a: LocalAction): LocalState {
  switch (a.type) {
    case 'root': {
      const next = { ...initialLocalState(), rootName: a.name, access: a.access, sort: s.sort, showHidden: s.showHidden, generation: s.generation + 1 }
      return a.access === 'granted' ? { ...next, loading: true } : next
    }
    case 'granted':
      return s.access === 'prompt' ? { ...navigate(s, []), access: 'granted' } : s
    case 'close':
      return { ...initialLocalState(), sort: s.sort, showHidden: s.showHidden, generation: s.generation + 1 }
    case 'enter': {
      const e = s.entries.find((x) => x.name === a.name)
      if (!e?.isDir || s.access !== 'granted') return s
      return navigate(s, [...s.segments, a.name])
    }
    case 'up':
      return s.segments.length ? navigate(s, s.segments.slice(0, -1)) : s
    case 'goto': {
      const depth = Math.max(0, Math.min(s.segments.length, a.depth))
      return depth === s.segments.length ? s : navigate(s, s.segments.slice(0, depth))
    }
    case 'refresh':
      return s.access === 'granted' ? { ...s, loading: true, error: null, generation: s.generation + 1 } : s
    case 'listed':
      if (a.generation !== s.generation) return s
      return { ...s, entries: a.entries, loading: false, error: null, selected: new Set([...s.selected].filter((n) => a.entries.some((e) => e.name === n))) }
    case 'error':
      if (a.generation !== s.generation) return s
      return { ...s, entries: [], loading: false, error: a.message }
    case 'select': {
      const names = visibleLocal(s).map((e) => e.name)
      if (!names.includes(a.name)) return s
      if (a.mode === 'range') return { ...s, selected: new Set(rangeNames(names, s.anchor, a.name)), focus: a.name }
      if (a.mode === 'toggle') {
        const selected = new Set(s.selected)
        if (selected.has(a.name)) selected.delete(a.name)
        else selected.add(a.name)
        return { ...s, selected, anchor: a.name, focus: a.name }
      }
      return { ...s, selected: new Set([a.name]), anchor: a.name, focus: a.name }
    }
    case 'select-all':
      return { ...s, selected: new Set(visibleLocal(s).map((e) => e.name)) }
    case 'clear':
      return s.selected.size || s.anchor ? { ...s, selected: new Set(), anchor: null } : s
    case 'move': {
      const names = visibleLocal(s).map((e) => e.name)
      if (!names.length) return s
      const i = s.focus === null ? -1 : names.indexOf(s.focus)
      const next = i < 0 ? (a.delta > 0 ? names[0]! : names[names.length - 1]!) : names[Math.min(names.length - 1, Math.max(0, i + a.delta))]!
      if (a.extend) return { ...s, focus: next, selected: new Set(rangeNames(names, s.anchor ?? s.focus, next)) }
      return { ...s, focus: next, selected: new Set([next]), anchor: next }
    }
    case 'sort':
      if (s.sort.key !== a.key) return { ...s, sort: { key: a.key, dir: a.key === 'name' ? 'asc' : 'desc' } }
      return { ...s, sort: { key: a.key, dir: s.sort.dir === 'asc' ? 'desc' : 'asc' } }
    case 'hidden':
      return { ...s, showHidden: a.show }
    case 'query':
      return { ...s, query: a.value }
  }
}

/* ───────────────────────── drop targets ───────────────────────── */

export interface DropRow {
  name: string
  isDir: boolean
  /** Full path of the row (device path or local segments joined). */
  path: string
}

export interface DropTarget {
  dir: string
  /** Whether a folder row took the drop or it fell through to the pane's current folder. */
  into: 'row' | 'pane'
}

/**
 * Where a drop lands: a folder row takes it, a file row (or empty space) hands it to the folder
 * the pane is showing. `null` when the pane has nothing to drop into (roots view, no local folder).
 */
export function resolveDropTarget(paneDir: string | null, row: DropRow | null): DropTarget | null {
  if (row?.isDir) return { dir: row.path, into: 'row' }
  return paneDir === null ? null : { dir: paneDir, into: 'pane' }
}

/* ───────────────────────── fetch targets ───────────────────────── */

export type FetchTarget = 'local-folder' | 'save-picker' | 'directory-picker' | 'browser-download'

/**
 * How files fetched from the device are written: straight into the open local folder when
 * there is one, otherwise through the pickers where the browser has them, else as classic
 * downloads (held in memory first).
 */
export function chooseFetchTarget(o: { localFolderOpen: boolean; fileSystemAccess: boolean; directoryPicker: boolean; count: number }): FetchTarget {
  if (o.localFolderOpen) return 'local-folder'
  if (o.count === 1 && o.fileSystemAccess) return 'save-picker'
  if (o.count > 1 && o.directoryPicker) return 'directory-picker'
  return 'browser-download'
}

/* ───────────────────────── internal drags ───────────────────────── */

/** Custom `DataTransfer` types that mark a drag started inside the manager. */
export const LOCAL_DRAG_TYPE = 'application/x-remote-console-local'
export const REMOTE_DRAG_TYPE = 'application/x-remote-console-remote'

export type DragKind = 'local' | 'remote' | 'os'

/** Classify a drag by its advertised types (data is not readable until the drop). */
export function dragKind(types: readonly string[] | null | undefined): DragKind | null {
  const t = Array.from(types ?? [])
  if (t.includes(LOCAL_DRAG_TYPE)) return 'local'
  if (t.includes(REMOTE_DRAG_TYPE)) return 'remote'
  if (t.includes('Files')) return 'os'
  return null
}

export interface RemoteDragItem {
  name: string
  path: string
  size: number
  isDir: boolean
}

export type DragPayload = { kind: 'local'; names: string[] } | { kind: 'remote'; items: RemoteDragItem[] }

/* The browser only lets the drop handler read drag data, and file handles cannot ride in a
 * DataTransfer anyway, so the payload of an internal drag lives here for its duration. */
let payload: DragPayload | null = null

export function setDragPayload(p: DragPayload | null) {
  payload = p
}

export function peekDragPayload(): DragPayload | null {
  return payload
}

export function takeDragPayload(): DragPayload | null {
  const p = payload
  payload = null
  return p
}
