import { describe, expect, it } from 'vitest'
import { decideChatNotification, previewText, titleWithUnread, type ChatNotifyInput } from './notify'

const base: ChatNotifyInput = { from: 'device', drawerOpen: false, tabVisible: true, tabFocused: true, permission: 'granted' }

describe('decideChatNotification', () => {
  it("never notifies for the operator's own lines", () => {
    expect(decideChatNotification({ ...base, from: 'operator' })).toEqual({ toast: false, system: false, sound: false })
    expect(decideChatNotification({ ...base, from: 'operator', drawerOpen: true, tabVisible: false })).toEqual({ toast: false, system: false, sound: false })
  })

  it('drawer closed + tab visible: toast and sound, no system notification', () => {
    expect(decideChatNotification(base)).toEqual({ toast: true, system: false, sound: true })
  })

  it('drawer closed + tab hidden: toast plus system notification when permitted', () => {
    expect(decideChatNotification({ ...base, tabVisible: false })).toEqual({ toast: true, system: true, sound: true })
    expect(decideChatNotification({ ...base, tabFocused: false })).toEqual({ toast: true, system: true, sound: true })
  })

  it('drawer closed + tab hidden without permission: toast only', () => {
    for (const permission of ['denied', 'default', 'unsupported'] as const) {
      expect(decideChatNotification({ ...base, tabVisible: false, permission })).toEqual({ toast: true, system: false, sound: true })
    }
  })

  it('drawer open + tab visible and focused: nothing', () => {
    expect(decideChatNotification({ ...base, drawerOpen: true })).toEqual({ toast: false, system: false, sound: false })
  })

  it('drawer open + tab away: system notification only (no toast under the drawer)', () => {
    expect(decideChatNotification({ ...base, drawerOpen: true, tabVisible: false })).toEqual({ toast: false, system: true, sound: true })
    expect(decideChatNotification({ ...base, drawerOpen: true, tabVisible: false, permission: 'denied' })).toEqual({ toast: false, system: false, sound: false })
  })
})

describe('titleWithUnread', () => {
  it('prefixes the count and strips a stale prefix', () => {
    expect(titleWithUnread('Remote Console', 0)).toBe('Remote Console')
    expect(titleWithUnread('Remote Console', 3)).toBe('(3) Remote Console')
    expect(titleWithUnread('(3) Remote Console', 5)).toBe('(5) Remote Console')
    expect(titleWithUnread('(5) Remote Console', 0)).toBe('Remote Console')
    expect(titleWithUnread('X', 150)).toBe('(99+) X')
  })
})

describe('previewText', () => {
  it('collapses whitespace and truncates with an ellipsis', () => {
    expect(previewText('  hello\n\nworld  ')).toBe('hello world')
    expect(previewText('a'.repeat(200), 20)).toBe(`${'a'.repeat(19)}…`)
  })
})
