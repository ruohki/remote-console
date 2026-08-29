import { describe, expect, it } from 'vitest'
import {
  EMAIL_RESEND_COOLDOWN_S,
  allowedWhileEnrollmentPending,
  defaultSecondFactorMode,
  initialLoginState,
  loginErrorText,
  maskEmail,
  nextRouteAfterLogin,
  parseLoginParams,
  providerErrorText,
  reduceLogin,
  require2faText,
} from './authFlow'
import { parseErrorBody, parseRetryAfter } from './api'

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

describe('email codes as the second factor', () => {
  const pendingWith = (methods: ('totp' | 'passkey' | 'email')[]) =>
    reduceLogin(initialLoginState, { type: 'pending', pending: { pending: 'two_factor', methods, challenge_id: 'ch-mail' } })

  it('starts in email mode when email is the only method', () => {
    const s = pendingWith(['email'])
    expect(s.step).toBe('second_factor')
    expect(s.mode).toBe('email')
    expect(s.methods).toEqual(['email'])
    expect(s.emailSentTo).toBeUndefined()
  })

  it('keeps TOTP as the default and offers email alongside it', () => {
    expect(pendingWith(['totp', 'email']).mode).toBe('code')
    expect(pendingWith(['passkey', 'email']).mode).toBe('passkey')
    expect(defaultSecondFactorMode(['email', 'totp'])).toBe('code')
    expect(defaultSecondFactorMode([])).toBe('code')
  })

  it('switches to email mode on request and clears a previous error', () => {
    let s = pendingWith(['totp', 'email'])
    s = reduceLogin(s, { type: 'failed', status: 401, code: 'invalid_code', message: 'x' })
    s = reduceLogin(s, { type: 'set_mode', mode: 'email' })
    expect(s.mode).toBe('email')
    expect(s.error).toBeNull()
  })

  it('records where the code went and starts the resend cooldown', () => {
    let s = pendingWith(['email'])
    s = reduceLogin(s, { type: 'email_sent', sentTo: 'a***@example.com' })
    expect(s.emailSentTo).toBe('a***@example.com')
    expect(s.emailResendInS).toBe(EMAIL_RESEND_COOLDOWN_S)
    s = reduceLogin(s, { type: 'tick' })
    expect(s.emailResendInS).toBe(EMAIL_RESEND_COOLDOWN_S - 1)
  })

  it('ticks down to zero and then stays there', () => {
    let s = reduceLogin(pendingWith(['email']), { type: 'email_sent', sentTo: 'a***@x' })
    for (let i = 0; i < EMAIL_RESEND_COOLDOWN_S + 3; i++) s = reduceLogin(s, { type: 'tick' })
    expect(s.emailResendInS).toBe(0)
    const again = reduceLogin(s, { type: 'tick' })
    expect(again).toBe(s)
  })

  it('keeps the challenge when a send is rate limited and honours Retry-After', () => {
    let s = reduceLogin(pendingWith(['email']), { type: 'email_sent', sentTo: 'a***@x' })
    s = reduceLogin(s, { type: 'email_send_failed', status: 429, code: 'rate_limited', message: 'x', retryAfterS: 45 })
    expect(s.step).toBe('second_factor')
    expect(s.challengeId).toBe('ch-mail')
    expect(s.emailSentTo).toBe('a***@x')
    expect(s.emailResendInS).toBe(45)
    expect(s.error).toMatch(/Too many codes/)
  })

  it('allows an immediate retry after a non-rate-limit send failure', () => {
    const s = reduceLogin(pendingWith(['email']), { type: 'email_send_failed', status: 503, code: 'smtp_failed', message: 'Relay down' })
    expect(s.emailResendInS).toBe(0)
    expect(s.error).toBe('Relay down')
    expect(s.step).toBe('second_factor')
  })

  it('uses email wording for a wrong code and still counts attempts', () => {
    let s = reduceLogin(pendingWith(['email']), { type: 'email_sent', sentTo: 'a***@x' })
    s = reduceLogin(s, { type: 'failed', status: 401, code: 'invalid_code', message: 'x' })
    expect(s.error).toMatch(/latest email/)
    expect(s.error).not.toMatch(/30 seconds/)
    expect(s.attemptsLeft).toBe(4)
  })

  it('forgets the sent address when a new challenge starts', () => {
    let s = reduceLogin(pendingWith(['email']), { type: 'email_sent', sentTo: 'a***@x' })
    s = reduceLogin(s, { type: 'back' })
    s = reduceLogin(s, { type: 'pending', pending: { pending: 'two_factor', methods: ['email'], challenge_id: 'ch-2' } })
    expect(s.emailSentTo).toBeUndefined()
    expect(s.emailResendInS).toBeUndefined()
  })

  it('explains an unavailable email factor on the password step', () => {
    const s = reduceLogin(initialLoginState, { type: 'failed', status: 503, code: 'second_factor_unavailable', message: 'x' })
    expect(s.step).toBe('form')
    expect(s.lockedForS).toBeNull()
    expect(s.error).toBe('Email sign-in codes are not available right now. Contact your administrator.')
  })

  it('masks addresses like the server does', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com')
    expect(maskEmail('a@b.c')).toBe('a***@b.c')
    expect(maskEmail('nobody')).toBe('n***')
    expect(maskEmail('')).toBe('')
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
    expect(providerErrorText(new URLSearchParams('error=weird&error_description=nope'))).toMatch(/weird.*nope/)
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

describe('login URL parameters written by SSO redirects', () => {
  it('jumps into the second-factor step with the offered methods', () => {
    const p = parseLoginParams('?pending=two_factor&challenge_id=ch9&methods=totp,passkey&return=%2Fdevices%2Fd1')
    expect(p.pending).toEqual({ pending: 'two_factor', challenge_id: 'ch9', methods: ['totp', 'passkey'] })
    expect(p.returnTo).toBe('/devices/d1')
    expect(p.ssoError).toBeNull()
  })

  it('ignores a pending marker without a challenge and unknown methods', () => {
    expect(parseLoginParams('?pending=two_factor').pending).toBeNull()
    expect(parseLoginParams('?pending=two_factor&challenge_id=x&methods=sms').pending?.methods).toEqual(['totp'])
  })

  it('accepts email among the offered methods', () => {
    expect(parseLoginParams('?pending=two_factor&challenge_id=x&methods=email').pending?.methods).toEqual(['email'])
    expect(parseLoginParams('?pending=two_factor&challenge_id=x&methods=totp,email').pending?.methods).toEqual(['totp', 'email'])
  })

  it('maps provider errors with the provider and message', () => {
    const p = parseLoginParams('?error=provider_error&provider=saml&message=Signature%20invalid')
    expect(p.ssoError).toMatch(/identity provider returned an error/)
    expect(p.ssoError).toMatch(/Signature invalid/)
    expect(parseLoginParams('?error=mapping_rejected').ssoError).toMatch(/no matching group rule/)
  })

  it('never returns to an external URL', () => {
    expect(parseLoginParams('?return=https%3A%2F%2Fevil.example').returnTo).toBeNull()
    expect(parseLoginParams('?return=%2F%2Fevil.example').returnTo).toBeNull()
  })

  it('prefers the server return_to over the remembered location', () => {
    expect(nextRouteAfterLogin({ two_factor_required: false }, '/sessions', '/devices/d2')).toBe('/devices/d2')
    expect(nextRouteAfterLogin({ two_factor_required: false }, '/sessions', '//evil')).toBe('/sessions')
    expect(nextRouteAfterLogin({ two_factor_required: true }, '/sessions', '/devices/d2')).toBe('/security/setup')
  })

  it('describes the two-factor policy', () => {
    expect(require2faText('admins')).toMatch(/administrators/)
    expect(require2faText('all')).toMatch(/every account/)
    expect(require2faText('off')).toBeNull()
    expect(require2faText(undefined)).toBeNull()
  })
})

describe('error body parsing', () => {
  it('reads the documented envelope and the flat shorthand', () => {
    expect(parseErrorBody({ error: { code: 'invalid_token', message: 'Expired' } }, 400)).toEqual({ code: 'invalid_token', message: 'Expired' })
    expect(parseErrorBody({ error: 'smtp_failed', message: 'Relay refused' }, 400)).toEqual({ code: 'smtp_failed', message: 'Relay refused' })
    expect(parseErrorBody(undefined, 502)).toEqual({ code: 'http_502', message: undefined })
  })
})

describe('Retry-After parsing', () => {
  it('accepts delta seconds and HTTP dates', () => {
    expect(parseRetryAfter('60')).toBe(60)
    const now = Date.parse('2026-08-29T10:00:00Z')
    expect(parseRetryAfter('Sat, 29 Aug 2026 10:00:30 GMT', now)).toBe(30)
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter('soon')).toBeUndefined()
  })
})
