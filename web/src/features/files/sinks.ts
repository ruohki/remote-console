/**
 * Where downloaded bytes go.
 *
 * * `FileSystemSink` streams straight to disk through the File System Access API
 *   (Chromium/Brave/Edge) and supports resuming into the same file.
 * * `MemorySink` collects chunks in memory and triggers a classic download when done
 *   (Safari/Firefox fallback; warned about above `MEMORY_SINK_WARN_BYTES`).
 * * `BlobSink` collects chunks and hands back the Blob (clipboard images).
 */

export const MEMORY_SINK_WARN_BYTES = 500 * 1024 * 1024

export interface Sink {
  readonly kind: 'fs' | 'memory' | 'blob'
  /** Bytes already present before this session (resume point). */
  readonly initialOffset: number
  write(chunk: Uint8Array): Promise<void>
  /** Finish successfully; returns the Blob for memory/blob sinks. */
  finish(): Promise<Blob | undefined>
  /** Discard (keeps partial data on disk for the fs sink so it can be resumed later). */
  abort(): Promise<void>
}

export function fileSystemAccessAvailable(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function'
}

export function directoryPickerAvailable(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
}

type SaveFilePicker = (opts?: { suggestedName?: string }) => Promise<FileSystemFileHandle>
type DirectoryPicker = (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>

/** Ask for a save location; must run inside a user gesture. Returns `null` when cancelled. */
export async function pickSaveFile(suggestedName: string): Promise<FileSystemFileHandle | null> {
  const picker = (window as unknown as { showSaveFilePicker: SaveFilePicker }).showSaveFilePicker
  try {
    return await picker({ suggestedName })
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') return null
    throw e
  }
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as unknown as { showDirectoryPicker: DirectoryPicker }).showDirectoryPicker
  try {
    return await picker({ mode: 'readwrite' })
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') return null
    throw e
  }
}

interface WritableLike {
  write(data: Uint8Array | { type: 'seek'; position: number }): Promise<void>
  seek(position: number): Promise<void>
  truncate(size: number): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

export class FileSystemSink implements Sink {
  readonly kind = 'fs'
  private writable: WritableLike | null = null
  readonly handle: FileSystemFileHandle
  readonly initialOffset: number
  private constructor(handle: FileSystemFileHandle, initialOffset: number) {
    this.handle = handle
    this.initialOffset = initialOffset
  }

  /**
   * Open the handle for writing from `offset`. `offset` must not exceed the current size of
   * the file (the caller reads it via `existingSize`).
   */
  static async open(handle: FileSystemFileHandle, offset: number): Promise<FileSystemSink> {
    const sink = new FileSystemSink(handle, offset)
    const w = (await (handle as unknown as { createWritable(o: { keepExistingData: boolean }): Promise<WritableLike> }).createWritable({
      keepExistingData: offset > 0,
    })) as WritableLike
    if (offset > 0) await w.seek(offset)
    sink.writable = w
    return sink
  }

  static async existingSize(handle: FileSystemFileHandle): Promise<number> {
    try {
      return (await handle.getFile()).size
    } catch {
      return 0
    }
  }

  static async ensurePermission(handle: FileSystemFileHandle): Promise<boolean> {
    const h = handle as unknown as { queryPermission?(o: { mode: string }): Promise<string>; requestPermission?(o: { mode: string }): Promise<string> }
    if ((await h.queryPermission?.({ mode: 'readwrite' })) === 'granted') return true
    return (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted'
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (!this.writable) throw new Error('sink closed')
    await this.writable.write(chunk)
  }

  async finish(): Promise<Blob | undefined> {
    const w = this.writable
    this.writable = null
    await w?.close()
    return undefined
  }

  async abort(): Promise<void> {
    // Closing (rather than aborting) keeps what was written so a later session can resume.
    const w = this.writable
    this.writable = null
    try {
      await w?.close()
    } catch {
      /* ignore */
    }
  }
}

export class BlobSink implements Sink {
  readonly kind: 'memory' | 'blob'
  readonly initialOffset = 0
  private parts: Uint8Array[] = []
  private readonly name: string
  private readonly mime: string
  private readonly download: boolean
  constructor(name: string, mime: string, download: boolean) {
    this.name = name
    this.mime = mime
    this.download = download
    this.kind = download ? 'memory' : 'blob'
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.parts.push(chunk.slice())
  }

  async finish(): Promise<Blob | undefined> {
    const blob = new Blob(this.parts as BlobPart[], { type: this.mime })
    this.parts = []
    if (this.download) triggerDownload(blob, this.name)
    return blob
  }

  async abort(): Promise<void> {
    this.parts = []
  }
}

export function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    a.remove()
    URL.revokeObjectURL(url)
  }, 10_000)
}

export function guessMime(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    txt: 'text/plain',
    zip: 'application/zip',
    json: 'application/json',
  }
  return map[ext] ?? 'application/octet-stream'
}
