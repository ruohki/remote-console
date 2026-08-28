/**
 * Transfer state machine for the `files` data channel — the browser side of
 * `protocol::files` (see the module docs in the agent repo for the wire contract).
 *
 * Responsibilities: queueing, offering/accepting, chunk pumping with backpressure,
 * incremental hashing, acks and the 15 s ack watchdog, resume across sessions (same token
 * → the agent tells us its offset) and across reloads (IndexedDB records), the remote file
 * browser calls and the rich clipboard flows. It never touches React; the UI subscribes to
 * snapshots through `subscribe()`.
 */

import type { ChunkCodec, FileEntry, FileMessage, TransferDirection, TransferKind } from '@/protocol'
import { ACK_INTERVAL_BYTES, BUFFERED_HIGH_WATER, MAX_CHUNK_BYTES, decodeChunk, encodeChunk, encodeChunkV2, nextOddId, type Chunk } from './chunk'
import type { FilesChannel } from './channel'
import { CompressionGate, chunkCodec, likelyIncompressible } from './codec'
import { Sha256 } from './sha256'
import { downloadKey, newToken, resumeStore, uploadKey } from './resume'
import type { Sink } from './sinks'

export type TransferStatus = 'queued' | 'offered' | 'transferring' | 'paused' | 'verifying' | 'done' | 'failed' | 'cancelled'

export interface Transfer {
  /** Stable key for the UI (the token). */
  key: string
  token: string
  /** Wire id in the current session (0 until offered/requested). */
  transferId: number
  name: string
  size: number
  kind: TransferKind
  direction: TransferDirection
  status: TransferStatus
  /** Bytes present at the receiver (includes what a previous session already moved). */
  bytes: number
  /** Where this session resumed from. */
  startOffset: number
  speedBps: number
  etaS: number | null
  error?: string
  /** Device path: destination (uploads) or source (downloads). */
  path?: string
  group?: string
  startedAt: number
  finishedAt?: number
  /** Whether this transfer can be resumed with the current in-memory state. */
  resumable: boolean
  /** Chunk codec negotiated with the device for this transfer (`null`: raw only — old agent or compression off). */
  codec: ChunkCodec | null
  /** Uncompressed bytes moved across the channel by this browser (all sessions of this transfer). */
  payloadBytes: number
  /** Bytes that actually went over the wire for those (smaller than `payloadBytes` when compression helped). */
  wireBytes: number
}

export interface SinkFactory {
  /** `resume` = true when continuing into a file that already holds part of the data. */
  (resume: boolean): Promise<Sink>
}

export interface ManagerCallbacks {
  onListing?: (msg: Extract<FileMessage, { t: 'listing' }>) => void
  onOpResult?: (msg: Extract<FileMessage, { t: 'op_result' }>) => void
  onClipboardImage?: (png: Blob, name: string) => void
  onClipboardFilesDone?: (names: string[]) => void
  onTransferFinished?: (t: Transfer) => void
  onNotice?: (kind: 'info' | 'error', title: string, detail?: string) => void
}

const MAX_ACTIVE = 3
const ACK_WATCHDOG_MS = 15_000
const EMIT_THROTTLE_MS = 100
const SPEED_WINDOW_MS = 3000

interface Upload {
  t: Transfer
  file: File
  destDir?: string
  hasher: Sha256
  hashedUpTo: number
  pos: number
  acked: number
  lastAckAt: number
  pumping: boolean
  /** Cached once computed: `complete` may have to be re-sent after a rewind. */
  digest?: string
  resolveGroup?: () => void
  /** The device advertised DEFLATE in `accept` and compression is enabled. */
  deflate: boolean
  gate: CompressionGate
}

interface Download {
  t: Transfer
  remotePath?: string
  sinkFactory: SinkFactory
  sink: Sink | null
  hasher: Sha256
  expected: number
  lastAckSent: number
  /** clipboard receives are matched by kind rather than by request id */
  clipboard?: 'image' | 'files'
  onBlob?: (blob: Blob) => void
}

interface PendingRequest {
  transferId: number
  name: string
  remotePath: string
  size: number
  sinkFactory: SinkFactory
  resumeKey?: string
}

interface ClipboardExpectation {
  kind: 'image' | 'files'
  names: string[]
  sinkFor: (name: string) => Promise<Sink>
  onImage?: (png: Blob) => void
  received: string[]
  expectedCount: number
}

const num = (v: number | bigint) => Number(v)
const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

