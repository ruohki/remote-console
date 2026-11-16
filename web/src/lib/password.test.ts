import { describe, expect, it } from 'vitest'
import { generatePassword, signInDetails } from './password'

describe('generatePassword', () => {
  it('makes four readable groups without look-alike characters', () => {
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword()
      expect(pw).toMatch(/^[a-zA-Z0-9]{4}(-[a-zA-Z0-9]{4}){3}$/)
      expect(pw).not.toMatch(/[0O1lI5S2Z]/)
      expect(pw.length).toBeGreaterThanOrEqual(10)
    }
  })

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generatePassword()))
    expect(seen.size).toBe(100)
  })
})

describe('signInDetails', () => {
  it('lists the console address, email and password on separate lines', () => {
    expect(signInDetails('ops@example.com', 'abcd-efgh', 'https://console.example.com')).toBe(
      'Console: https://console.example.com\nEmail: ops@example.com\nPassword: abcd-efgh',
    )
  })
})
