import { describe, expect, it } from 'vitest'
import { Sha256, sha256Hex, toHex } from './sha256'

/** WebCrypto reference (Node's webcrypto when jsdom does not expose `subtle`). */
async function reference(data: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle ?? ((await import('node:' + 'crypto')) as { webcrypto: Crypto }).webcrypto.subtle
  return toHex(new Uint8Array(await subtle.digest('SHA-256', data.slice().buffer as ArrayBuffer)))
}

describe('incremental SHA-256', () => {
  it('matches known vectors', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('agrees with WebCrypto for arbitrary chunking', async () => {
    const data = new Uint8Array(200_003)
    let x = 12345
    for (let i = 0; i < data.length; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff
      data[i] = x & 0xff
    }
    const expected = await reference(data)
    for (const chunkSizes of [[1], [63, 1, 64, 65], [200_003], [1000, 3, 7, 64 * 1024]]) {
      const h = new Sha256()
      let pos = 0
      let i = 0
      while (pos < data.length) {
        const n = Math.min(chunkSizes[i % chunkSizes.length]!, data.length - pos)
        h.update(data.subarray(pos, pos + n))
        pos += n
        i++
      }
      expect(h.digestHex()).toBe(expected)
    }
  })

  it('handles lengths around the block boundary', async () => {
    for (const n of [55, 56, 57, 63, 64, 65, 119, 120, 128]) {
      const d = new Uint8Array(n).fill(0x61)
      expect(sha256Hex(d)).toBe(await reference(d))
    }
  })

  it('refuses to be reused after digest', () => {
    const h = new Sha256().update(new Uint8Array([1]))
    h.digestHex()
    expect(() => h.update(new Uint8Array([2]))).toThrow()
  })
})