export class TransferManager {
  private channel: FilesChannel | null = null
  private unsubChannel: (() => void)[] = []
  private uploads = new Map<string, Upload>() // by token
  private downloads = new Map<string, Download>() // by token
  private byWireId = new Map<number, { dir: 'up' | 'down'; token: string }>()
  private pendingRequests: PendingRequest[] = []
  private clipboardExpect: ClipboardExpectation | null = null
  private order: string[] = [] // tokens in creation order for the UI
  private lastId = -1 // next odd id = 1
  private listeners = new Set<(ts: Transfer[]) => void>()
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private watchdog: ReturnType<typeof setInterval> | null = null
  private speedSamples = new Map<string, { at: number; bytes: number }[]>()
  callbacks: ManagerCallbacks = {}
  deviceId = ''
  /** Default destination folder for `file` uploads that don't name one; undefined = the
   *  agent's configured transfer directory. Set by the UI's destination picker. */
  defaultDestDir: string | undefined = undefined
  /** Offer/accept DEFLATE chunks (applies to files and clipboard content, both directions). */
  compression = true

  setDefaultDestDir(dir: string | undefined) {
    this.defaultDestDir = dir && dir.trim() ? dir : undefined
  }

  /** Takes effect for transfers negotiated from now on. */
  setCompression(on: boolean) {
    this.compression = on
  }

  /* ───────────── lifecycle ───────────── */

  attach(channel: FilesChannel) {
    this.detach()
    this.channel = channel
    this.unsubChannel.push(channel.onMessage((m) => this.onMessage(m)))
    this.unsubChannel.push(channel.onClose(() => this.detach()))
    this.watchdog = setInterval(() => this.tick(), 1000)
    // Continue whatever the previous session left unfinished.
    for (const u of this.uploads.values()) {
      if (u.t.status === 'paused') {
        u.t.status = 'queued'
        u.t.transferId = 0
      }
    }
    for (const d of this.downloads.values()) {
      if (d.t.status === 'paused' && d.remotePath) {
        d.t.status = 'queued'
        this.pendingRequests.push({ transferId: 0, name: d.t.name, remotePath: d.remotePath, size: d.t.size, sinkFactory: d.sinkFactory, resumeKey: downloadKey(this.deviceId, d.remotePath, d.t.size) })
        this.downloads.delete(d.t.token)
        this.order = this.order.filter((k) => k !== d.t.token)
      }
    }
    this.schedule()
    this.emit()
  }

  detach() {
    if (!this.channel) return
    for (const off of this.unsubChannel) off()
    this.unsubChannel = []
    this.channel = null
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    this.byWireId.clear()
    for (const u of this.uploads.values()) {
      if (!isTerminal(u.t.status)) {
        u.t.status = 'paused'
        u.pumping = false
        u.t.speedBps = 0
      }
    }
    for (const d of this.downloads.values()) {
      if (!isTerminal(d.t.status)) {
        d.t.status = 'paused'
        d.t.speedBps = 0
        void d.sink?.abort()
        d.sink = null
      }
    }
    for (const p of this.pendingRequests) {
      // keep them queued; they are re-requested on attach
      p.transferId = 0
    }
    this.emit()
  }

  get connected() {
    return !!this.channel?.open
  }

  subscribe(l: (ts: Transfer[]) => void): () => void {
    this.listeners.add(l)
    l(this.snapshot())
    return () => this.listeners.delete(l)
  }

  snapshot(): Transfer[] {
    return this.order.map((k) => this.uploads.get(k)?.t ?? this.downloads.get(k)?.t).filter((t): t is Transfer => !!t).map((t) => ({ ...t }))
  }

  /** Drop finished/failed entries from the list. */
  clearFinished() {
    for (const k of [...this.order]) {
      const t = this.uploads.get(k)?.t ?? this.downloads.get(k)?.t
      if (t && isTerminal(t.status)) this.remove(k)
    }
    this.emit()
  }

  /** Drop one finished/failed entry from the list (active ones must be cancelled first). */
  remove(token: string) {
    const t = this.uploads.get(token)?.t ?? this.downloads.get(token)?.t
    if (!t || !isTerminal(t.status)) return
    this.uploads.delete(token)
    this.downloads.delete(token)
    this.speedSamples.delete(token)
    this.order = this.order.filter((x) => x !== token)
    this.emit()
  }

