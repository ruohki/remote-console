/**
 * The local pane's view of a folder on this computer through the File System Access API:
 * listing, resolving sub-folders, reading files for upload, walking trees, and remembering the
 * chosen root handle in IndexedDB (handles survive reloads; the permission grant does not).
 */

import type { LocalEntry } from './managerModel'

type Permission = 'granted' | 'denied' | 'prompt'
type HandleWithPermission = {
  queryPermission?(o: { mode: 'read' | 'readwrite' }): Promise<Permission>
  requestPermission?(o: { mode: 'read' | 'readwrite' }): Promise<Permission>
}
type IterableDirectory = { values(): AsyncIterable<FileSystemHandle> }

export async function queryAccess(h: FileSystemDirectoryHandle): Promise<Permission> {
  const p = h as unknown as HandleWithPermission
  try {
    return (await p.queryPermission?.({ mode: 'readwrite' })) ?? 'granted'
  } catch {
    return 'prompt'
  }
}

/** Must run inside a user gesture. */
export async function requestAccess(h: FileSystemDirectoryHandle): Promise<boolean> {
  const p = h as unknown as HandleWithPermission
  try {
    return ((await p.requestPermission?.({ mode: 'readwrite' })) ?? 'granted') === 'granted'
  } catch {
    return false
  }
}

export async function listLocal(dir: FileSystemDirectoryHandle): Promise<LocalEntry[]> {
  const out: LocalEntry[] = []
  for await (const h of (dir as unknown as IterableDirectory).values()) {
    if (h.kind === 'directory') out.push({ name: h.name, isDir: true, size: 0, modifiedMs: 0 })
    else {
      try {
        const f = await (h as FileSystemFileHandle).getFile()
        out.push({ name: h.name, isDir: false, size: f.size, modifiedMs: f.lastModified })
      } catch {
        out.push({ name: h.name, isDir: false, size: 0, modifiedMs: 0 })
      }
    }
  }
  return out
}

export async function resolveLocalDir(root: FileSystemDirectoryHandle, segments: string[]): Promise<FileSystemDirectoryHandle> {
  let dir = root
  for (const s of segments) dir = await dir.getDirectoryHandle(s)
  return dir
}

export async function readLocalFiles(dir: FileSystemDirectoryHandle, names: string[]): Promise<File[]> {
  const out: File[] = []
  for (const n of names) out.push(await (await dir.getFileHandle(n)).getFile())
  return out
}

export interface LocalTree {
  /** Relative folder paths (`/`-separated) that exist in the tree, parents before children. */
  dirs: string[]
  files: { file: File; relDir: string }[]
}

const MAX_FILES = 5000

/** Collect every file below `dir`; `prefix` is the relative folder the walk started in. */
export async function walkLocalDir(dir: FileSystemDirectoryHandle, prefix: string, out: LocalTree = { dirs: [], files: [] }): Promise<LocalTree> {
  if (prefix) out.dirs.push(prefix)
  for await (const h of (dir as unknown as IterableDirectory).values()) {
    if (out.files.length >= MAX_FILES) break
    if (h.kind === 'directory') await walkLocalDir(h as FileSystemDirectoryHandle, prefix ? `${prefix}/${h.name}` : h.name, out)
    else out.files.push({ file: await (h as FileSystemFileHandle).getFile(), relDir: prefix })
  }
  return out
}

/* ── remembered root handle ── */

const DB_NAME = 'remote-console-local'
const STORE = 'roots'
const ANY_DEVICE = '*'

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, 1)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

async function withRoots<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await openDb()
  if (!db) return undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

/** The folder last used with a device, falling back to the last folder used with any device. */
export const localRootStore = {
  async get(deviceId: string): Promise<FileSystemDirectoryHandle | null> {
    const own = await withRoots<FileSystemDirectoryHandle | undefined>('readonly', (s) => s.get(deviceId) as IDBRequest<FileSystemDirectoryHandle | undefined>)
    if (own) return own
    return (await withRoots<FileSystemDirectoryHandle | undefined>('readonly', (s) => s.get(ANY_DEVICE) as IDBRequest<FileSystemDirectoryHandle | undefined>)) ?? null
  },
  async put(deviceId: string, handle: FileSystemDirectoryHandle): Promise<void> {
    await withRoots('readwrite', (s) => s.put(handle, deviceId))
    await withRoots('readwrite', (s) => s.put(handle, ANY_DEVICE))
  },
  async clear(deviceId: string): Promise<void> {
    await withRoots('readwrite', (s) => s.delete(deviceId))
    await withRoots('readwrite', (s) => s.delete(ANY_DEVICE))
  },
}
