/**
 * Binary framing of the `files` data channel — mirrors `protocol::files` in the agent repo.
 *
 * Every binary frame is `[version: u8 = 1][transfer_id: u32 LE][offset: u64 LE][payload…]`.
 * Offsets are handled as JS numbers (exact up to 2^53, i.e. files up to 8 PiB).
 */

export const CHUNK_HEADER_LEN = 13
export const CHUNK_VERSION = 1
/** Maximum payload bytes per frame (keeps every SCTP message well below 256 KiB). */
/** Max payload per binary frame: header + payload must stay ≤ 64 KiB (SCTP message limit). */
export const MAX_CHUNK_BYTES = 64 * 1024 - CHUNK_HEADER_LEN
/** Receiver acknowledges progress at least every this many bytes. */
export const ACK_INTERVAL_BYTES = 1024 * 1024
/** Sender pauses when the channel's buffered amount exceeds this. */
export const BUFFERED_HIGH_WATER = 4 * 1024 * 1024
/** … and resumes once it drops below this. */
export const BUFFERED_LOW_WATER = 1024 * 1024

const MAX_SAFE = Number.MAX_SAFE_INTEGER

export function encodeChunk(transferId: number, offset: number, payload: Uint8Array): ArrayBuffer {
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_SAFE) throw new RangeError(`bad offset ${offset}`)
  if (!Number.isInteger(transferId) || transferId < 0 || transferId > 0xffffffff) throw new RangeError(`bad transfer id ${transferId}`)
  const buf = new ArrayBuffer(CHUNK_HEADER_LEN + payload.byteLength)
  const view = new DataView(buf)
  view.setUint8(0, CHUNK_VERSION)
  view.setUint32(1, transferId, true)
  view.setBigUint64(5, BigInt(offset), true)
  new Uint8Array(buf, CHUNK_HEADER_LEN).set(payload)
  return buf
}

export interface Chunk {
  transferId: number
  offset: number
  payload: Uint8Array
}

/** Returns `null` for frames that are too short, have an unknown version or an offset beyond 2^53. */
export function decodeChunk(frame: ArrayBuffer | Uint8Array): Chunk | null {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame)
  if (bytes.byteLength < CHUNK_HEADER_LEN) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint8(0) !== CHUNK_VERSION) return null
  const transferId = view.getUint32(1, true)
  const big = view.getBigUint64(5, true)
  if (big > BigInt(MAX_SAFE)) return null
  return { transferId, offset: Number(big), payload: bytes.subarray(CHUNK_HEADER_LEN) }
}

/** Transfer ids: the browser uses odd numbers, the agent even ones, so they never collide. */
export function nextOddId(prev: number): number {
  const n = prev + 2
  return n > 0xffff_fffd ? 1 : n
}