  /** Cancel everything that is still moving or waiting. */
  cancelAll(reason = 'cancelled by operator') {
    for (const t of this.snapshot()) if (!isTerminal(t.status)) this.cancel(t.token, reason)
    for (const p of [...this.pendingRequests]) this.cancel(p.remotePath, reason)
  }

  /** Re-offer every failed/cancelled transfer that can be resumed. */
  retryFailed() {
    for (const t of this.snapshot()) if ((t.status === 'failed' || t.status === 'cancelled') && t.resumable) this.retry(t.token)
  }

  /* ───────────── uploads ───────────── */

  async upload(file: File, opts: { destDir?: string; kind?: TransferKind; group?: string; token?: string } = {}): Promise<string> {
    const kind = opts.kind ?? 'file'
    // Regular files honour the operator's chosen destination when the caller didn't pin one.
    const destDir = opts.destDir ?? (kind === 'file' ? this.defaultDestDir : undefined)
    opts = { ...opts, destDir }
    let token = opts.token
    const key = uploadKey(this.deviceId, file)
    if (!token && kind === 'file') {
      const rec = await resumeStore.getUpload(key)
      if (rec && rec.name === file.name && rec.size === file.size && rec.lastModified === file.lastModified) token = rec.token
    }
    if (!token) token = newToken()
    if (kind === 'file') {
      void resumeStore.putUpload({ key, deviceId: this.deviceId, token, name: file.name, size: file.size, lastModified: file.lastModified, destDir: opts.destDir, updatedAt: Date.now() })
    }
    const existing = this.uploads.get(token)
    if (existing && !isTerminal(existing.t.status)) return token
    const t: Transfer = {
      key: token,
      token,
      transferId: 0,
      name: file.name || 'file',
      size: file.size,
      kind,
      direction: 'to_device',
      status: 'queued',
      bytes: 0,
      startOffset: 0,
      speedBps: 0,
      etaS: null,
      path: opts.destDir,
      group: opts.group,
      startedAt: Date.now(),
      resumable: true,
      codec: null,
      payloadBytes: 0,
      wireBytes: 0,
    }
    this.uploads.set(token, { t, file, destDir: opts.destDir, hasher: new Sha256(), hashedUpTo: 0, pos: 0, acked: 0, lastAckAt: Date.now(), pumping: false, deflate: false, gate: new CompressionGate() })
    if (!this.order.includes(token)) this.order.push(token)
    this.schedule()
    this.emit()
    return token
  }

  /** Re-offer a paused/failed upload (same token → the agent resumes). */
  retry(token: string) {
    const u = this.uploads.get(token)
    if (u) {
      u.t.status = 'queued'
      u.t.error = undefined
      u.t.transferId = 0
      u.pumping = false
      this.schedule()
      this.emit()
      return
    }
    const d = this.downloads.get(token)
    if (d && d.remotePath) {
      this.downloads.delete(token)
      this.order = this.order.filter((k) => k !== token)
      void this.download(d.remotePath, d.t.name, d.t.size, d.sinkFactory)
    }
  }

  cancel(token: string, reason = 'cancelled by operator') {
    const u = this.uploads.get(token)
    if (u) {
      if (!isTerminal(u.t.status)) {
        if (u.t.transferId) this.send({ t: 'cancel', transfer_id: u.t.transferId, reason })
        u.t.status = 'cancelled'
        u.t.finishedAt = Date.now()
        u.pumping = false
        this.byWireId.delete(u.t.transferId)
      }
      this.schedule()
      this.emit()
      return
    }
    const d = this.downloads.get(token)
    if (d) {
      if (!isTerminal(d.t.status)) {
        if (d.t.transferId) this.send({ t: 'cancel', transfer_id: d.t.transferId, reason })
        d.t.status = 'cancelled'
        d.t.finishedAt = Date.now()
        void d.sink?.abort()
        d.sink = null
        this.byWireId.delete(d.t.transferId)
      }
      this.schedule()
      this.emit()
      return
    }
    this.pendingRequests = this.pendingRequests.filter((p) => p.remotePath !== token)
    this.emit()
  }

  /* ───────────── downloads & browsing ───────────── */

  /** Ask the device for `remotePath`; `sinkFactory` was prepared inside the user gesture. */
  async download(remotePath: string, name: string, size: number, sinkFactory: SinkFactory): Promise<void> {
    const resumeKey = downloadKey(this.deviceId, remotePath, size)
    this.pendingRequests.push({ transferId: 0, name: basename(name), remotePath, size, sinkFactory, resumeKey })
    this.schedule()
    this.emit()
  }

