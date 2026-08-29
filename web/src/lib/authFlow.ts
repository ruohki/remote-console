/**
 * Pure logic for the sign-in screen and post-login routing (unit tested; no DOM).
 *
 * The password form drives a small state machine: `form` → (`202`) `second_factor` →
 * `done`; locked-out / provider errors are surfaced as messages on the current step.
 */

import type { AuthProviders, LoginPending, SecondFactor, User } from './types'

export type SecondFactorMethod = SecondFactor

const KNOWN_METHODS: readonly SecondFactorMethod[] = ['totp', 'passkey', 'email']

export function isSecondFactorMethod(m: string): m is SecondFactorMethod {
  return (KNOWN_METHODS as readonly string[]).includes(m)
}

/** Seconds the "Resend code" button stays disabled after an email code was sent. */
export const EMAIL_RESEND_COOLDOWN_S = 30

export interface LoginState {
  step: 'form' | 'second_factor' | 'done'
  challengeId: string | null
  methods: SecondFactorMethod[]
  /** the sub-mode of the second factor step */
  mode: 'code' | 'recovery' | 'passkey' | 'email'
  error: string | null
  /** seconds until the account lockout ends, when known */
  lockedForS: number | null
  attemptsLeft: number | null
  /** masked address the last email code went to (email mode) */
  emailSentTo?: string
  /** seconds until another email code may be requested (email mode) */
  emailResendInS?: number
}

export const initialLoginState: LoginState = {
  step: 'form',
  challengeId: null,
  methods: [],
  mode: 'code',
  error: null,
  lockedForS: null,
  attemptsLeft: null,
}

export type LoginEvent =
  | { type: 'submitted' }
  | { type: 'ok'; user: User }
  | { type: 'pending'; pending: LoginPending }
  | { type: 'failed'; status: number; code: string; message: string; retryAfterS?: number }
  | { type: 'set_mode'; mode: LoginState['mode'] }
  /** an email code went out (`POST /api/auth/2fa/email/send`) */
  | { type: 'email_sent'; sentTo: string }
  /** sending an email code failed; the challenge stays valid (a 429 carries `Retry-After`) */
  | { type: 'email_send_failed'; status: number; code: string; message: string; retryAfterS?: number }
  /** one second of the resend countdown passed */
  | { type: 'tick' }
  | { type: 'back' }

/** Human messages for API error codes on the sign-in screen. */
export function loginErrorText(status: number, code: string, message: string, retryAfterS?: number): string {
  if (code === 'invalid_credentials' || /credential/i.test(code)) return 'Email or password is wrong.'
  if (code === 'invalid_code' || code === 'invalid_totp') return 'That code is not valid. Codes change every 30 seconds — try the current one.'
  if (code === 'challenge_expired' || code === 'challenge_voided') return 'The sign-in attempt expired. Start again.'
  if (code === 'account_disabled') return 'This account is disabled. Ask an administrator.'
  if (code === 'local_login_disabled') return 'Password sign-in is disabled on this console. Use single sign-on.'
  if (code === 'second_factor_unavailable') return 'Email sign-in codes are not available right now. Contact your administrator.'
  if (status === 429 || code === 'rate_limited' || code === 'locked_out') {
    const wait = retryAfterS ? ` Try again in ${retryAfterS >= 60 ? `${Math.ceil(retryAfterS / 60)} min` : `${retryAfterS} s`}.` : ' Try again in a minute.'
    return `Too many attempts.${wait}`
  }
  return message || 'Sign-in failed.'
}

/** Sub-mode to start the second-factor step in: TOTP first, then a key, then email codes. */
export function defaultSecondFactorMode(methods: SecondFactorMethod[]): LoginState['mode'] {
  if (methods.includes('totp')) return 'code'
  if (methods.includes('passkey')) return 'passkey'
  if (methods.includes('email')) return 'email'
  return 'code'
}

