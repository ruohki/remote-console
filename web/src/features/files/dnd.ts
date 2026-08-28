/**
 * Drag-and-drop helpers for the viewer: detect file drags and flatten dropped items
 * (including folders, via the WebKit entry API) into a list of files.
 */

/** True when the drag carries files (not text/links dragged from the page itself). */
export function isFileDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false
  const types = Array.from(dt.types ?? [])
  return types.includes('Files')
}

/** Minimal shape of `FileSystemEntry` we rely on (keeps tests independent of the DOM types). */
export interface EntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  fullPath?: string
  file?: (ok: (f: File) => void, err?: (e: unknown) => void) => void
  createReader?: () => { readEntries: (ok: (entries: EntryLike[]) => void, err?: (e: unknown) => void) => void }
}

export interface DroppedFile {
  file: File
  /** Path relative to the drop root, e.g. `docs/readme.md` for files inside a dropped folder. */
  relativePath: string
}

const MAX_FILES = 5000

/** Recursively collect files from a dropped entry (folder trees are walked breadth-first). */
export async function collectEntry(entry: EntryLike, prefix = '', out: DroppedFile[] = []): Promise<DroppedFile[]> {
  if (out.length >= MAX_FILES) return out
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((ok, err) => entry.file!(ok, err))
    out.push({ file, relativePath: prefix + entry.name })
    return out
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader()
    // readEntries returns batches; keep reading until an empty batch.
    for (;;) {
      const batch = await new Promise<EntryLike[]>((ok, err) => reader.readEntries(ok, err))
      if (!batch.length) break
      for (const child of batch) await collectEntry(child, `${prefix}${entry.name}/`, out)
      if (out.length >= MAX_FILES) break
    }
  }
  return out
}

/**
 * Flatten a drop into files. Uses `webkitGetAsEntry` when available (folders), else falls back
 * to `dataTransfer.files`. Must be called synchronously from the drop handler — the item list
 * is only readable during the event — so we snapshot the entries/files first.
 */
export function snapshotDrop(dt: DataTransfer): { entries: EntryLike[]; files: File[] } {
  const entries: EntryLike[] = []
  const items = Array.from(dt.items ?? [])
  for (const it of items) {
    if (it.kind !== 'file') continue
    const getEntry = (it as DataTransferItem & { webkitGetAsEntry?: () => EntryLike | null }).webkitGetAsEntry
    const entry = typeof getEntry === 'function' ? getEntry.call(it) : null
    if (entry) entries.push(entry)
  }
  return { entries, files: Array.from(dt.files ?? []) }
}

export async function flattenDrop(snapshot: { entries: EntryLike[]; files: File[] }): Promise<DroppedFile[]> {
  if (snapshot.entries.length) {
    const out: DroppedFile[] = []
    for (const e of snapshot.entries) await collectEntry(e, '', out)
    if (out.length) return out
  }
  return snapshot.files.map((file) => ({ file, relativePath: file.name }))
}

/** Human summary for the drop overlay / toast. */
export function describeDrop(files: DroppedFile[]): string {
  const folders = new Set(files.map((f) => f.relativePath.split('/')[0]).filter((p, _i, _a) => files.some((f) => f.relativePath.startsWith(p + '/'))))
  const n = files.length
  const base = `${n} file${n === 1 ? '' : 's'}`
  return folders.size ? `${base} in ${folders.size} folder${folders.size === 1 ? '' : 's'}` : base
}