  list(path?: string) {
    this.send(path ? { t: 'list', path } : { t: 'list' })
  }

  mkdir(path: string) {
    this.send({ t: 'mkdir', path })
  }

  delete(path: string) {
    this.send({ t: 'delete', path })
  }

  rename(from: string, to: string) {
    this.send({ t: 'rename', from, to })
  }

  /* ───────────── clipboard ───────────── */

  async sendClipboardImage(png: Blob, name: string): Promise<string> {
    const file = new File([png], name, { type: 'image/png' })
    return this.upload(file, { kind: 'clipboard_image' })
  }

  /** Upload `files` as one clipboard group and tell the agent when the whole group landed. */
  async sendClipboardFiles(files: File[]): Promise<string[]> {
    const group = newToken()
    const tokens: string[] = []
    let remaining = files.length
    for (const f of files) {
      const token = await this.upload(f, { kind: 'clipboard_files', group })
      tokens.push(token)
      const u = this.uploads.get(token)
      if (u) {
        u.resolveGroup = () => {
          remaining -= 1
          if (remaining === 0) this.send({ t: 'clipboard_group_complete', group })
        }
      }
    }
    return tokens
  }

  /** Pull the device clipboard (image or file list) announced via `clipboard_available`. */
  requestClipboard(kind: 'image' | 'files', names: string[], sinkFor: (name: string) => Promise<Sink>, onImage?: (png: Blob) => void) {
    this.clipboardExpect = { kind, names, sinkFor, onImage, received: [], expectedCount: kind === 'image' ? 1 : Math.max(1, names.length) }
    this.send({ t: 'request_clipboard' })
  }

  /* ───────────── wire ───────────── */

  private send(msg: FileMessage): boolean {
    return this.channel?.sendText(msg) ?? false
  }

  private onMessage(m: FileMessage | ArrayBuffer) {
    if (m instanceof ArrayBuffer) {
      this.onChunk(m)
      return
    }
    switch (m.t) {
      case 'offer':
        void this.onOffer(m)
        break
      case 'accept':
        void this.onAccept(m.transfer_id, num(m.offset), m.codecs ?? [])
        break
      case 'reject':
        this.failWire(m.transfer_id, m.reason)
        break
      case 'ack':
        this.onAck(m.transfer_id, num(m.offset))
        break
      case 'complete':
        void this.onComplete(m.transfer_id, m.sha256)
        break
      case 'done':
        this.onDone(m.transfer_id, m.ok, m.error, m.path)
        break
      case 'cancel':
        this.failWire(m.transfer_id, `cancelled by the device: ${m.reason}`, 'cancelled')
        break
      case 'listing':
        this.callbacks.onListing?.(m)
        break
      case 'op_result':
        this.callbacks.onOpResult?.(m)
        break
      default:
        break
    }
  }

  /* ── sending side ── */

  private schedule() {
    if (!this.channel?.open) return
    let active = 0
    for (const u of this.uploads.values()) if (u.t.status === 'offered' || u.t.status === 'transferring' || u.t.status === 'verifying') active++
    for (const d of this.downloads.values()) if (d.t.status === 'offered' || d.t.status === 'transferring' || d.t.status === 'verifying') active++
    active += this.pendingRequests.filter((p) => p.transferId !== 0).length

    for (const p of this.pendingRequests) {
      if (active >= MAX_ACTIVE) break
      if (p.transferId !== 0) continue
      p.transferId = this.nextId()
      this.send({ t: 'request', transfer_id: p.transferId, path: p.remotePath })
      active++
    }
    for (const u of this.uploads.values()) {
      if (active >= MAX_ACTIVE) break
      if (u.t.status !== 'queued') continue
      u.t.transferId = this.nextId()
      u.t.status = 'offered'
      u.pos = 0
      u.acked = 0
      u.hasher = new Sha256()
      u.hashedUpTo = 0
      u.digest = undefined
      u.lastAckAt = Date.now()
      this.byWireId.set(u.t.transferId, { dir: 'up', token: u.t.token })
      const offer: FileMessage = {
        t: 'offer',
        transfer_id: u.t.transferId,
        token: u.t.token,
        name: u.t.name,
        size: BigInt(u.t.size),
        kind: u.t.kind,
        direction: 'to_device',
        ...(u.destDir ? { dest_dir: u.destDir } : {}),
        ...(u.t.group ? { group: u.t.group } : {}),
      }
      if (!this.send(offer)) {
        u.t.status = 'paused'
        break
      }
      active++
    }
  }

