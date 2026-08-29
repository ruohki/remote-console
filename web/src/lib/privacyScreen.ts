import type { ControlMessage, DevicePermission, PrivacyScreenReason, PrivacyScreenSupport } from '@/protocol'

/**
 * Privacy screen: the device's own displays show a branded notice while the operator works.
 *
 * The operator engages it from the viewer toolbar; the agent confirms with `privacy_screen`
 * (no optimistic state — the button follows the echo) or refuses with
 * `privacy_screen_denied`. The person at the device can always lift it, and the operator may
 * engage it again afterwards; pausing control at the device blocks it for as long as it lasts.
 */
export interface PrivacyScreenState {
  active: boolean
  /** why it last changed (or was refused) */
  reason?: PrivacyScreenReason
}

export const initialPrivacyScreen: PrivacyScreenState = { active: false }

export type PrivacyScreenChanged = Extract<ControlMessage, { t: 'privacy_screen' }>
export type PrivacyScreenDenied = Extract<ControlMessage, { t: 'privacy_screen_denied' }>

export interface PrivacyScreenNotice {
  kind: 'info' | 'error'
  text: string
}

/** Apply an incoming `privacy_screen` / `privacy_screen_denied` message. */
export function reducePrivacyScreen(prev: PrivacyScreenState, msg: PrivacyScreenChanged | PrivacyScreenDenied): { state: PrivacyScreenState; notice: PrivacyScreenNotice | null } {
  if (msg.t === 'privacy_screen_denied') {
    // A refusal never changes what is shown at the device.
    const state: PrivacyScreenState = { ...prev, reason: msg.reason }
    return { state, notice: { kind: 'error', text: denialMessage(msg.reason) } }
  }
  const state: PrivacyScreenState = { active: msg.active, reason: msg.reason }
  // A repeated state (the agent re-announcing it) is not news.
  if (msg.active === prev.active) return { state, notice: null }
  const text = changeMessage(msg.active, msg.reason)
  return { state, notice: text ? { kind: msg.reason === 'failed' ? 'error' : 'info', text } : null }
}

export interface PrivacyScreenGates {
  support: PrivacyScreenSupport
  /** `AgentConfig.allow_privacy_screen` */
  allowed: boolean
  permission: DevicePermission | undefined
}

export const LIFTED_MESSAGE = 'Privacy screen lifted by the device user.'

/** Why the toolbar button is disabled, or null when the operator may use it. */
export function privacyScreenDisabledReason(g: PrivacyScreenGates): string | null {
  if (g.support === 'unsupported') return 'Not supported by this agent'
  if (!g.allowed) return 'Not allowed on this device'
  if (g.permission !== 'manage') return 'Requires manage permission'
  return null
}

const DENIAL: Record<PrivacyScreenReason, string> = {
  policy: 'Privacy screen not allowed on this device',
  permission: 'Privacy screen requires manage permission',
  unsupported: 'Privacy screen is not supported by this agent',
  device_user: LIFTED_MESSAGE,
  // Refused because another operator's session already engaged it.
  operator: 'Another session holds the privacy screen',
  control_paused: 'Privacy screen is unavailable while control is paused at the device',
  failed: 'Privacy screen could not be shown',
  timeout: 'Privacy screen could not be shown',
  watchdog: 'Privacy screen could not be shown',
  displays_changed: 'Privacy screen could not be shown',
  session_ended: 'Privacy screen could not be shown',
}

/**
 * Toast for a `privacy_screen_denied` message. An agent older than this console can still
 * refuse with a reason we retired (`locked`), so never render `undefined`.
 */
export function denialMessage(reason: PrivacyScreenReason): string {
  return DENIAL[reason] ?? 'Privacy screen could not be shown'
}

/**
 * Toast for a `privacy_screen` state change; null when the button state says it all (the
 * operator's own toggling, or the session is over anyway).
 */
export function changeMessage(active: boolean, reason: PrivacyScreenReason): string | null {
  if (active) return null
  switch (reason) {
    case 'operator':
    case 'session_ended':
      return null
    case 'device_user':
      return LIFTED_MESSAGE
    case 'timeout':
      return 'Privacy screen turned off after the time limit'
    case 'watchdog':
      return 'Privacy screen turned off by the agent watchdog'
    case 'displays_changed':
      return 'Privacy screen turned off because the displays changed'
    case 'control_paused':
      return 'Privacy screen turned off because control was paused at the device'
    default:
      return denialMessage(reason)
  }
}

const REASON_PHRASE: Record<PrivacyScreenReason, string> = {
  operator: 'operator',
  device_user: 'device user',
  policy: 'policy',
  permission: 'no manage permission',
  unsupported: 'not supported',
  timeout: 'timed out',
  watchdog: 'watchdog',
  displays_changed: 'displays changed',
  control_paused: 'control paused',
  session_ended: 'session ended',
  failed: 'failed',
}

/** Session timeline line for a `privacy_screen` event, e.g. "Privacy screen off (device user)". */
export function privacyScreenEventLabel(active: boolean, reason: PrivacyScreenReason): string {
  return `Privacy screen ${active ? 'on' : 'off'} (${REASON_PHRASE[reason]})`
}
