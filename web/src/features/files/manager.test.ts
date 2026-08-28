import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileMessage } from '@/protocol'
import type { FilesChannel } from './channel'
import { decodeChunk } from './chunk'
import { TransferManager, type Transfer } from './manager'
import type { Sink } from './sinks'
import { sha256Hex } from './sha256'

/** In-memory stand-in for the RTCDataChannel that records what the browser sends. */
class FakeChannel implements FilesChannel {
  open = true
  bufferedAmount = 0
  texts: FileMessage[] = []
  binaries: ArrayBuffer[] = []
  private listeners = new Set<(m: FileMessage | ArrayBuffer) => void>()
  private closers = new Set<() => void>()
  sendText(msg: FileMessage) {
    if (!this.open) return false
    this.texts.push(JSON.parse(JSON.stringify(msg, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))) as FileMessage)
    return true
  }
  sendBinary(frame: ArrayBuffer) {
    if (!this.open) return false
    this.binaries.push(frame)
    return true
  }
  waitForDrain() {
    return Promise.resolve()
  }
  onMessage(cb: (m: FileMessage | ArrayBuffer) => void) {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  onClose(cb: () => void) {
    this.closers.add(cb)
    return () => this.closers.delete(cb)
  }
  /** Deliver a message from the "agent". */
  recv(m: FileMessage | ArrayBuffer) {
    for (const l of this.listeners) l(m)
  }
  close() {
    this.open = false
    for (const c of this.closers) c()
  }
  lastText<T extends FileMessage['t']>(t: T): Extract<FileMessage, { t: T }> | undefined {
    return [...this.texts].reverse().find((m) => m.t === t) as Extract<FileMessage, { t: T }> | undefined
  }
}

class MemSink implements Sink {
  readonly kind = 'blob' as const
  parts: Uint8Array[] = []
  readonly initialOffset: number
  constructor(initialOffset = 0) {
    this.initialOffset = initialOffset
  }
  async write(chunk: Uint8Array) {
    this.parts.push(chunk.slice())
  }
  async finish() {
    return new Blob(this.parts as BlobPart[])
  }
  async abort() {}
  bytes() {
    const n = this.parts.reduce((a, p) => a + p.byteLength, 0)
    const out = new Uint8Array(n)
    let o = 0
    for (const p of this.parts) {
      out.set(p, o)
      o += p.byteLength
    }
    return out
  }
}

function makeData(n: number) {
  const d = new Uint8Array(n)
  for (let i = 0; i < n; i++) d[i] = (i * 31 + 7) & 0xff
  return d
}
const hex = (d: Uint8Array) => sha256Hex(d)
const flush = () => new Promise((r) => setTimeout(r, 0))
async function settle(times = 20) {
  for (let i = 0; i < times; i++) await flush()
}

// jsdom's File.slice().arrayBuffer() works; IndexedDB is absent so resume records are no-ops.

