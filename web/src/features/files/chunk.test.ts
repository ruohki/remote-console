import { describe, expect, it } from 'vitest'
import { CHUNK_HEADER_LEN, decodeChunk, encodeChunk, nextOddId } from './chunk'

describe('chunk framing', () => {
  it('round-trips header and payload (little-endian, version 1)', () => {
    const payload = new Uint8Array([1, 2, 3, 250])
    const frame = encodeChunk(7, 2 ** 40 + 5, payload)
    expect(frame.byteLength).toBe(CHUNK_HEADER_LEN + 4)
    const bytes = new Uint8Array(frame)
    expect(bytes[0]).toBe(1)
    expect(Array.from(bytes.subarray(1, 5))).toEqual([7, 0, 0, 0])
    const c = decodeChunk(frame)!
    expect(c.transferId).toBe(7)
    expect(c.offset).toBe(2 ** 40 + 5)
    expect(Array.from(c.payload)).toEqual([1, 2, 3, 250])
  })

  it('decodes a frame produced by the agent layout', () => {
    // version=1, id=0x00000002, offset=0x0000000000010000 (65536)
    const raw = new Uint8Array([1, 2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 9, 9])
    const c = decodeChunk(raw)!
    expect(c.transferId).toBe(2)
    expect(c.offset).toBe(65536)
    expect(c.payload.byteLength).toBe(2)
  })

  it('rejects short frames, unknown versions and offsets beyond 2^53', () => {
    expect(decodeChunk(new Uint8Array(5))).toBeNull()
    const bad = new Uint8Array(encodeChunk(1, 0, new Uint8Array(1)))
    bad[0] = 2
    expect(decodeChunk(bad)).toBeNull()
    const huge = new Uint8Array(CHUNK_HEADER_LEN)
    huge[0] = 1
    huge.fill(0xff, 5, 13)
    expect(decodeChunk(huge)).toBeNull()
    expect(() => encodeChunk(1, -1, new Uint8Array(0))).toThrow()
    expect(() => encodeChunk(2 ** 32, 0, new Uint8Array(0))).toThrow()
  })

  it('browser ids stay odd and wrap', () => {
    expect(nextOddId(-1)).toBe(1)
    expect(nextOddId(1)).toBe(3)
    expect(nextOddId(0xffff_fffd)).toBe(1)
  })
})