  private nextId(): number {
    this.lastId = nextOddId(this.lastId)
    return this.lastId
  }

  private async onAccept(id: number, offset: number, codecs: ChunkCodec[]) {
    const ref = this.byWireId.get(id)
    if (!ref || ref.dir !== 'up') return
    const u = this.uploads.get(ref.token)
    if (!u || u.t.status !== 'offered') return
    if (offset > u.t.size) {
      this.failUpload(u, 'device reported more bytes than the file has')
      return
    }
    u.t.status = 'transferring'
    u.t.startOffset = offset
    u.t.bytes = offset
    u.pos = offset
    u.acked = offset
    u.lastAckAt = Date.now()
    u.deflate = this.compression && codecs.includes('deflate')
    u.t.codec = u.deflate ? 'deflate' : null
    u.gate = new CompressionGate(likelyIncompressible(u.t.name))
    this.emit()
    void this.pump(u)
  }

  /** Wire frame for one chunk: compressed v2 when negotiated and worthwhile, else raw. */
  private async frameFor(u: Upload, offset: number, payload: Uint8Array): Promise<ArrayBuffer> {
    if (!u.deflate) return encodeChunk(u.t.transferId, offset, payload)
    let packed: Uint8Array | null = null
    if (u.gate.shouldTry()) {
      packed = await chunkCodec().deflate(payload)
      u.gate.record(packed !== null)
    }
    return packed ? encodeChunkV2(u.t.transferId, offset, 'deflate', packed) : encodeChunkV2(u.t.transferId, offset, 'raw', payload)
  }

  private async pump(u: Upload) {
    if (u.pumping) return
    u.pumping = true
    const ch = this.channel
    try {
      while (u.t.status === 'transferring' && this.channel === ch && ch?.open) {
        // The digest must cover the whole file, including bytes the device already had.
        if (u.hashedUpTo < u.pos) {
          const buf = new Uint8Array(await u.file.slice(u.hashedUpTo, u.pos).arrayBuffer())
          u.hasher.update(buf)
          u.hashedUpTo = u.pos
          continue
        }
        if (u.pos >= u.t.size) {
          u.t.status = 'verifying'
          u.t.bytes = u.t.size
          u.digest ??= u.hasher.digestHex()
          this.send({ t: 'complete', transfer_id: u.t.transferId, sha256: u.digest })
          this.emit()
          break
        }
        if (ch.bufferedAmount > BUFFERED_HIGH_WATER) {
          await ch.waitForDrain()
          continue
        }
        const start = u.pos
        const end = Math.min(u.t.size, start + MAX_CHUNK_BYTES)
        const payload = new Uint8Array(await u.file.slice(start, end).arrayBuffer())
        if (u.t.status !== 'transferring' || this.channel !== ch || u.pos !== start) break
        if (payload.byteLength === 0) {
          this.failUpload(u, 'the file changed on disk while uploading')
          break
        }
        const frame = await this.frameFor(u, start, payload)
        // A rewind or cancel may have happened while compressing.
        if (u.t.status !== 'transferring' || this.channel !== ch || u.pos !== start) break
        if (!ch.sendBinary(frame)) break
        if (start === u.hashedUpTo) {
          u.hasher.update(payload)
          u.hashedUpTo = end
        }
        u.pos = end
        u.t.bytes = u.pos
        u.t.payloadBytes += payload.byteLength
        u.t.wireBytes += frame.byteLength
        this.progress(u.t, u.pos)
      }
    } catch (e) {
      this.failUpload(u, `read error: ${(e as Error).message}`)
    } finally {
      u.pumping = false
    }
  }

  private onAck(id: number, offset: number) {
    const ref = this.byWireId.get(id)
    if (!ref || ref.dir !== 'up') return
    const u = this.uploads.get(ref.token)
    if (!u) return
    u.acked = Math.max(u.acked, offset)
    u.lastAckAt = Date.now()
    u.t.bytes = Math.max(u.t.bytes, u.acked)
    this.emit()
  }

