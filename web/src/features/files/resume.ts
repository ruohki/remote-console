/**
 * Persistence that makes transfers resumable across page reloads (IndexedDB).
 *
 * * `uploads`: keyed by `deviceId|name|size|lastModified` → the transfer token, so dropping
 *   the same file again re-offers it with the same token and the agent answers with the
 *   offset it already holds.
 * * `downloads`: keyed by `deviceId|remotePath|size` → bytes written so far plus the
 *   `FileSystemFileHandle` (structured-cloneable), so the download can continue into the
 *   same file after re-requesting it.
 */

const DB_NAME = 'remote-console'
const DB_VERSION = 1

export interface UploadRecord {
  key: string
  deviceId: string
  token: string
  name: string
  size: number
  lastModified: number
  destDir?: string
  updatedAt: number
}

export interface DownloadRecord {
  key: string
  deviceId: string
  remotePath: string
  name: string
  size: number
  bytesWritten: number
  handle?: FileSystemFileHandle
  updatedAt: number
}

export function uploadKey(deviceId: string, f: { name: string; size: number; lastModified: number }): string {
  return `${deviceId}|${f.name}|${f.size}|${f.lastModified}`
}

export function downloadKey(deviceId: string, remotePath: string, size: number): string {
  return `${deviceId}|${remotePath}|${size}`
}

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('uploads')) db.createObjectStore('uploads', { keyPath: 'key' })
      if (!db.objectStoreNames.contains('downloads')) db.createObjectStore('downloads', { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

async function withStore<T>(name: 'uploads' | 'downloads', mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await open()
  if (!db) return undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(name, mode)
      const req = fn(tx.objectStore(name))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

export const resumeStore = {
  getUpload: (key: string) => withStore<UploadRecord | undefined>('uploads', 'readonly', (s) => s.get(key) as IDBRequest<UploadRecord | undefined>),
  putUpload: (r: UploadRecord) => withStore('uploads', 'readwrite', (s) => s.put(r)),
  deleteUpload: (key: string) => withStore('uploads', 'readwrite', (s) => s.delete(key)),
  listUploads: async (deviceId: string) => ((await withStore<UploadRecord[]>('uploads', 'readonly', (s) => s.getAll() as IDBRequest<UploadRecord[]>)) ?? []).filter((r) => r.deviceId === deviceId),

  getDownload: (key: string) => withStore<DownloadRecord | undefined>('downloads', 'readonly', (s) => s.get(key) as IDBRequest<DownloadRecord | undefined>),
  putDownload: (r: DownloadRecord) => withStore('downloads', 'readwrite', (s) => s.put(r)),
  deleteDownload: (key: string) => withStore('downloads', 'readwrite', (s) => s.delete(key)),
  listDownloads: async (deviceId: string) => ((await withStore<DownloadRecord[]>('downloads', 'readonly', (s) => s.getAll() as IDBRequest<DownloadRecord[]>)) ?? []).filter((r) => r.deviceId === deviceId),
}

/** Random, URL-safe token identifying a logical transfer across sessions. */
export function newToken(): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
