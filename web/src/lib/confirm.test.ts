import { describe, expect, it } from 'vitest'
import { confirmAllowed, normalizeName } from './confirm'

describe('confirmAllowed', () => {
  it('requires the exact name, ignoring case and surrounding whitespace', () => {
    expect(confirmAllowed({ expected: 'Front desk PC', typed: '', acknowledged: true })).toBe(false)
    expect(confirmAllowed({ expected: 'Front desk PC', typed: 'front desk', acknowledged: true })).toBe(false)
    expect(confirmAllowed({ expected: 'Front desk PC', typed: '  front  desk pc ', acknowledged: false })).toBe(true)
    expect(confirmAllowed({ expected: 'Front desk PC', typed: 'Front desk PC', acknowledged: false })).toBe(true)
  })
  it('falls back to the acknowledgement checkbox when there is no name', () => {
    expect(confirmAllowed({ expected: null, typed: 'anything', acknowledged: false })).toBe(false)
    expect(confirmAllowed({ expected: null, typed: '', acknowledged: true })).toBe(true)
    expect(confirmAllowed({ expected: '   ', typed: '', acknowledged: true })).toBe(true)
  })
  it('normalizes names consistently', () => {
    expect(normalizeName('  A   B ')).toBe('a b')
  })
})
