/**
 * Device-side "pause control" (the session bar's emergency switch).
 *
 * While paused the agent drops every input event and only the person at the device can
 * lift it. The operator's own "input enabled" toggle is preserved so control resumes in
 * the state it was in before the pause.
 */
export interface ControlFlags {
  connected: boolean
  inputEnabled: boolean
  controlPaused: boolean
}

export interface EffectiveControl {
  /** input events may be sent right now */
  controlling: boolean
  /** the operator cannot change the input toggle */
  toggleLocked: boolean
  toggleTitle: string
}

export function effectiveControl(f: ControlFlags): EffectiveControl {
  if (f.controlPaused) {
    return {
      controlling: false,
      toggleLocked: true,
      toggleTitle: 'Remote control was paused by the person at the device — only they can resume it',
    }
  }
  return {
    controlling: f.connected && f.inputEnabled,
    toggleLocked: false,
    toggleTitle: f.inputEnabled ? 'Input on — click to view only' : 'Input off — click to control',
  }
}

export type PauseNotice = 'paused' | 'resumed' | null

/** Apply a `control_paused` message; returns the new flag and what to tell the operator. */
export function reduceControlPaused(prev: { controlPaused: boolean }, paused: boolean): { controlPaused: boolean; notice: PauseNotice } {
  if (paused === prev.controlPaused) return { controlPaused: prev.controlPaused, notice: null }
  return { controlPaused: paused, notice: paused ? 'paused' : 'resumed' }
}