  private onDone(id: number, ok: boolean, error?: string, path?: string) {
    const ref = this.byWireId.get(id)
    if (!ref || ref.dir !== 'up') return
    const u = this.uploads.get(ref.token)
    if (!u) return
    this.byWireId.delete(id)
    if (ok) {
      u.t.status = 'done'
      u.t.bytes = u.t.size
      u.t.path = path ?? u.t.path
      u.t.finishedAt = Date.now()
      u.t.speedBps = 0
      u.t.etaS = null
      if (u.t.kind === 'file') void resumeStore.deleteUpload(uploadKey(this.deviceId, u.file))
      u.resolveGroup?.()
      this.callbacks.onTransferFinished?.(u.t)
    } else {
      this.failUpload(u, error ?? 'the device rejected the file')
    }
    this.schedule()
    this.emit()
  }

  private failUpload(u: Upload, reason: string, status: TransferStatus = 'failed') {
    u.t.status = status
    u.t.error = reason
    u.t.finishedAt = Date.now()
    u.t.speedBps = 0
    u.pumping = false
    this.byWireId.delete(u.t.transferId)
    this.callbacks.onTransferFinished?.(u.t)
    this.schedule()
    this.emit()
  }

  private failWire(id: number, reason: string, status: TransferStatus = 'failed') {
    const ref = this.byWireId.get(id)
    if (!ref) {
      const p = this.pendingRequests.find((x) => x.transferId === id)
      if (p) {
        this.pendingRequests = this.pendingRequests.filter((x) => x !== p)
        this.callbacks.onNotice?.('error', `Could not fetch ${p.name}`, reason)
        this.schedule()
      }
      return
    }
    if (ref.dir === 'up') {
      const u = this.uploads.get(ref.token)
      if (u) this.failUpload(u, reason, status)
    } else {
      const d = this.downloads.get(ref.token)
      if (d) this.failDownload(d, reason, status)
    }
  }

  /* ── receiving side ── */

  private async onOffer(m: Extract<FileMessage, { t: 'offer' }>) {
    const size = num(m.size)
    let sinkFactory: SinkFactory
    let remotePath: string | undefined
    let clipboard: Download['clipboard']
    let onBlob: Download['onBlob']
    let resumeKey: string | undefined

    if (m.kind === 'clipboard_image' || m.kind === 'clipboard_files') {
      const exp = this.clipboardExpect
      if (!exp) {
        this.send({ t: 'reject', transfer_id: m.transfer_id, reason: 'no clipboard request pending' })
        return
      }
      clipboard = exp.kind
      sinkFactory = () => exp.sinkFor(m.name)
      if (exp.kind === 'image') onBlob = exp.onImage
      exp.received.push(m.name)
      if (exp.received.length >= exp.expectedCount) this.clipboardExpect = null
    } else {
      // A download we asked for: prefer an echoed id, else the oldest request with that name.
      let idx = this.pendingRequests.findIndex((p) => p.transferId === m.transfer_id)
      if (idx < 0) idx = this.pendingRequests.findIndex((p) => p.name === basename(m.name) && p.transferId !== 0)
      if (idx < 0) idx = this.pendingRequests.findIndex((p) => p.name === basename(m.name))
      if (idx < 0) {
        this.send({ t: 'reject', transfer_id: m.transfer_id, reason: 'unsolicited transfer' })
        return
      }
      const [p] = this.pendingRequests.splice(idx, 1)
      sinkFactory = p!.sinkFactory
      remotePath = p!.remotePath
      resumeKey = p!.resumeKey
    }

    const t: Transfer = {
      key: m.token,
      token: m.token,
      transferId: m.transfer_id,
      name: m.name,
      size,
      kind: m.kind,
      direction: 'to_operator',
      status: 'offered',
      bytes: 0,
      startOffset: 0,
      speedBps: 0,
      etaS: null,
      path: remotePath,
      group: m.group,
      startedAt: Date.now(),
      resumable: !!remotePath,
      codec: this.compression ? 'deflate' : null,
      payloadBytes: 0,
      wireBytes: 0,
    }
    const d: Download = { t, remotePath, sinkFactory, sink: null, hasher: new Sha256(), expected: 0, lastAckSent: 0, clipboard, onBlob }
    this.downloads.set(m.token, d)
    this.byWireId.set(m.transfer_id, { dir: 'down', token: m.token })
    if (!this.order.includes(m.token)) this.order.push(m.token)
    this.emit()

    try {
      const rec = resumeKey ? await resumeStore.getDownload(resumeKey) : undefined
      const sink = await sinkFactory(!!rec && rec.bytesWritten > 0)
      let offset = Math.min(sink.initialOffset, size)
      if (offset > 0) {
        // Hash what is already on disk so the final digest covers the whole file.
        const existing = await this.readExisting(sink, offset)
        if (existing) d.hasher.update(existing)
        else offset = 0
      }
      d.sink = sink
      d.expected = offset
      d.lastAckSent = offset
      t.startOffset = offset
      t.bytes = offset
      t.status = 'transferring'
      if (resumeKey && remotePath && sink.kind === 'fs') {
        void resumeStore.putDownload({ key: resumeKey, deviceId: this.deviceId, remotePath, name: t.name, size, bytesWritten: offset, handle: (sink as { handle?: FileSystemFileHandle }).handle, updatedAt: Date.now() })
      }
      this.send({ t: 'accept', transfer_id: m.transfer_id, offset: BigInt(offset), ...(this.compression ? { codecs: ['deflate' as const] } : {}) })
      this.emit()
    } catch (e) {
      this.send({ t: 'reject', transfer_id: m.transfer_id, reason: (e as Error).message })
      this.failDownload(d, `could not open the destination: ${(e as Error).message}`)
    }
  }

