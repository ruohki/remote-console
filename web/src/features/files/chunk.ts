/**
 * Binary framing of the `files` data channel — mirrors `protocol::files` in the agent repo.
 *
 * Two header layouts, both little-endian:
 *
 * * version 1 (13 bytes): `[1][transfer_id: u32][offset: u64][payload…]`, raw file bytes;
 * * version 2 (14 bytes): `[2][codec: u8][transfer_id: u32][offset: u64][payload…]`, the payload is
 *   raw (`codec = 0`) or a per-chunk raw DEFLATE stream (`codec = 1`).
 *
 * `offset` always counts *uncompressed* bytes so acks and resume never see compression. Offsets
 * are handled as JS numbers (exact up to 2^53, i.e. files up to 8 PiB).
 */

import type { ChunkCodec } from '@/protocol'

export const CHUNK_HEADER_LEN = 13
export const CHUNK_HEADER_LEN_V2 = 14
export const CHUNK_VERSION = 1
export const CHUNK_VERSION_V2 = 2
/** Largest binary frame (header + payload) either side sends: the SCTP message limit that every stack accepts. */
export const MAX_FRAME_BYTES = 64 * 1024
/** Max *uncompressed* payload per frame; leaves room for the larger header. A compressed payload is only used when smaller. */
export const MAX_CHUNK_BYTES = MAX_FRAME_BYTES - CHUNK_HEADER_LEN_V2
/** Receiver acknowledges progress at least every this many bytes. */
export const ACK_INTERVAL_BYTES = 1024 * 1024
/** Sender pauses when the channel's buffered amount exceeds this. */
export const BUFFERED_HIGH_WATER = 4 * 1024 * 1024
/** … and resumes once it drops below this. */
export const BUFFERED_LOW_WATER = 1024 * 1024

const MAX_SAFE = Number.MAX_SAFE_INTEGER

const CODEC_BYTE: Record<ChunkCodec, number> = { raw: 0, deflate: 1 }
const CODEC_BY_BYTE: (ChunkCodec | undefined)[] = ['raw', 'deflate']

function checkIds(transferId: number, offset: number) {
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_SAFE) throw new RangeError(`bad offset ${offset}`)
  if (!Number.isInteger(transferId) || transferId < 0 || transferId > 0xffffffff) throw new RangeError(`bad transfer id ${transferId}`)
}

/** Version-1 frame: raw payload, understood by every agent. */
export function encodeChunk(transferId: number, offset: number, payload: Uint8Array): ArrayBuffer {
  checkIds(transferId, offset)
  const buf = new ArrayBuffer(CHUNK_HEADER_LEN + payload.byteLength)
  const view = new DataView(buf)
  view.setUint8(0, CHUNK_VERSION)
  view.setUint32(1, transferId, true)
  view.setBigUint64(5, BigInt(offset), true)
  new Uint8Array(buf, CHUNK_HEADER_LEN).set(payload)
  return buf
}

/** Version-2 frame: carries the codec byte; only for receivers that advertised a codec in `accept`. */
export function encodeChunkV2(transferId: number, offset: number, codec: ChunkCodec, payload: Uint8Array): ArrayBuffer {
  checkIds(transferId, offset)
  const buf = new ArrayBuffer(CHUNK_HEADER_LEN_V2 + payload.byteLength)
  const view = new DataView(buf)
  view.setUint8(0, CHUNK_VERSION_V2)
  view.setUint8(1, CODEC_BYTE[codec])
  view.setUint32(2, transferId, true)
  view.setBigUint64(6, BigInt(offset), true)
  new Uint8Array(buf, CHUNK_HEADER_LEN_V2).set(payload)
  return buf
}

export interface Chunk {
  transferId: number
  /** Uncompressed byte offset of this chunk. */
  offset: number
  codec: ChunkCodec
  /** Encoded with `codec`. */
  payload: Uint8Array
}

/** Returns `null` for frames that are too short, have an unknown version/codec or an offset beyond 2^53. */
export function decodeChunk(frame: ArrayBuffer | Uint8Array): Chunk | null {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame)
  if (bytes.byteLength < 1) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint8(0)
  if (version === CHUNK_VERSION) {
    if (bytes.byteLength < CHUNK_HEADER_LEN) return null
    const big = view.getBigUint64(5, true)
    if (big > BigInt(MAX_SAFE)) return null
    return { transferId: view.getUint32(1, true), offset: Number(big), codec: 'raw', payload: bytes.subarray(CHUNK_HEADER_LEN) }
  }
  if (version === CHUNK_VERSION_V2) {
    if (bytes.byteLength < CHUNK_HEADER_LEN_V2) return null
    const codec = CODEC_BY_BYTE[view.getUint8(1)]
    if (!codec) return null
    const big = view.getBigUint64(6, true)
    if (big > BigInt(MAX_SAFE)) return null
    return { transferId: view.getUint32(2, true), offset: Number(big), codec, payload: bytes.subarray(CHUNK_HEADER_LEN_V2) }
  }
  return null
}

/** Transfer ids: the browser uses odd numbers, the agent even ones, so they never collide. */
export function nextOddId(prev: number): number {
  const n = prev + 2
  return n > 0xffff_fffd ? 1 : n
}
