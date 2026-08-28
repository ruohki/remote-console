/**
 * Web Worker that compresses / decompresses transfer chunks so the viewer's main thread stays
 * responsive. Buffers are transferred, not copied, in both directions.
 */

import { deflateSync, inflateSync, type DeflateOptions } from 'fflate'

export interface CodecRequest {
  id: number
  op: 'deflate' | 'inflate'
  data: Uint8Array
  /** deflate: fflate level. */
  level?: DeflateOptions['level']
  /** inflate: maximum output bytes; larger streams are rejected. */
  limit?: number
}

export interface CodecResponse {
  id: number
  /** `null` = compressing did not pay off (send raw). */
  data: Uint8Array | null
  error?: string
}

const MIN_COMPRESS_BYTES = 128

function worthIt(raw: number, compressed: number): boolean {
  return compressed * 16 < raw * 15
}

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<CodecRequest>) => void) | null
  postMessage(msg: CodecResponse, transfer?: Transferable[]): void
}

ctx.onmessage = (ev) => {
  const { id, op, data } = ev.data
  try {
    if (op === 'deflate') {
      if (data.byteLength < MIN_COMPRESS_BYTES) {
        ctx.postMessage({ id, data: null })
        return
      }
      const out = deflateSync(data, { level: ev.data.level ?? 2 })
      if (worthIt(data.byteLength, out.byteLength)) ctx.postMessage({ id, data: out }, [out.buffer])
      else ctx.postMessage({ id, data: null })
    } else {
      const max = ev.data.limit ?? 65_536
      const out = inflateSync(data, { out: new Uint8Array(max + 1) })
      if (out.byteLength > max) throw new Error(`chunk inflates beyond ${max} bytes`)
      ctx.postMessage({ id, data: out }, [out.buffer])
    }
  } catch (e) {
    ctx.postMessage({ id, data: null, error: (e as Error).message })
  }
}
