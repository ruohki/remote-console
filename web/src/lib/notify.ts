/**
 * Operator-side notifications for chat lines that arrive from the device.
 *
 * Pure decision logic lives in {@link decideChatNotification} (unit tested); the browser
 * side effects (Notification API, sound, title) are thin wrappers around it.
 */

export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported'

export interface ChatNotifyInput {
  from: 'operator' | 'device'
  /** The chat drawer is open in the viewer. */
  drawerOpen: boolean
  /** `document.visibilityState === 'visible'`. */
  tabVisible: boolean
  /** `document.hasFocus()`. */
  tabFocused: boolean
  permission: NotifyPermission
}

export interface ChatNotifyDecision {
  /** Show the in-viewer toast with an "Open chat" action. */
  toast: boolean
  /** Fire a system (OS) notification. */
  system: boolean
  /** Play the short chime (still subject to the mute toggle). */
  sound: boolean
}

const NONE: ChatNotifyDecision = { toast: false, system: false, sound: false }

/**
 * - Operator's own lines never notify.
 * - Drawer open and the tab visible + focused: the operator is looking at it → nothing.
 * - Drawer open but the tab hidden/unfocused: system notification only (no toast — it would
 *   sit under the drawer), when permission was granted.
 * - Drawer closed: toast (+ sound); additionally a system notification when the tab is
 *   hidden/unfocused and permission was granted.
 */
export function decideChatNotification(i: ChatNotifyInput): ChatNotifyDecision {
  if (i.from !== 'device') return NONE
  const away = !i.tabVisible || !i.tabFocused
  const system = away && i.permission === 'granted'
  if (i.drawerOpen) return { toast: false, system, sound: system }
  return { toast: true, system, sound: true }
}

/** `"(3) Viewer — device"` while there are unread lines, the plain base title otherwise. */
export function titleWithUnread(base: string, unread: number): string {
  const clean = base.replace(/^\(\d+\+?\)\s+/, '')
  if (unread <= 0) return clean
  return `(${unread > 99 ? '99+' : unread}) ${clean}`
}

/** Truncate a chat line for a toast / notification body. */
export function previewText(text: string, max = 140): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// ── browser side ───────────────────────────────────────────────────────────────

const DENIED_KEY = 'viewer.notify.denied'
const SOUND_KEY = 'viewer.chatSound'

export function notificationPermission(): NotifyPermission {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

/** Ask once; a denial is remembered so we never nag again. */
export async function ensureNotificationPermission(): Promise<NotifyPermission> {
  const current = notificationPermission()
  if (current !== 'default') return current
  try {
    if (localStorage.getItem(DENIED_KEY) === '1') return 'denied'
  } catch {
    /* storage unavailable */
  }
  try {
    const result = await Notification.requestPermission()
    if (result === 'denied') {
      try {
        localStorage.setItem(DENIED_KEY, '1')
      } catch {
        /* ignore */
      }
    }
    return result
  } catch {
    return 'default'
  }
}

export function showSystemNotification(opts: { title: string; body: string; tag?: string; onClick?: () => void }): void {
  if (notificationPermission() !== 'granted') return
  try {
    const n = new Notification(opts.title, { body: opts.body, tag: opts.tag, silent: true })
    n.onclick = () => {
      try {
        window.focus()
      } catch {
        /* ignore */
      }
      opts.onClick?.()
      n.close()
    }
  } catch {
    /* Notification constructor can throw in some contexts (e.g. service-worker-only) */
  }
}

export function chatSoundEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== '0'
  } catch {
    return true
  }
}

export function setChatSoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

let audioCtx: AudioContext | null = null

/** Short two-tone chime synthesised with WebAudio (no asset, ~250 ms). */
export function playChatSound(): void {
  if (!chatSoundEnabled()) return
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    audioCtx ??= new Ctx()
    const ctx = audioCtx
    if (ctx.state === 'suspended') void ctx.resume()
    const t0 = ctx.currentTime
    for (const [freq, at] of [
      [880, 0],
      [1174.66, 0.11],
    ] as const) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t0 + at)
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + at + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.14)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t0 + at)
      osc.stop(t0 + at + 0.16)
    }
  } catch {
    /* audio unavailable or blocked before a user gesture */
  }
}

export function tabIsAway(): boolean {
  if (typeof document === 'undefined') return false
  return document.visibilityState !== 'visible' || !document.hasFocus()
}
