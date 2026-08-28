import { describe, expect, it } from 'vitest'
import { buildGrantsPayload, canConnect, canManage, grantsDiff, grantsToChoices } from './access'

const admin = { role: 'admin' as const }
const operator = { role: 'operator' as const }

describe('canConnect / canManage', () => {
  it('admins can do everything regardless of the row permission', () => {
    expect(canConnect({ permission: 'view' }, admin)).toBe(true)
    expect(canManage({ permission: 'view' }, admin)).toBe(true)
  })
  it('operators follow the effective permission', () => {
    expect(canConnect({ permission: 'view' }, operator)).toBe(false)
    expect(canConnect({ permission: 'connect' }, operator)).toBe(true)
    expect(canManage({ permission: 'connect' }, operator)).toBe(false)
    expect(canManage({ permission: 'manage' }, operator)).toBe(true)
  })
  it('an unknown user is treated as an operator', () => {
    expect(canConnect({ permission: 'connect' }, null)).toBe(true)
    expect(canConnect({ permission: 'view' }, undefined)).toBe(false)
  })
})

describe('grants editor helpers', () => {
  it('maps grants to choices and back, dropping "none"', () => {
    const choices = grantsToChoices([
      { user_id: 'u2', permission: 'connect' },
      { user_id: 'u1', permission: 'view' },
    ])
    expect(choices).toEqual({ u1: 'view', u2: 'connect' })
    choices.u3 = 'none'
    choices.u1 = 'none'
    expect(buildGrantsPayload(choices)).toEqual({ grants: [{ user_id: 'u2', permission: 'connect' }] })
  })
  it('diffs saved vs edited state', () => {
    const saved = grantsToChoices([{ user_id: 'a', permission: 'view' }])
    expect(grantsDiff(saved, { a: 'view' })).toEqual([])
    expect(grantsDiff(saved, { a: 'connect', b: 'view' })).toEqual([
      { user_id: 'a', from: 'view', to: 'connect' },
      { user_id: 'b', from: 'none', to: 'view' },
    ])
    expect(grantsDiff(saved, { a: 'none' })).toEqual([{ user_id: 'a', from: 'view', to: 'none' }])
  })
})
