import type { ConsoleToUi, UiToConsole } from '@/protocol'

export type WsStatus = 'connecting' | 'open' | 'closed'

type Listener = (msg: ConsoleToUi) => void
type StatusListener = (status: WsStatus) => void

const PING_INTERVAL_MS = 30_000
const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 15_000

/** u64 fields arrive typed as bigint from ts-rs; JSON has no bigint, so serialise them as numbers. */
function replacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? Number(value) : value
}

/**
 * The single `/ws/ui` connection. Reconnects with backoff, re-subscribes on open, pings
 * every 30 s and fans messages out to listeners. Signaling for a session subscribes with
 * `onSession(session_id, …)` and gets only the messages carrying that id.
 */
export class UiSocket {
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private statusListeners = new Set<StatusListener>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private backoff = BACKOFF_MIN_MS
  private nonce = 0
  private wanted = false
  status: WsStatus = 'closed'

  connect() {
    this.wanted = true
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.setStatus('connecting')
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws/ui`)
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.backoff = BACKOFF_MIN_MS
      this.setStatus('open')
      this.send({ type: 'subscribe' })
      this.pingTimer = setInterval(() => this.send({ type: 'ping', nonce: BigInt(++this.nonce) }), PING_INTERVAL_MS)
    }
    ws.onmessage = (ev) => {
      let msg: ConsoleToUi
      try {
        msg = JSON.parse(ev.data) as ConsoleToUi
      } catch {
        return
      }
      if (msg.type === 'pong') return
      for (const l of this.listeners) l(msg)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.cleanup()
      this.setStatus('closed')
      if (this.wanted) this.scheduleReconnect()
    }
    ws.onerror = () => {
      /* onclose follows */
    }
  }

  disconnect() {
    this.wanted = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const ws = this.ws
    this.cleanup()
    ws?.close()
    this.setStatus('closed')
  }

  /** Returns false when the socket is not open (message dropped). */
  send(msg: UiToConsole): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(msg, replacer))
    return true
  }

  onMessage(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  onStatus(l: StatusListener): () => void {
    this.statusListeners.add(l)
    l(this.status)
    return () => this.statusListeners.delete(l)
  }

  /** Listen to the messages that belong to one session. */
  onSession(sessionId: string, l: Listener): () => void {
    return this.onMessage((msg) => {
      if ('session_id' in msg && msg.session_id === sessionId) l(msg)
    })
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    const delay = this.backoff + Math.random() * 250
    this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff * 2)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.wanted) this.connect()
    }, delay)
  }

  private cleanup() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
    }
    this.ws = null
  }

  private setStatus(s: WsStatus) {
    if (this.status === s) return
    this.status = s
    for (const l of this.statusListeners) l(s)
  }
}

export const uiSocket = new UiSocket()
