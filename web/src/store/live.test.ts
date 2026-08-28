import { describe, expect, it } from 'vitest'
import type { DeviceSummary, SessionSummary } from '@/protocol'
import { initialLiveState, reduceLive } from './live'

const device = (id: string, online = true): DeviceSummary => ({
  id,
  name: id,
  hostname: `${id}.local`,
  os: 'macos',
  arch: 'aarch64',
  agent_version: '0.1.0',
  mode: 'unattended',
  tags: [],
  online,
  codecs: ['h265', 'h264'],
  displays: [],
})

const session = (id: string, state: SessionSummary['state'] = 'connected', started = '2026-08-28T10:00:00Z'): SessionSummary => ({
  id,
  device_id: 'dev_1',
  device_name: 'dev_1',
  operator_id: 'u1',
  operator_name: 'Alice',
  state,
  started_at: started,
})

describe('reduceLive', () => {
  it('replaces everything on snapshot and marks hydrated', () => {
    const s = reduceLive(initialLiveState, { type: 'snapshot', devices: [device('a'), device('b', false)], sessions: [session('s1')] })
    expect(Object.keys(s.devices)).toEqual(['a', 'b'])
    expect(s.sessions['s1']?.state).toBe('connected')
    expect(s.hydrated).toBe(true)
  })

  it('upserts on device_update without touching others', () => {
    const base = reduceLive(initialLiveState, { type: 'snapshot', devices: [device('a')], sessions: [] })
    const s = reduceLive(base, { type: 'device_update', device: { ...device('a', false), active_session_id: undefined } })
    expect(s.devices['a']?.online).toBe(false)
    const t = reduceLive(s, { type: 'device_update', device: device('c') })
    expect(Object.keys(t.devices).sort()).toEqual(['a', 'c'])
    expect(t.devices['a']).toBe(s.devices['a'])
  })

  it('removes devices and is a no-op for unknown ids', () => {
    const base = reduceLive(initialLiveState, { type: 'snapshot', devices: [device('a')], sessions: [] })
    expect(reduceLive(base, { type: 'device_removed', device_id: 'zzz' })).toBe(base)
    expect(reduceLive(base, { type: 'device_removed', device_id: 'a' }).devices).toEqual({})
  })

  it('tracks session transitions', () => {
    let s = reduceLive(initialLiveState, { type: 'session_update', session: session('s1', 'requested') })
    s = reduceLive(s, { type: 'session_update', session: session('s1', 'awaiting_approval') })
    s = reduceLive(s, { type: 'session_update', session: { ...session('s1', 'ended'), end_reason: 'denied' } })
    expect(s.sessions['s1']?.state).toBe('ended')
    expect(s.sessions['s1']?.end_reason).toBe('denied')
  })

  it('caps the session history but keeps active sessions', () => {
    let s = initialLiveState
    for (let i = 0; i < 350; i++) {
      s = reduceLive(s, { type: 'session_update', session: session(`s${i}`, 'ended', new Date(1_700_000_000_000 + i * 1000).toISOString()) })
    }
    s = reduceLive(s, { type: 'session_update', session: session('live', 'connected', new Date(1_600_000_000_000).toISOString()) })
    expect(Object.keys(s.sessions).length).toBeLessThanOrEqual(300)
    expect(s.sessions['live']).toBeDefined()
    // newest history survives, oldest is gone
    expect(s.sessions['s349']).toBeDefined()
    expect(s.sessions['s0']).toBeUndefined()
  })

  it('ignores signaling messages', () => {
    const base = reduceLive(initialLiveState, { type: 'snapshot', devices: [], sessions: [] })
    expect(reduceLive(base, { type: 'session_created', session_id: 'x', device_id: 'a', ice_servers: [] })).toBe(base)
    expect(reduceLive(base, { type: 'pong', nonce: 1n })).toBe(base)
  })
})
