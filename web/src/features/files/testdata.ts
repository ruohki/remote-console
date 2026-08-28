/** Deterministic payloads for the transfer/codec tests. */

/** Incompressible bytes (xorshift32). */
export function noise(len: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(len))
  let x = 0x9e3779b9 >>> 0
  for (let i = 0; i < len; i++) {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    out[i] = x >>> 24
  }
  return out
}

/** Highly compressible text. */
export function text(len: number): Uint8Array<ArrayBuffer> {
  const line = new TextEncoder().encode('the quick brown fox jumps over the lazy dog\n')
  const out = new Uint8Array(new ArrayBuffer(len))
  for (let i = 0; i < len; i++) out[i] = line[i % line.length]!
  return out
}
