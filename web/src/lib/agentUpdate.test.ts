import { describe, expect, it } from 'vitest'
import { availableUpdate, compareSemver, desktopBadge, isOutdated, parseSemver, platformFor } from './agentUpdate'

describe('agent versions', () => {
  it('maps devices to download platforms', () => {
    expect(platformFor('macos', 'aarch64')).toBe('macos-universal')
    expect(platformFor('macos', 'x86_64')).toBe('macos-universal')
    expect(platformFor('windows', 'x86_64')).toBe('windows-x86_64')
    expect(platformFor('windows', 'aarch64')).toBe('windows-aarch64')
    expect(platformFor('linux', 'x86_64')).toBeNull()
  })

  it('compares semver with pre-releases', () => {
    const cmp = (a: string, b: string) => Math.sign(compareSemver(parseSemver(a)!, parseSemver(b)!))
    expect(cmp('0.1.2', '0.2.0')).toBe(-1)
    expect(cmp('0.10.0', '0.9.9')).toBe(1)
    expect(cmp('1.0.0-beta.1', '1.0.0')).toBe(-1)
    expect(cmp('1.0.0', '1.0.0-rc.1')).toBe(1)
    expect(cmp('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(cmp('1.0.0-beta.2', '1.0.0-beta.11')).toBe(-1)
    expect(cmp('1.0.0-alpha.beta', '1.0.0-beta')).toBe(-1)
    expect(cmp('v1.2.3+build.7', '1.2.3')).toBe(0)
    expect(parseSemver('dev')).toBeNull()
  })

  it('only flags known, older versions', () => {
    expect(isOutdated('0.1.0', '0.2.0')).toBe(true)
    expect(isOutdated('0.2.0', '0.2.0')).toBe(false)
    expect(isOutdated('0.3.0', '0.2.0')).toBe(false)
    expect(isOutdated('0.1.0', null)).toBe(false)
    expect(isOutdated('custom-build', '0.2.0')).toBe(false)
  })

  it('finds the update for a device', () => {
    const versions = { 'windows-x86_64': '0.2.0', 'macos-universal': null }
    expect(availableUpdate({ os: 'windows', arch: 'x86_64', agent_version: '0.1.0' }, versions)).toBe('0.2.0')
    expect(availableUpdate({ os: 'windows', arch: 'aarch64', agent_version: '0.1.0' }, versions)).toBeNull()
    expect(availableUpdate({ os: 'macos', arch: 'aarch64', agent_version: '0.1.0' }, versions)).toBeNull()
    expect(availableUpdate({ os: 'windows', arch: 'x86_64', agent_version: '0.1.0' }, undefined)).toBeNull()
  })
})

describe('desktop badge', () => {
  it('calls out signed-out and locked devices only while online', () => {
    expect(desktopBadge({ online: true, desktop: 'sign_in' })?.label).toBe('Signed out')
    expect(desktopBadge({ online: true, desktop: 'locked' })?.label).toBe('Locked')
    expect(desktopBadge({ online: true, desktop: 'user' })).toBeNull()
    expect(desktopBadge({ online: true, desktop: 'unknown' })).toBeNull()
    expect(desktopBadge({ online: false, desktop: 'locked' })).toBeNull()
  })
})
