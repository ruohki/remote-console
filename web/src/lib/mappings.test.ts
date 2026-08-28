import { describe, expect, it } from 'vitest'
import { fromRows, globMatches, previewMapping, reduceMappings, toRows, validateGlob, validateRows, type MappingRow } from './mappings'

const rows = (): MappingRow[] =>
  toRows([
    { idp_group: 'it-admins', role: 'admin' },
    { idp_group: 'support-*', role: 'operator', groups: [{ group_id: 'g1', permission: 'connect' }] },
    { idp_group: 'auditors', groups: [{ group_id: 'g1', permission: 'view' }] },
  ])

describe('mapping editor reducer', () => {
  it('adds, removes and reorders rows keeping keys stable', () => {
    let r = rows()
    const keys = r.map((x) => x.key)
    r = reduceMappings(r, { type: 'add' })
    expect(r).toHaveLength(4)
    expect(r[3]!.idp_group).toBe('')
    r = reduceMappings(r, { type: 'move', key: keys[2]!, to: 0 })
    expect(r.map((x) => x.idp_group)).toEqual(['auditors', 'it-admins', 'support-*', ''])
    r = reduceMappings(r, { type: 'move', key: keys[0]!, to: 99 })
    expect(r[3]!.idp_group).toBe('it-admins')
    r = reduceMappings(r, { type: 'remove', key: keys[1]! })
    expect(r.map((x) => x.idp_group)).toEqual(['auditors', '', 'it-admins'])
  })

  it('edits role and console groups', () => {
    let r = rows()
    const k = r[2]!.key
    r = reduceMappings(r, { type: 'set_role', key: k, role: 'operator' })
    r = reduceMappings(r, { type: 'toggle_console_group', key: k, group_id: 'g2', permission: 'connect' })
    r = reduceMappings(r, { type: 'toggle_console_group', key: k, group_id: 'g1', permission: null })
    expect(r[2]!.role).toBe('operator')
    expect(r[2]!.groups).toEqual([{ group_id: 'g2', permission: 'connect' }])
    expect(fromRows(r)[2]).toEqual({ idp_group: 'auditors', role: 'operator', groups: [{ group_id: 'g2', permission: 'connect' }] })
  })

  it('serialises without empty fields', () => {
    const out = fromRows(toRows([{ idp_group: ' x ', groups: [] }]))
    expect(out).toEqual([{ idp_group: 'x' }])
  })
})

describe('glob validation and matching', () => {
  it('validates patterns', () => {
    expect(validateGlob('')).toMatch(/Enter/)
    expect(validateGlob('*')).toMatch(/every group/)
    expect(validateGlob('it-*')).toBeNull()
  })

  it('matches case-insensitively with * and ?', () => {
    expect(globMatches('support-*', 'Support-EMEA')).toBe(true)
    expect(globMatches('team-?', 'team-1')).toBe(true)
    expect(globMatches('team-?', 'team-10')).toBe(false)
    expect(globMatches('a.b', 'axb')).toBe(false)
  })

  it('flags rows without any effect', () => {
    const r = toRows([{ idp_group: 'x' }])
    expect(Object.values(validateRows(r))[0]).toMatch(/role and\/or/)
    expect(validateRows(rows())).toEqual({})
  })
})

describe('preview', () => {
  it('applies all matching rules, highest role wins, connect beats view', () => {
    const p = previewMapping(rows(), ['support-emea', 'auditors'], 'operator')
    expect(p.role).toBe('operator')
    expect(p.matched).toEqual(['support-*', 'auditors'])
    expect(p.grants).toEqual([{ group_id: 'g1', permission: 'connect' }])
    expect(previewMapping(rows(), ['it-admins', 'auditors'], 'none').role).toBe('admin')
  })

  it('falls back to the default role', () => {
    expect(previewMapping(rows(), ['nobody'], 'operator').role).toBe('operator')
    expect(previewMapping(rows(), ['nobody'], 'none').role).toBe('none')
    // matched but role-less rule still yields an account with the default role (or operator)
    expect(previewMapping(rows(), ['auditors'], 'none').role).toBe('operator')
  })
})
