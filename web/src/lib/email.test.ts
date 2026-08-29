import { describe, expect, it } from 'vitest'
import { DEFAULT_SMTP, portAfterSecurityChange, smtpFormComplete, smtpFormFrom, smtpPayload } from './email'

describe('SMTP settings helpers', () => {
  it('switches the port with the security mode only while it is still the previous default', () => {
    expect(portAfterSecurityChange(587, 'starttls', 'tls')).toBe(465)
    expect(portAfterSecurityChange(465, 'tls', 'starttls')).toBe(587)
    expect(portAfterSecurityChange(2525, 'starttls', 'tls')).toBe(2525)
    expect(portAfterSecurityChange(587, 'starttls', 'starttls')).toBe(587)
  })

  it('seeds the form from the stored config with an empty write-only password', () => {
    const form = smtpFormFrom({ ...DEFAULT_SMTP, host: 'smtp.example.com', password_set: true })
    expect(form.host).toBe('smtp.example.com')
    expect(form.password).toBe('')
    expect('password_set' in form).toBe(false)
  })

  it('keeps the stored password when the field is empty and trims addresses', () => {
    const body = smtpPayload({ ...DEFAULT_SMTP, host: ' smtp.example.com ', from_address: ' noreply@example.com ', password: '' })
    expect(body.password).toBeUndefined()
    expect(body.host).toBe('smtp.example.com')
    expect(body.from_address).toBe('noreply@example.com')
    expect(smtpPayload({ ...DEFAULT_SMTP, password: 'hunter2' }).password).toBe('hunter2')
  })

  it('requires a host and sender only while enabled', () => {
    expect(smtpFormComplete(DEFAULT_SMTP)).toBe(true)
    expect(smtpFormComplete({ ...DEFAULT_SMTP, enabled: true })).toBe(false)
    expect(smtpFormComplete({ ...DEFAULT_SMTP, enabled: true, host: 'h', from_address: 'a@b', port: 0 })).toBe(false)
    expect(smtpFormComplete({ ...DEFAULT_SMTP, enabled: true, host: 'h', from_address: 'a@b' })).toBe(true)
  })
})
