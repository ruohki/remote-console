import { describe, expect, it } from 'vitest'
import type { PrivacyScreenReason } from '@/protocol'
import { LIFTED_MESSAGE, changeMessage, denialMessage, initialPrivacyScreen, privacyScreenDisabledReason, privacyScreenEventLabel, reducePrivacyScreen } from './privacyScreen'

const REASONS: PrivacyScreenReason[] = ['operator', 'device_user', 'policy', 'permission', 'unsupported', 'locked', 'timeout', 'watchdog', 'displays_changed', 'control_paused', 'session_ended', 'failed']

describe('reducePrivacyScreen', () => {
  it('follows the agent echo for the operator without a notice', () => {
    const on = reducePrivacyScreen(initialPrivacyScreen, { t: 'privacy_screen', active: true, reason: 'operator', locked: false })
    expect(on.state).toEqual({ active: true, locked: false, reason: 'operator' })
    expect(on.notice).toBeNull()
    const off = reducePrivacyScreen(on.state, { t: 'privacy_screen', active: false, reason: 'operator', locked: false })
    expect(off.state).toEqual({ active: false, locked: false, reason: 'operator' })
    expect(off.notice).toBeNull()
  })

  it('locks and tells the operator when the device user lifts it', () => {
    const on = reducePrivacyScreen(initialPrivacyScreen, { t: 'privacy_screen', active: true, reason: 'operator', locked: false })
    const lifted = reducePrivacyScreen(on.state, { t: 'privacy_screen', active: false, reason: 'device_user', locked: true })
    expect(lifted.state).toEqual({ active: false, locked: true, reason: 'device_user' })
    expect(lifted.notice).toEqual({ kind: 'info', text: LIFTED_MESSAGE })
  })

  it('stays locked for the rest of the session', () => {
    const locked = { active: false, locked: true, reason: 'device_user' as const }
    const next = reducePrivacyScreen(locked, { t: 'privacy_screen', active: false, reason: 'operator', locked: false })
    expect(next.state.locked).toBe(true)
    expect(next.notice).toBeNull()
  })

  it('ignores a repeated state', () => {
    const on = { active: true, locked: false, reason: 'operator' as const }
    expect(reducePrivacyScreen(on, { t: 'privacy_screen', active: true, reason: 'operator', locked: false }).notice).toBeNull()
    expect(reducePrivacyScreen(initialPrivacyScreen, { t: 'privacy_screen', active: false, reason: 'session_ended', locked: false }).notice).toBeNull()
  })

  it('explains an involuntary release', () => {
    const on = { active: true, locked: false, reason: 'operator' as const }
    expect(reducePrivacyScreen(on, { t: 'privacy_screen', active: false, reason: 'displays_changed', locked: false }).notice).toEqual({ kind: 'info', text: 'Privacy screen turned off because the displays changed' })
    expect(reducePrivacyScreen(on, { t: 'privacy_screen', active: false, reason: 'failed', locked: false }).notice).toEqual({ kind: 'error', text: 'Privacy screen could not be shown' })
    expect(reducePrivacyScreen(on, { t: 'privacy_screen', active: false, reason: 'session_ended', locked: false }).notice).toBeNull()
  })

  it('keeps the shown state on a refusal and only remembers the lock', () => {
    const denied = reducePrivacyScreen(initialPrivacyScreen, { t: 'privacy_screen_denied', reason: 'permission' })
    expect(denied.state).toEqual({ active: false, locked: false, reason: 'permission' })
    expect(denied.notice).toEqual({ kind: 'error', text: 'Privacy screen requires manage permission' })
    const locked = reducePrivacyScreen(initialPrivacyScreen, { t: 'privacy_screen_denied', reason: 'locked' })
    expect(locked.state.locked).toBe(true)
    expect(locked.notice?.text).toBe(LIFTED_MESSAGE)
  })
})

describe('privacyScreenDisabledReason', () => {
  const ok = { support: 'standard' as const, allowed: true, permission: 'manage' as const, locked: false }

  it('is available when every gate passes', () => {
    expect(privacyScreenDisabledReason(ok)).toBeNull()
    expect(privacyScreenDisabledReason({ ...ok, support: 'screen_only' })).toBeNull()
  })

  it('names the failing gate', () => {
    expect(privacyScreenDisabledReason({ ...ok, support: 'unsupported' })).toBe('Not supported by this agent')
    expect(privacyScreenDisabledReason({ ...ok, allowed: false })).toBe('Not allowed on this device')
    expect(privacyScreenDisabledReason({ ...ok, permission: 'connect' })).toBe('Requires manage permission')
    expect(privacyScreenDisabledReason({ ...ok, permission: undefined })).toBe('Requires manage permission')
    expect(privacyScreenDisabledReason({ ...ok, locked: true })).toBe('Lifted by the device user — off for this session')
  })

  it('reports device support before policy and permission', () => {
    expect(privacyScreenDisabledReason({ support: 'unsupported', allowed: false, permission: 'view', locked: true })).toBe('Not supported by this agent')
    expect(privacyScreenDisabledReason({ support: 'standard', allowed: false, permission: 'view', locked: true })).toBe('Not allowed on this device')
  })
})

describe('denialMessage', () => {
  it('uses the agreed copy for the policy gates', () => {
    expect(denialMessage('policy')).toBe('Privacy screen not allowed on this device')
    expect(denialMessage('permission')).toBe('Privacy screen requires manage permission')
    expect(denialMessage('unsupported')).toBe('Privacy screen is not supported by this agent')
    expect(denialMessage('failed')).toBe('Privacy screen could not be shown')
    expect(denialMessage('operator')).toBe('Another session holds the privacy screen')
    expect(denialMessage('locked')).toBe(LIFTED_MESSAGE)
  })

  it('has terse copy for every reason', () => {
    for (const r of REASONS) {
      const m = denialMessage(r)
      expect(m.length).toBeGreaterThan(0)
      expect(m).not.toMatch(/!/)
    }
  })
})

describe('changeMessage', () => {
  it('is silent when the screen goes on or the operator turned it off', () => {
    for (const r of REASONS) expect(changeMessage(true, r)).toBeNull()
    expect(changeMessage(false, 'operator')).toBeNull()
    expect(changeMessage(false, 'session_ended')).toBeNull()
  })

  it('tells the operator who or what lifted it', () => {
    expect(changeMessage(false, 'device_user')).toBe(LIFTED_MESSAGE)
    expect(changeMessage(false, 'timeout')).toBe('Privacy screen turned off after the time limit')
    expect(changeMessage(false, 'watchdog')).toBe('Privacy screen turned off by the agent watchdog')
    expect(changeMessage(false, 'control_paused')).toBe('Privacy screen turned off because control was paused at the device')
    expect(changeMessage(false, 'policy')).toBe('Privacy screen not allowed on this device')
  })
})

describe('privacyScreenEventLabel', () => {
  it('is one short phrase per reason', () => {
    expect(privacyScreenEventLabel(true, 'operator')).toBe('Privacy screen on (operator)')
    expect(privacyScreenEventLabel(false, 'device_user')).toBe('Privacy screen off (device user)')
    expect(privacyScreenEventLabel(false, 'timeout')).toBe('Privacy screen off (timed out)')
    for (const r of REASONS) expect(privacyScreenEventLabel(false, r)).toMatch(/^Privacy screen off \([a-z ]+\)$/)
  })
})
