import { describe, expect, it } from 'vitest'
import { RECENT_SESSIONS, allSessionsHref, truncateRecent } from './sessionsList'

describe('recent sessions truncation', () => {
  it('keeps the first five and flags that more exist', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}` }))
    const t = truncateRecent(rows)
    expect(t.rows.map((r) => r.id)).toEqual(['s0', 's1', 's2', 's3', 's4'])
    expect(t.hasMore).toBe(true)
    expect(RECENT_SESSIONS).toBe(5)
  })

  it('does not flag more when everything fits', () => {
    const t = truncateRecent([{ id: 'a' }, { id: 'b' }])
    expect(t.rows).toHaveLength(2)
    expect(t.hasMore).toBe(false)
  })

  it('links to the sessions page scoped to the device', () => {
    expect(allSessionsHref('dev_1')).toBe('/sessions?device_id=dev_1')
    expect(allSessionsHref('dev with space')).toBe('/sessions?device_id=dev%20with%20space')
    expect(allSessionsHref(null)).toBe('/sessions')
  })
})
