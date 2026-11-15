import { describe, expect, it } from 'vitest'
import { changedLabels, policyPayload } from './groupPolicy'

describe('group policy', () => {
  it('sends only the changed settings', () => {
    expect(policyPayload({ allow_audio: false, max_fps: 30 })).toEqual({ allow_audio: false, max_fps: 30 })
    expect(policyPayload({})).toEqual({})
  })

  it('clears the upload folder with an empty string and never sends a display name', () => {
    expect(policyPayload({ transfer_dir: undefined, display_name: 'x' })).toEqual({ transfer_dir: '' })
    expect(policyPayload({ transfer_dir: 'C:\\Support' })).toEqual({ transfer_dir: 'C:\\Support' })
  })

  it('labels the changes', () => {
    expect(changedLabels({ allow_audio: false, mode: 'help_me' })).toEqual(['Audio', 'Access mode'])
  })
})
