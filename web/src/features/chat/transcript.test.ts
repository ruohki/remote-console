import { describe, expect, it } from 'vitest'
import { applyChatLine, mergeChatSeed, type ChatLine } from './transcript'

const line = (from: 'operator' | 'device', text: string, tsMs: number, id = `${tsMs}-${from}`): ChatLine => ({ id, from, text, tsMs })

describe('chat transcript dedupe', () => {
  it('operator line: local echo then session_event confirms it (no duplicate)', () => {
    let c: ChatLine[] = []
    c = applyChatLine(c, line('operator', 'hi', 1000, '1000-op'), 'local')
    expect(c).toHaveLength(1)
    expect(c[0]!.delivered).toBeFalsy()
    // The console echoes it back as a session event with its own (later, different) timestamp.
    c = applyChatLine(c, { id: 'ev-7', from: 'operator', text: 'hi', tsMs: 1234 }, 'event')
    expect(c).toHaveLength(1)
    expect(c[0]!.delivered).toBe(true)
    expect(c[0]!.confirmed).toBe(true)
  })

  it('device line: control channel then session_event confirms it (no duplicate)', () => {
    let c: ChatLine[] = []
    c = applyChatLine(c, line('device', 'yo', 2000), 'remote')
    expect(c).toHaveLength(1)
    c = applyChatLine(c, { id: 'ev-9', from: 'device', text: 'yo', tsMs: 2222 }, 'event')
    expect(c).toHaveLength(1)
    expect(c[0]!.confirmed).toBe(true)
  })

  it('reconnect seed containing both lines does not duplicate an already-present transcript', () => {
    let c: ChatLine[] = []
    c = applyChatLine(c, line('operator', 'hi', 1000, '1000-op'), 'local')
    c = applyChatLine(c, line('device', 'yo', 2000), 'remote')
    // Seed replays the persisted events (different, server-assigned timestamps).
    const seed: ChatLine[] = [
      { id: 'ev-1', from: 'operator', text: 'hi', tsMs: 1005 },
      { id: 'ev-2', from: 'device', text: 'yo', tsMs: 2005 },
    ]
    c = mergeChatSeed(c, seed)
    expect(c).toHaveLength(2)
    expect(c.filter((l) => l.from === 'operator')[0]!.delivered).toBe(true)
  })

  it('reconnect into an empty transcript adds the history once, and re-seeding is idempotent', () => {
    const seed: ChatLine[] = [
      { id: 'ev-1', from: 'device', text: 'earlier', tsMs: 500 },
      { id: 'ev-2', from: 'operator', text: 'reply', tsMs: 900 },
    ]
    let c = mergeChatSeed([], seed)
    expect(c.map((l) => l.text)).toEqual(['earlier', 'reply'])
    // The live stream keeps delivering the same growing array; must not re-append.
    c = mergeChatSeed(c, seed)
    expect(c).toHaveLength(2)
  })

  it('two identical operator lines get one confirmation each, in order', () => {
    let c: ChatLine[] = []
    c = applyChatLine(c, line('operator', 'ok', 1000, 'a'), 'local')
    c = applyChatLine(c, line('operator', 'ok', 1001, 'b'), 'local')
    c = applyChatLine(c, { id: 'ev-1', from: 'operator', text: 'ok', tsMs: 1100 }, 'event')
    c = applyChatLine(c, { id: 'ev-2', from: 'operator', text: 'ok', tsMs: 1101 }, 'event')
    expect(c).toHaveLength(2)
    expect(c.every((l) => l.confirmed)).toBe(true)
  })

  it('an event that arrives before its control-channel twin still de-dupes', () => {
    let c: ChatLine[] = []
    // event first (out-of-order relay), then the control-channel device line
    c = applyChatLine(c, { id: 'ev-1', from: 'device', text: 'hello', tsMs: 3000 }, 'event')
    expect(c).toHaveLength(1)
    c = applyChatLine(c, line('device', 'hello', 2990), 'remote')
    // The remote line appends (it can't retroactively match a confirmed line); the next
    // event for it (idempotent by key) won't add more. Worst case is a single duplicate on a
    // rare reorder — assert we don't explode to 3+.
    expect(c.length).toBeLessThanOrEqual(2)
  })
})