  private async readExisting(sink: Sink, upTo: number): Promise<Uint8Array | null> {
    const handle = (sink as { handle?: FileSystemFileHandle }).handle
    if (!handle) return null
    try {
      const file = await handle.getFile()
      if (file.size < upTo) return null
      return new Uint8Array(await file.slice(0, upTo).arrayBuffer())
    } catch {
      return null
    }
  }

  private chunkQueue = Promise.resolve()

  private onChunk(frame: ArrayBuffer) {
    const c = decodeChunk(frame)
    if (!c) return
    const ref = this.byWireId.get(c.transferId)
    if (!ref || ref.dir !== 'down') return
    const d = this.downloads.get(ref.token)
    if (!d) return
    // Writes are async; keep them strictly ordered.
    this.chunkQueue = this.chunkQueue.then(() => this.writeChunk(d, c)).catch(() => undefined)
  }

  private async writeChunk(d: Download, c: Chunk) {
    if (d.t.status !== 'transferring' || !d.sink) return
    const offset = c.offset
    if (offset > d.expected) {
      this.send({ t: 'cancel', transfer_id: d.t.transferId, reason: `gap at ${d.expected}` })
      this.failDownload(d, 'the stream had a gap; retry to resume')
      return
    }
    const wire = c.payload.byteLength
    let payload = c.payload
    if (c.codec === 'deflate') {
      try {
        payload = await chunkCodec().inflate(c.payload, Math.min(MAX_CHUNK_BYTES, d.t.size - offset))
      } catch (e) {
        this.send({ t: 'cancel', transfer_id: d.t.transferId, reason: `undecodable chunk at ${offset}` })
        this.failDownload(d, `could not decompress a chunk: ${(e as Error).message}`)
        return
      }
      if (d.t.status !== 'transferring' || !d.sink) return
    }
    if (offset + payload.byteLength <= d.expected) return // duplicate after a resend
    d.t.wireBytes += wire
    const fresh = offset < d.expected ? payload.subarray(d.expected - offset) : payload
    d.t.payloadBytes += fresh.byteLength
    if (d.expected + fresh.byteLength > d.t.size) {
      this.failDownload(d, 'received more bytes than announced')
      return
    }
    try {
      await d.sink.write(fresh)
    } catch (e) {
      this.send({ t: 'cancel', transfer_id: d.t.transferId, reason: 'write failed' })
      this.failDownload(d, `write failed: ${(e as Error).message}`)
      return
    }
    d.hasher.update(fresh)
    d.expected += fresh.byteLength
    d.t.bytes = d.expected
    if (d.expected - d.lastAckSent >= ACK_INTERVAL_BYTES || d.expected >= d.t.size) {
      d.lastAckSent = d.expected
      this.send({ t: 'ack', transfer_id: d.t.transferId, offset: BigInt(d.expected) })
      if (d.remotePath && d.sink.kind === 'fs') {
        void resumeStore.putDownload({ key: downloadKey(this.deviceId, d.remotePath, d.t.size), deviceId: this.deviceId, remotePath: d.remotePath, name: d.t.name, size: d.t.size, bytesWritten: d.expected, handle: (d.sink as { handle?: FileSystemFileHandle }).handle, updatedAt: Date.now() })
      }
    }
    this.progress(d.t, d.expected)
  }

