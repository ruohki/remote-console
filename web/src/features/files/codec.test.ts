import { describe, expect, it } from 'vitest'
import { CompressionGate, chunkCodec, deflateChunk, inflateChunk, likelyIncompressible, worthIt } from './codec'
import { MAX_CHUNK_BYTES } from './chunk'
import { noise, text } from './testdata'

describe('chunk codec', () => {
  it('compresses text, leaves noise and tiny chunks raw, and round-trips', () => {
    const t = text(50_000)
    const packed = deflateChunk(t)!
    expect(packed).not.toBeNull()
    expect(packed.byteLength * 4).toBeLessThan(t.byteLength)
    expect(Array.from(inflateChunk(packed, MAX_CHUNK_BYTES))).toEqual(Array.from(t))
    expect(deflateChunk(noise(50_000))).toBeNull()
    expect(deflateChunk(t.subarray(0, 64))).toBeNull()
    expect(worthIt(1600, 1499)).toBe(true)
    expect(worthIt(1600, 1500)).toBe(false)
  })

  it('refuses chunks that inflate beyond the limit and garbage input', () => {
    const zeros = new Uint8Array(60_000)
    const packed = deflateChunk(zeros)!
    expect(packed.byteLength).toBeLessThan(300)
    expect(inflateChunk(packed, 60_000).byteLength).toBe(60_000)
    expect(() => inflateChunk(packed, 10_000)).toThrow(/beyond/)
    expect(() => inflateChunk(new Uint8Array([0xff, 0xff, 0xff]), 100)).toThrow()
  })

  it('gate backs off after misses and probes periodically', () => {
    const g = new CompressionGate()
    for (let i = 0; i < 4; i++) {
      expect(g.shouldTry()).toBe(true)
      g.record(false)
    }
    expect(g.backedOff).toBe(true)
    let tries = 0
    for (let i = 0; i < 16; i++) if (g.shouldTry()) tries++
    expect(tries).toBe(1)
    g.record(true)
    expect(g.backedOff).toBe(false)
    expect(new CompressionGate(true).backedOff).toBe(true)
  })

  it('guesses already-compressed formats from the extension', () => {
    expect(likelyIncompressible('photo.JPG')).toBe(true)
    expect(likelyIncompressible('archive.tar.gz')).toBe(true)
    expect(likelyIncompressible('notes.txt')).toBe(false)
    expect(likelyIncompressible('Makefile')).toBe(false)
    expect(likelyIncompressible('.png')).toBe(false)
  })

  it('async codec matches the inline functions (inline fallback under test)', async () => {
    const c = chunkCodec()
    const t = text(20_000)
    const packed = (await c.deflate(t))!
    expect(Array.from(await c.inflate(packed, 20_000))).toEqual(Array.from(t))
    expect(await c.deflate(noise(20_000))).toBeNull()
  })
})
