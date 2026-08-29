import { describe, expect, it } from 'vitest'
import { summarizeDetails } from './auditSummary'

describe('summarizeDetails', () => {
  it('flattens an object into key: value pairs', () => {
    expect(summarizeDetails({ ip: '10.0.0.1', method: 'password', second_factor: true })).toBe('ip: 10.0.0.1 · method: password · second_factor: true')
  })

  it('accepts JSON strings and plain strings', () => {
    expect(summarizeDetails('{"result":"completed","size":12}')).toBe('result: completed · size: 12')
    expect(summarizeDetails('just text')).toBe('just text')
  })

  it('is empty for nothing', () => {
    expect(summarizeDetails(null)).toBe('')
    expect(summarizeDetails(undefined)).toBe('')
    expect(summarizeDetails('')).toBe('')
    expect(summarizeDetails({})).toBe('')
  })

  it('truncates long values and the whole line', () => {
    const long = 'x'.repeat(200)
    const one = summarizeDetails({ name: long })
    expect(one.length).toBeLessThanOrEqual(60)
    expect(one.endsWith('…')).toBe(true)
    const many = summarizeDetails(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`key${i}`, `value${i}`])))
    expect(many.length).toBeLessThanOrEqual(140)
    expect(many.endsWith('…')).toBe(true)
  })

  it('renders nested values compactly', () => {
    expect(summarizeDetails({ groups: ['a', 'b'], policy: { additive: true } })).toBe('groups: ["a","b"] · policy: {"additive":true}')
  })
})