  private async onComplete(id: number, sha256: string) {
    const ref = this.byWireId.get(id)
    if (!ref || ref.dir !== 'down') return
    const d = this.downloads.get(ref.token)
    if (!d) return
    await this.chunkQueue
    if (d.t.status !== 'transferring' || !d.sink) return
    d.t.status = 'verifying'
    this.emit()
    if (d.expected !== d.t.size) {
      this.send({ t: 'done', transfer_id: id, ok: false, error: `expected ${d.t.size} bytes, got ${d.expected}` })
      this.failDownload(d, 'the device finished early; retry to resume')
      return
    }
    const digest = d.hasher.digestHex()
    if (digest !== sha256.toLowerCase()) {
      this.send({ t: 'done', transfer_id: id, ok: false, error: 'sha256 mismatch' })
      await d.sink.abort()
      d.sink = null
      if (d.remotePath) void resumeStore.deleteDownload(downloadKey(this.deviceId, d.remotePath, d.t.size))
      this.failDownload(d, 'checksum mismatch — the file was corrupted in transit')
      return
    }
    try {
      const blob = await d.sink.finish()
      d.sink = null
      this.send({ t: 'done', transfer_id: id, ok: true })
      d.t.status = 'done'
      d.t.finishedAt = Date.now()
      d.t.speedBps = 0
      d.t.etaS = null
      this.byWireId.delete(id)
      if (d.remotePath) void resumeStore.deleteDownload(downloadKey(this.deviceId, d.remotePath, d.t.size))
      if (blob && d.clipboard === 'image') {
        d.onBlob?.(blob)
        this.callbacks.onClipboardImage?.(blob, d.t.name)
      }
      if (d.clipboard === 'files') this.noteClipboardFile(d.t.name)
      this.callbacks.onTransferFinished?.(d.t)
    } catch (e) {
      this.send({ t: 'done', transfer_id: id, ok: false, error: 'finalize failed' })
      this.failDownload(d, `could not finalize: ${(e as Error).message}`)
      return
    }
    this.schedule()
    this.emit()
  }

  private clipboardFilesDone: string[] = []
  private noteClipboardFile(name: string) {
    this.clipboardFilesDone.push(name)
    const stillRunning = [...this.downloads.values()].some((d) => d.clipboard === 'files' && !isTerminal(d.t.status))
    if (!stillRunning) {
      const names = this.clipboardFilesDone
      this.clipboardFilesDone = []
      this.callbacks.onClipboardFilesDone?.(names)
    }
  }

  private failDownload(d: Download, reason: string, status: TransferStatus = 'failed') {
    d.t.status = status
    d.t.error = reason
    d.t.finishedAt = Date.now()
    d.t.speedBps = 0
    void d.sink?.abort()
    d.sink = null
    this.byWireId.delete(d.t.transferId)
    this.callbacks.onTransferFinished?.(d.t)
    this.schedule()
    this.emit()
  }

  /* ───────────── housekeeping ───────────── */

  private tick() {
    const now = Date.now()
    for (const u of this.uploads.values()) {
      if (u.t.status !== 'transferring' && u.t.status !== 'verifying') continue
      if (u.pos > u.acked && now - u.lastAckAt > ACK_WATCHDOG_MS) {
        // No acknowledgement for a while: rewind to the last acked byte and re-send
        // (a `verifying` upload re-sends its `complete` afterwards).
        u.pos = u.acked
        u.t.status = 'transferring'
        u.lastAckAt = now
        this.callbacks.onNotice?.('info', `Retrying ${u.t.name}`, 'No acknowledgement from the device; resending from the last confirmed byte.')
        if (!u.pumping) void this.pump(u)
      }
    }
    this.emit()
  }

  private progress(t: Transfer, position: number) {
    const now = Date.now()
    const samples = this.speedSamples.get(t.key) ?? []
    samples.push({ at: now, bytes: position })
    while (samples.length > 2 && now - samples[0]!.at > SPEED_WINDOW_MS) samples.shift()
    this.speedSamples.set(t.key, samples)
    const first = samples[0]!
    const dt = (now - first.at) / 1000
    if (dt > 0.2) {
      t.speedBps = Math.max(0, (position - first.bytes) / dt)
      t.etaS = t.speedBps > 0 ? (t.size - position) / t.speedBps : null
    }
    this.emit()
  }

  private emit() {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      const snap = this.snapshot()
      for (const l of this.listeners) l(snap)
    }, EMIT_THROTTLE_MS)
  }
}

export function isTerminal(s: TransferStatus): boolean {
  return s === 'done' || s === 'failed' || s === 'cancelled'
}

export type { FileEntry }
