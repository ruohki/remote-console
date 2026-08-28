/**
 * On-the-fly chunk compression for transfers in both directions and of every kind (files,
 * clipboard images, clipboard file lists).
 *
 * Each 64 KiB chunk is DEFLATE-compressed on its own (raw stream, no zlib wrapper) so acks and
 * resume keep counting uncompressed bytes. The work runs in a Web Worker (`codec.worker.ts`) so
 * the viewer's video and input stay smooth; where workers are unavailable (tests) the same code
 * runs inline. A `CompressionGate` stops trying after a run of chunks that did not shrink and
 * merely probes now and then, so already-compressed files cost almost no CPU.
 */

import { deflateSync, inflateSync } from 'fflate'
import { MAX_CHUNK_BYTES } from './chunk'
import type { CodecRequest, CodecResponse } from './codec.worker'

/** fflate level 0–9; 1–2 keep compression far faster than any data channel. */
export const DEFLATE_LEVEL = 2
/** Chunks smaller than this are never compressed. */
const MIN_COMPRESS_BYTES = 128
const BACKOFF_AFTER = 4
const PROBE_EVERY = 16

/** A compressed chunk replaces the raw one only when it is at least 1/16 smaller. */
export function worthIt(raw: number, compressed: number): boolean {
  return compressed * 16 < raw * 15
}

/** Compress one chunk inline. `null` when it does not pay off. */
export function deflateChunk(raw: Uint8Array): Uint8Array | null {
  if (raw.byteLength < MIN_COMPRESS_BYTES) return null
  const out = deflateSync(raw, { level: DEFLATE_LEVEL })
  return worthIt(raw.byteLength, out.byteLength) ? out : null
}

/**
 * Decompress one chunk inline, refusing outputs above `limit` (never more than a chunk) so a
 * hostile frame cannot make us allocate unboundedly. fflate writes into the given buffer and
 * silently truncates, so one spare byte tells us the stream was too large.
 */
export function inflateChunk(data: Uint8Array, limit: number): Uint8Array {
  const max = Math.min(limit, MAX_CHUNK_BYTES)
  const out = inflateSync(data, { out: new Uint8Array(max + 1) })
  if (out.byteLength > max) throw new Error(`chunk inflates beyond ${max} bytes`)
  return out
}

/** Decides per chunk whether compressing is worth a try (mirrors the agent's gate). */
export class CompressionGate {
  private misses: number
  private sinceProbe = 0
  constructor(hintIncompressible = false) {
    this.misses = hintIncompressible ? BACKOFF_AFTER : 0
  }
  shouldTry(): boolean {
    if (this.misses < BACKOFF_AFTER) return true
    this.sinceProbe += 1
    if (this.sinceProbe >= PROBE_EVERY) {
      this.sinceProbe = 0
      return true
    }
    return false
  }
  record(compressed: boolean) {
    if (compressed) {
      this.misses = 0
      this.sinceProbe = 0
    } else this.misses += 1
  }
  get backedOff() {
    return this.misses >= BACKOFF_AFTER
  }
}

const INCOMPRESSIBLE_EXT = new Set([
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'lz4', 'br',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif',
  'mp4', 'm4v', 'mkv', 'mov', 'avi', 'webm', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac',
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'apk', 'jar', 'war', 'ipa', 'dmg', 'pkg',
  'woff', 'woff2', 'pdf', 'epub', 'crx', 'xpi',
])

/** Extension-based starting hint; the gate's probes correct it when wrong. */
export function likelyIncompressible(name: string): boolean {
  const i = name.lastIndexOf('.')
  if (i <= 0) return false
  return INCOMPRESSIBLE_EXT.has(name.slice(i + 1).toLowerCase())
}

/** Compress / decompress chunks asynchronously (off the main thread when a worker is available). */
export interface ChunkCodec {
  deflate(raw: Uint8Array): Promise<Uint8Array | null>
  inflate(data: Uint8Array, limit: number): Promise<Uint8Array>
}

class InlineCodec implements ChunkCodec {
  async deflate(raw: Uint8Array) {
    return deflateChunk(raw)
  }
  async inflate(data: Uint8Array, limit: number) {
    return inflateChunk(data, limit)
  }
}

class WorkerCodec implements ChunkCodec {
  private worker: Worker
  private nextId = 1
  private pending = new Map<number, { resolve: (v: Uint8Array | null) => void; reject: (e: Error) => void }>()
  constructor(worker: Worker) {
    this.worker = worker
    worker.onmessage = (ev: MessageEvent<CodecResponse>) => {
      const p = this.pending.get(ev.data.id)
      if (!p) return
      this.pending.delete(ev.data.id)
      if (ev.data.error !== undefined) p.reject(new Error(ev.data.error))
      else p.resolve(ev.data.data)
    }
    worker.onerror = (ev) => {
      const err = new Error(`codec worker failed: ${ev.message}`)
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    }
  }
  private call(req: Omit<CodecRequest, 'id'>): Promise<Uint8Array | null> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      // Inputs are cloned (≤ 64 KiB, cheap) so callers keep their buffers; results come back transferred.
      this.worker.postMessage({ id, ...req } satisfies CodecRequest)
    })
  }
  deflate(raw: Uint8Array) {
    return this.call({ op: 'deflate', data: raw, level: DEFLATE_LEVEL })
  }
  async inflate(data: Uint8Array, limit: number) {
    const out = await this.call({ op: 'inflate', data, limit: Math.min(limit, MAX_CHUNK_BYTES) })
    return out ?? new Uint8Array(0)
  }
}

let shared: ChunkCodec | null = null

/** The process-wide codec: a worker when the platform has one, inline otherwise. */
export function chunkCodec(): ChunkCodec {
  if (shared) return shared
  try {
    if (typeof Worker !== 'undefined' && typeof import.meta.url === 'string' && !import.meta.env?.TEST) {
      shared = new WorkerCodec(new Worker(new URL('./codec.worker.ts', import.meta.url), { type: 'module' }))
      return shared
    }
  } catch {
    /* fall through */
  }
  shared = new InlineCodec()
  return shared
}

/** Test hook: force a specific codec implementation. */
export function setChunkCodecForTests(c: ChunkCodec | null) {
  shared = c
}
