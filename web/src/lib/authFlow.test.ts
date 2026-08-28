import { describe, expect, it } from 'vitest'
import { allowedWhileEnrollmentPending, initialLoginState, loginErrorText, nextRouteAfterLogin, providerErrorText, reduceLogin } from './authFlow'

describe('login state machine', () => {
  it('goes straight to done on 200', () => {
    const s = reduceLogin(initialLoginState, { type: 'ok', user: { two_factor_required: false } as never })
    expect(s.step).toBe('done')
    expect(s.error).toBeNull()
  })

  it('enters the second-factor step on 202 and prefers the code input', () => {
    const s = reduceLogin(initialLoginState, { type: 'pending', pending: { pending: 'two_factor', methods: ['totp', 'passkey'], challenge_id: 'ch1' } })
    expect(s.step).toBe('second_factor')
    expect(s.challengeId).toBe('ch1')
    expect(s.mode).toBe('code')
    expect(s.attemptsLeft).toBe(5)
  })

  it('starts in passkey mode when TOTP is not available', () => {
    const s = reduceLogin(initialLoginState, { type: 'pending', pending: { pending: 'two_factor', methods: ['passkey'], challenge_id: 'ch2' } })
    expect(s.mode).toBe('passkey')
  })

  it('counts down attempts on wrong codes and drops back to the form when the challenge is voided', () => {
    let s = reduceLogin(initialLoginState, { type: 'pending', pending: { pending: 'two_factor', methods: ['totp'], challenge_id: 'ch' } })
    s = reduceLogin(s, { type: 'failed', status: 401, code: 'invalid_code', message: 'x' })
    expect(s.attemptsLeft).toBe(4)
    expect(s.error).toMatch(/not valid/)
    s = reduceLogin(s, { type: 'failed', status: 429, code: 'challenge_voided', message: 'x' })
    expect(s.step).toBe('form')
    expect(s.challengeId).toBeNull()
    expect(s.error).toMatch(/expired/)
  })

  it('reports a lockout with the wait time on the form', () => {
    const s = reduceLogin(initialLoginState, { type: 'failed', status: 429, code: 'rate_limited', message: 'x', retryAfterS: 120 })
    expect(s.lockedForS).toBe(120)
    expect(s.error).toMatch(/2 min/)
  })

  it('back resets everything', () => {
    let s = reduceLogin(initialLoginState, { type: 'pending', pending: { pending: 'two_factor', methods: ['totp'], challenge_id: 'ch' } })
    s = reduceLogin(s, { type: 'back' })
    expect(s).toEqual(initialLoginState)
  })
})

describe('messages', () => {
  it('maps codes', () => {
    expect(loginErrorText(401, 'invalid_credentials', '')).toMatch(/wrong/)
    expect(loginErrorText(403, 'local_login_disabled', '')).toMatch(/single sign-on/)
    expect(loginErrorText(500, 'boom', 'Server exploded')).toBe('Server exploded')
  })

  it('maps SSO callback errors', () => {
    expect(providerErrorText(new URLSearchParams('error=access_denied'))).toMatch(/denied/)
    expect(providerErrorText(new URLSearchParams('error=weird&error_description=nope'))).toBe('weird: nope')
    expect(providerErrorText(new URLSearchParams(''))).toBeNull()
  })
})

describe('post-login routing', () => {
  it('forces enrollment when the policy requires it', () => {
    expect(nextRouteAfterLogin({ two_factor_required: true }, '/devices/x')).toBe('/security/setup')
  })

  it('honours a safe return path and rejects unsafe ones', () => {
    expect(nextRouteAfterLogin({ two_factor_required: false }, '/sessions')).toBe('/sessions')
    expect(nextRouteAfterLogin({ two_factor_required: false }, '//evil.example')).toBe('/devices')
    expect(nextRouteAfterLogin({ two_factor_required: false }, 'https://evil.example')).toBe('/devices')
    expect(nextRouteAfterLogin({ two_factor_required: false }, '/login')).toBe('/devices')
    expect(nextRouteAfterLogin({ two_factor_required: false }, null)).toBe('/devices')
  })

  it('only lets pending users reach the setup page', () => {
    expect(allowedWhileEnrollmentPending('/security/setup')).toBe(true)
    expect(allowedWhileEnrollmentPending('/devices')).toBe(false)
  })
})
