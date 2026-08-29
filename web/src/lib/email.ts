/** Pure helpers for the outgoing-email settings (`/api/email/config`). Unit tested. */

import type { SmtpConfigInput, SmtpConfigPublic, SmtpSecurity } from './types'

/** Conventional ports: submission with STARTTLS, implicit TLS, and plain (local relays). */
export const SMTP_DEFAULT_PORT: Record<SmtpSecurity, number> = { starttls: 587, tls: 465, none: 25 }

export const DEFAULT_SMTP: SmtpConfigInput = {
  enabled: false,
  host: '',
  port: SMTP_DEFAULT_PORT.starttls,
  security: 'starttls',
  username: '',
  password: '',
  from_address: '',
  from_name: '',
  reply_to: '',
}

/** Port after a security change: follows the convention only while the port was still the previous mode's default. */
export function portAfterSecurityChange(port: number, from: SmtpSecurity, to: SmtpSecurity): number {
  return port === SMTP_DEFAULT_PORT[from] ? SMTP_DEFAULT_PORT[to] : port
}

/** Form state seeded from the stored config; the password is write-only and starts empty. */
export function smtpFormFrom(stored: SmtpConfigPublic): SmtpConfigInput {
  const { password_set: _set, ...rest } = stored
  return { ...DEFAULT_SMTP, ...rest, password: '' }
}

/** Body for `PUT /api/email/config` and the `config` of a test send: an empty password keeps the stored one. */
export function smtpPayload(form: SmtpConfigInput): SmtpConfigInput {
  return {
    ...form,
    host: form.host.trim(),
    username: form.username.trim(),
    from_address: form.from_address.trim(),
    from_name: form.from_name.trim(),
    reply_to: form.reply_to.trim(),
    password: form.password || undefined,
  }
}

/** The form can be saved when disabled, or when the fields a send needs are present. */
export function smtpFormComplete(form: SmtpConfigInput): boolean {
  if (!form.enabled) return true
  return !!form.host.trim() && !!form.from_address.trim() && form.port > 0 && form.port <= 65535
}