describe('TransferManager uploads', () => {
  let ch: FakeChannel
  let mgr: TransferManager
  let latest: Transfer[] = []
  beforeEach(() => {
    ch = new FakeChannel()
    mgr = new TransferManager()
    mgr.deviceId = 'dev_test'
    mgr.subscribe((t) => (latest = t))
    mgr.attach(ch)
  })
  it('publishes throttled snapshots to subscribers', async () => {
    await mgr.upload(new File([makeData(10)], 's.bin'))
    await new Promise((r) => setTimeout(r, 150))
    expect(latest.map((t) => t.name)).toEqual(['s.bin'])
  })
  afterEach(() => mgr.detach())

  it('offers, streams from the accepted offset, hashes the whole file and completes', async () => {
    const data = makeData(150_000)
    const file = new File([data], 'a.bin')
    const token = await mgr.upload(file, { destDir: '/tmp/x' })
    await settle()
    const offer = ch.lastText('offer')!
    expect(offer.transfer_id % 2).toBe(1)
    expect(offer.token).toBe(token)
    expect(offer.name).toBe('a.bin')
    expect(Number(offer.size)).toBe(150_000)
    expect(offer.direction).toBe('to_device')
    expect(offer.dest_dir).toBe('/tmp/x')

    // The device already holds the first 70 000 bytes.
    ch.recv({ t: 'accept', transfer_id: offer.transfer_id, offset: BigInt(70_000) })
    await settle(60)
    const complete = ch.lastText('complete')!
    expect(complete.sha256).toBe(hex(data))
    // chunks cover exactly [70000, 150000) in order, ≤ 64 KiB each
    const chunks = ch.binaries.map((b) => decodeChunk(b)!)
    expect(chunks[0]!.offset).toBe(70_000)
    let pos = 70_000
    for (const c of chunks) {
      expect(c.transferId).toBe(offer.transfer_id)
      expect(c.offset).toBe(pos)
      expect(c.payload.byteLength).toBeLessThanOrEqual(65_536)
      expect(Array.from(c.payload)).toEqual(Array.from(data.subarray(pos, pos + c.payload.byteLength)))
      pos += c.payload.byteLength
    }
    expect(pos).toBe(150_000)

    ch.recv({ t: 'ack', transfer_id: offer.transfer_id, offset: BigInt(150_000) })
    ch.recv({ t: 'done', transfer_id: offer.transfer_id, ok: true, path: '/tmp/x/a.bin' })
    await settle(3)
    const t = mgr.snapshot().find((x) => x.token === token)!
    expect(t.status, t.error).toBe('done')
    expect(t.path).toBe('/tmp/x/a.bin')
    expect(t.bytes).toBe(150_000)
  })

  it('sends v2 deflate frames when the device advertises the codec, raw frames otherwise', async () => {
    const { text, noise } = await import('./testdata')
    const { inflateChunk } = await import('./codec')
    const data = text(200_000)
    const token = await mgr.upload(new File([data], 'notes.txt'))
    await settle()
    const offer = ch.lastText('offer')!
    ch.recv({ t: 'accept', transfer_id: offer.transfer_id, offset: 0n, codecs: ['deflate'] })
    await settle(80)
    expect(ch.lastText('complete')!.sha256).toBe(hex(data))
    const out = new Uint8Array(data.byteLength)
    let packed = 0
    let wire = 0
    for (const b of ch.binaries) {
      expect(new Uint8Array(b)[0]).toBe(2)
      wire += b.byteLength
      const c = decodeChunk(b)!
      const payload = c.codec === 'deflate' ? (packed++, inflateChunk(c.payload, 65_536)) : c.payload
      out.set(payload, c.offset)
    }
    expect(packed).toBeGreaterThan(0)
    expect(Array.from(out)).toEqual(Array.from(data))
    expect(wire * 4).toBeLessThan(data.byteLength)
    const t = mgr.snapshot().find((x) => x.token === token)!
    expect(t.codec).toBe('deflate')
    expect(t.payloadBytes).toBe(data.byteLength)
    expect(t.wireBytes).toBe(wire)

    // Noise with the codec negotiated: v2 frames, but every payload stays raw.
    ch.binaries = []
    const n = noise(150_000)
    await mgr.upload(new File([n], 'blob'))
    await settle()
    ch.recv({ t: 'accept', transfer_id: ch.lastText('offer')!.transfer_id, offset: 0n, codecs: ['deflate'] })
    await settle(60)
    expect(ch.binaries.length).toBeGreaterThan(0)
    expect(ch.binaries.every((b) => decodeChunk(b)!.codec === 'raw')).toBe(true)

    // An old agent (no codecs) gets version-1 frames.
    ch.binaries = []
    await mgr.upload(new File([data], 'legacy.txt'))
    await settle()
    ch.recv({ t: 'accept', transfer_id: ch.lastText('offer')!.transfer_id, offset: 0n })
    await settle(60)
    expect(ch.binaries.length).toBeGreaterThan(0)
    expect(ch.binaries.every((b) => new Uint8Array(b)[0] === 1)).toBe(true)
  })

  it('marks rejected and cancelled uploads as failed', async () => {
    await mgr.upload(new File([makeData(10)], 'r.bin'))
    await settle()
    const offer = ch.lastText('offer')!
    ch.recv({ t: 'reject', transfer_id: offer.transfer_id, reason: 'disabled' })
    await settle(3)
    expect(mgr.snapshot()[0]!.status).toBe('failed')
    expect(mgr.snapshot()[0]!.error).toBe('disabled')
  })

  it('cancel sends a cancel frame and stops the pump', async () => {
    const token = await mgr.upload(new File([makeData(500_000)], 'big.bin'))
    await settle()
    const offer = ch.lastText('offer')!
    ch.recv({ t: 'accept', transfer_id: offer.transfer_id, offset: 0n })
    await flush()
    mgr.cancel(token)
    await settle(10)
    expect(ch.lastText('cancel')?.transfer_id).toBe(offer.transfer_id)
    expect(mgr.snapshot()[0]!.status).toBe('cancelled')
  })

  it('pauses on disconnect and re-offers with the same token when a new channel attaches', async () => {
    const token = await mgr.upload(new File([makeData(300_000)], 'p.bin'))
    await settle()
    const first = ch.lastText('offer')!
    ch.recv({ t: 'accept', transfer_id: first.transfer_id, offset: 0n })
    await flush()
    ch.close()
    await settle(3)
    expect(mgr.snapshot()[0]!.status, mgr.snapshot()[0]!.error).toBe('paused')

    const ch2 = new FakeChannel()
    mgr.attach(ch2)
    await settle()
    const again = ch2.lastText('offer')!
    expect(again.token).toBe(token)
    expect(again.transfer_id).not.toBe(first.transfer_id)
    mgr.detach()
  })

  it('resends from the last acked byte when acks stop for 15 s', async () => {
    vi.useFakeTimers()
    try {
      // re-attach so the watchdog interval runs on the fake clock
      mgr.detach()
      mgr.attach(ch)
      const data = makeData(200_000)
      await mgr.upload(new File([data], 'w.bin'))
      await vi.advanceTimersByTimeAsync(10)
      const offer = ch.lastText('offer')!
      ch.recv({ t: 'accept', transfer_id: offer.transfer_id, offset: 0n })
      await vi.advanceTimersByTimeAsync(50)
      const sentBefore = ch.binaries.length
      expect(sentBefore).toBeGreaterThan(0)
      ch.recv({ t: 'ack', transfer_id: offer.transfer_id, offset: BigInt(65_536) })
      // the pump has already finished the file; no acks beyond 64 KiB arrive
      await vi.advanceTimersByTimeAsync(16_000)
      const resent = ch.binaries.slice(sentBefore).map((b) => decodeChunk(b)!)
      expect(resent.length).toBeGreaterThan(0)
      expect(resent[0]!.offset).toBe(65_536)
      // the digest is still that of the whole file
      expect(ch.lastText('complete')!.sha256).toBe(hex(data))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('TransferManager downloads', () => {
  let ch: FakeChannel
  let mgr: TransferManager
  let latest: Transfer[] = []
  beforeEach(() => {
    ch = new FakeChannel()
    mgr = new TransferManager()
    mgr.deviceId = 'dev_test'
    mgr.subscribe((t) => (latest = t))
    mgr.attach(ch)
  })
  it('publishes throttled snapshots to subscribers', async () => {
    await mgr.upload(new File([makeData(10)], 's.bin'))
    await new Promise((r) => setTimeout(r, 150))
    expect(latest.map((t) => t.name)).toEqual(['s.bin'])
  })
  afterEach(() => mgr.detach())

  it('requests, accepts from the sink offset, acks, verifies the hash and finishes', async () => {
    const data = makeData(2_500_000)
    const sink = new MemSink()
    await mgr.download('/home/u/big.dat', 'big.dat', data.byteLength, async () => sink)
    await settle()
    const req = ch.lastText('request')!
    expect(req.path).toBe('/home/u/big.dat')
    expect(req.transfer_id % 2).toBe(1)

    // agent answers with its own (even) id
    ch.recv({ t: 'offer', transfer_id: 2, token: 'tok-agent', name: 'big.dat', size: BigInt(data.byteLength), kind: 'file', direction: 'to_operator' })
    await settle()
    const accept = ch.lastText('accept')!
    expect(accept.transfer_id).toBe(2)
    expect(Number(accept.offset)).toBe(0)

    const { encodeChunk } = await import('./chunk')
    for (let pos = 0; pos < data.byteLength; pos += 65_536) {
      ch.recv(encodeChunk(2, pos, data.subarray(pos, Math.min(data.byteLength, pos + 65_536))))
    }
    await settle(30)
    const acks = ch.texts.filter((m) => m.t === 'ack')
    expect(acks.length).toBeGreaterThanOrEqual(2) // ≥ 1 MiB granularity + final
    expect(Number((acks.at(-1) as Extract<FileMessage, { t: 'ack' }>).offset)).toBe(data.byteLength)

    ch.recv({ t: 'complete', transfer_id: 2, sha256: hex(data) })
    await settle(10)
    expect(ch.lastText('done')).toMatchObject({ transfer_id: 2, ok: true })
    const dl = mgr.snapshot().find((t) => t.token === 'tok-agent')!
    expect(dl.status, dl.error).toBe('done')
    expect(Array.from(sink.bytes())).toEqual(Array.from(data))
  })

  it('ignores duplicate chunks after a resend and fails on a checksum mismatch', async () => {
    const data = makeData(100_000)
    const sink = new MemSink()
    await mgr.download('/x/f.bin', 'f.bin', data.byteLength, async () => sink)
    await settle()
    ch.recv({ t: 'offer', transfer_id: 4, token: 't4', name: 'f.bin', size: BigInt(data.byteLength), kind: 'file', direction: 'to_operator' })
    await settle()
    const { encodeChunk } = await import('./chunk')
    ch.recv(encodeChunk(4, 0, data.subarray(0, 65_536)))
    ch.recv(encodeChunk(4, 0, data.subarray(0, 65_536))) // duplicate
    ch.recv(encodeChunk(4, 65_536, data.subarray(65_536)))
    await settle(10)
    expect(sink.bytes().byteLength).toBe(100_000)
    ch.recv({ t: 'complete', transfer_id: 4, sha256: 'deadbeef' })
    await settle(10)
    expect(ch.lastText('done')).toMatchObject({ transfer_id: 4, ok: false })
    expect(mgr.snapshot().find((t) => t.token === 't4')!.status).toBe('failed')
  })

  it('resumes into a sink that already holds bytes', async () => {
    const data = makeData(300_000)
    // sink with the first 200 000 bytes "on disk"
    const sink = new MemSink(200_000)
    ;(sink as unknown as { handle: { getFile(): Promise<Blob> } }).handle = { getFile: async () => new Blob([data.subarray(0, 200_000)]) }
    await mgr.download('/x/r.bin', 'r.bin', data.byteLength, async () => sink)
    await settle()
    ch.recv({ t: 'offer', transfer_id: 6, token: 't6', name: 'r.bin', size: BigInt(data.byteLength), kind: 'file', direction: 'to_operator' })
    await settle()
    expect(Number(ch.lastText('accept')!.offset)).toBe(200_000)
    const { encodeChunk } = await import('./chunk')
    ch.recv(encodeChunk(6, 200_000, data.subarray(200_000, 265_536)))
    ch.recv(encodeChunk(6, 265_536, data.subarray(265_536)))
    await settle(10)
    ch.recv({ t: 'complete', transfer_id: 6, sha256: hex(data) })
    await settle(10)
    expect(ch.lastText('done')).toMatchObject({ transfer_id: 6, ok: true })
    expect(sink.bytes().byteLength).toBe(100_000) // only the missing tail was written
  })

  it('routes clipboard image offers to the clipboard handler', async () => {
    const png = makeData(1234)
    const got: Blob[] = []
    const sink = new MemSink()
    mgr.requestClipboard('image', ['clipboard.png'], async () => sink, (b) => got.push(b))
    await settle()
    expect(ch.lastText('request_clipboard')).toBeTruthy()
    ch.recv({ t: 'offer', transfer_id: 8, token: 'cb', name: 'clipboard.png', size: BigInt(png.byteLength), kind: 'clipboard_image', direction: 'to_operator' })
    await settle()
    const { encodeChunk } = await import('./chunk')
    ch.recv(encodeChunk(8, 0, png))
    await settle(5)
    ch.recv({ t: 'complete', transfer_id: 8, sha256: hex(png) })
    await settle(10)
    expect(got).toHaveLength(1)
    expect(got[0]!.size).toBe(1234)
  })

  it('advertises deflate in accept and inflates compressed chunks; a bomb chunk cancels', async () => {
    const { encodeChunkV2 } = await import('./chunk')
    const { deflateChunk } = await import('./codec')
    const { text } = await import('./testdata')
    const data = text(200_000)
    const sink = new MemSink()
    await mgr.download('/x/t.txt', 't.txt', data.byteLength, async () => sink)
    await settle()
    ch.recv({ t: 'offer', transfer_id: 10, token: 't10', name: 't.txt', size: BigInt(data.byteLength), kind: 'file', direction: 'to_operator' })
    await settle()
    expect(ch.lastText('accept')!.codecs).toEqual(['deflate'])
    for (let pos = 0; pos < data.byteLength; pos += 65_000) {
      const raw = data.subarray(pos, Math.min(data.byteLength, pos + 65_000))
      const packed = deflateChunk(raw)!
      ch.recv(encodeChunkV2(10, pos, 'deflate', packed))
    }
    await settle(20)
    ch.recv({ t: 'complete', transfer_id: 10, sha256: hex(data) })
    await settle(10)
    expect(ch.lastText('done')).toMatchObject({ transfer_id: 10, ok: true })
    const t = mgr.snapshot().find((x) => x.token === 't10')!
    expect(t.status, t.error).toBe('done')
    expect(t.codec).toBe('deflate')
    expect(t.payloadBytes).toBe(data.byteLength)
    expect(t.wireBytes * 4).toBeLessThan(t.payloadBytes)
    expect(Array.from(sink.bytes())).toEqual(Array.from(data))

    // A chunk that inflates past what the transfer still needs is refused.
    const sink2 = new MemSink()
    await mgr.download('/x/small.bin', 'small.bin', 1000, async () => sink2)
    await settle()
    ch.recv({ t: 'offer', transfer_id: 12, token: 't12', name: 'small.bin', size: 1000n, kind: 'file', direction: 'to_operator' })
    await settle()
    ch.recv(encodeChunkV2(12, 0, 'deflate', deflateChunk(new Uint8Array(60_000))!))
    await settle(10)
    expect(ch.lastText('cancel')?.transfer_id).toBe(12)
    expect(mgr.snapshot().find((x) => x.token === 't12')!.status).toBe('failed')
  })

  it('does not advertise codecs when compression is off', async () => {
    mgr.setCompression(false)
    const sink = new MemSink()
    await mgr.download('/x/o.bin', 'o.bin', 10, async () => sink)
    await settle()
    ch.recv({ t: 'offer', transfer_id: 14, token: 't14', name: 'o.bin', size: 10n, kind: 'file', direction: 'to_operator' })
    await settle()
    expect(ch.lastText('accept')!.codecs).toBeUndefined()
    expect(mgr.snapshot().find((x) => x.token === 't14')!.codec).toBeNull()
  })

  it('forwards listings and op results', () => {
    const listings: unknown[] = []
    const ops: unknown[] = []
    mgr.callbacks = { onListing: (l) => listings.push(l), onOpResult: (o) => ops.push(o) }
    mgr.list('/tmp')
    expect(ch.lastText('list')).toMatchObject({ path: '/tmp' })
    mgr.list()
    expect(ch.lastText('list')).toEqual({ t: 'list' })
    ch.recv({ t: 'listing', path: '/tmp', entries: [{ name: 'a', is_dir: false, size: 1n, hidden: false }] })
    ch.recv({ t: 'op_result', op: 'mkdir', path: '/tmp/n', ok: true })
    expect(listings).toHaveLength(1)
    expect(ops).toHaveLength(1)
  })
})