export function reduceLogin(state: LoginState, ev: LoginEvent): LoginState {
  switch (ev.type) {
    case 'submitted':
      return { ...state, error: null }
    case 'ok':
      return { ...state, step: 'done', error: null, challengeId: null, lockedForS: null }
    case 'pending': {
      const methods = ev.pending.methods.filter(isSecondFactorMethod)
      return {
        ...state,
        step: 'second_factor',
        challengeId: ev.pending.challenge_id,
        methods,
        mode: defaultSecondFactorMode(methods),
        error: null,
        attemptsLeft: 5,
        emailSentTo: undefined,
        emailResendInS: undefined,
      }
    }
    case 'failed': {
      const voided = ev.code === 'challenge_expired' || ev.code === 'challenge_voided' || (state.step === 'second_factor' && ev.status === 429)
      const locked = ev.status === 429 && state.step === 'form'
      const error =
        state.mode === 'email' && state.step === 'second_factor' && (ev.code === 'invalid_code' || ev.code === 'invalid_totp')
          ? 'That code is not valid. Check the latest email or request a new code.'
          : loginErrorText(ev.status, ev.code, ev.message, ev.retryAfterS)
      return {
        ...state,
        step: voided ? 'form' : state.step,
        challengeId: voided ? null : state.challengeId,
        error,
        lockedForS: locked ? (ev.retryAfterS ?? 60) : null,
        attemptsLeft: state.step === 'second_factor' && !voided && state.attemptsLeft !== null ? Math.max(0, state.attemptsLeft - 1) : state.attemptsLeft,
      }
    }
    case 'set_mode':
      return { ...state, mode: ev.mode, error: null }
    case 'email_sent':
      return { ...state, mode: 'email', error: null, emailSentTo: ev.sentTo, emailResendInS: EMAIL_RESEND_COOLDOWN_S }
    case 'email_send_failed': {
      const limited = ev.status === 429
      return {
        ...state,
        error: limited ? 'Too many codes were sent. Wait before requesting another one.' : loginErrorText(ev.status, ev.code, ev.message, ev.retryAfterS),
        emailResendInS: limited ? (ev.retryAfterS ?? EMAIL_RESEND_COOLDOWN_S) : 0,
      }
    }
    case 'tick':
      return state.emailResendInS ? { ...state, emailResendInS: state.emailResendInS - 1 } : state
    case 'back':
      return { ...initialLoginState }
  }
}

/** `alice@example.com` → `a***@example.com` (what the server shows for sent codes). */
export function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return email ? `${email.slice(0, 1)}***` : ''
  return `${email.slice(0, 1)}***${email.slice(at)}`
}

/** Where to send a user right after a successful sign-in (`returnTo` from the server wins over `from`). */
export function nextRouteAfterLogin(user: Pick<User, 'two_factor_required'>, from?: string | null, returnTo?: string | null): string {
  if (user.two_factor_required) return '/security/setup'
  for (const candidate of [returnTo, from]) {
    if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//') || candidate.startsWith('/login') || candidate.startsWith('/setup')) continue
    return candidate
  }
  return '/devices'
}

/** Routes a user with pending enrollment may still visit. */
export function allowedWhileEnrollmentPending(path: string): boolean {
  return path.startsWith('/security/setup') || path === '/login' || path === '/setup'
}

/** Providers reported by an older server (no `/api/auth/providers`) — plain password login. */
export const LEGACY_PROVIDERS: AuthProviders = { local_login: true, passkeys: false }

/** Login page URL parameters written by the server's SSO redirects (see API.md implementation notes). */
export interface LoginParams {
  /** `?pending=two_factor&challenge_id=…&methods=totp,passkey` — jump straight to the second factor */
  pending: LoginPending | null
  /** `?error=code&provider=oidc|saml&message=…` (or legacy `error_description`) */
  ssoError: string | null
  /** safe in-app path to return to after sign-in, when given */
  returnTo: string | null
}

export function parseLoginParams(search: string): LoginParams {
  const params = new URLSearchParams(search)
  let pending: LoginPending | null = null
  const challengeId = params.get('challenge_id')
  if (params.get('pending') === 'two_factor' && challengeId) {
    const methods = (params.get('methods') ?? 'totp')
      .split(',')
      .map((m) => m.trim())
      .filter(isSecondFactorMethod)
    pending = { pending: 'two_factor', challenge_id: challengeId, methods: methods.length ? methods : ['totp'] }
  }
  const ret = params.get('return')
  const returnTo = ret && ret.startsWith('/') && !ret.startsWith('//') ? ret : null
  return { pending, ssoError: providerErrorText(params), returnTo }
}

/** Provider error passed back on the return URL by the SSO callback (`?error=code&provider=&message=`). */
export function providerErrorText(params: URLSearchParams): string | null {
  const code = params.get('error')
  if (!code) return null
  const desc = params.get('message') ?? params.get('error_description')
  const provider = params.get('provider')
  const via = provider ? ` (${provider === 'oidc' ? 'OpenID Connect' : provider === 'saml' ? 'SAML' : provider})` : ''
  const known: Record<string, string> = {
    access_denied: 'The identity provider denied the sign-in.',
    email_not_verified: 'Your identity provider has not verified your email address.',
    domain_not_allowed: 'Your email domain is not allowed on this console.',
    provisioning_disabled: 'No account exists for you and automatic account creation is off. Ask an administrator.',
    invalid_state: 'The sign-in attempt expired or was tampered with. Try again.',
    provider_error: 'The identity provider returned an error.',
    two_factor_required: 'A second factor is required to finish signing in.',
    local_login_disabled: 'Password sign-in is disabled on this console.',
    mapping_rejected: 'Your identity provider account has no access to this console (no matching group rule).',
  }
  const base = known[code] ?? `Single sign-on failed${via} (${code}).`
  return desc && !known[code] ? `${base} ${desc}` : desc && known[code] ? `${base} ${desc}` : base
}

/** Text shown under the sign-in form for the server's two-factor policy. */
export function require2faText(policy?: string): string | null {
  if (policy === 'admins') return 'Two-factor authentication is required for administrators.'
  if (policy === 'all') return 'Two-factor authentication is required for every account.'
  return null
}
