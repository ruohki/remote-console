import { describe, expect, it } from 'vitest'
import type { Transfer } from './manager'
import { compressionRatio, summarize } from './summary'

const t = (o: Partial<Transfer>): Transfer => ({
  key: 'k',
  token: 'k',
  transferId: 1,
  name: 'f',
  size: 100,
  kind: 'file',
  direction: 'to_device',
  status: 'transferring',
  bytes: 0,
  startOffset: 0,
  speedBps: 0,
  etaS: null,
  startedAt: 0,
  resumable: true,
  codec: null,
  payloadBytes: 0,
  wireBytes: 0,
  ...o,
})

describe('transfer summary', () => {
  it('aggregates active transfers and counts finished ones', () => {
    const s = summarize([
      t({ bytes: 40, size: 100, speedBps: 10 }),
      t({ direction: 'to_operator', bytes: 10, size: 50, speedBps: 5 }),
      t({ status: 'queued', size: 200 }),
      t({ status: 'done', bytes: 100, payloadBytes: 100, wireBytes: 40 }),
      t({ status: 'failed' }),
      t({ status: 'cancelled' }),
    ])
    expect(s).toMatchObject({ active: 3, sending: 2, receiving: 1, failed: 2, done: 1, bytesDone: 50, bytesTotal: 350, speedBps: 15, savedBytes: 60 })
    expect(s.etaS).toBeCloseTo(300 / 15)
  })

  it('has no ETA without speed and no ratio when compression did not help', () => {
    expect(summarize([t({ status: 'queued' })]).etaS).toBeNull()
    expect(compressionRatio(t({}))).toBeNull()
    expect(compressionRatio(t({ payloadBytes: 100, wireBytes: 99 }))).toBeNull()
    expect(compressionRatio(t({ payloadBytes: 300, wireBytes: 100 }))).toBeCloseTo(3)
  })
})
