import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatParty, ClipboardKind, ConsoleToUi, ControlMessage, DisplayInfo, EndReason, IceServer, InputEvent, SessionState, VideoCodec } from '@/protocol'
import { uiSocket } from '@/lib/ws'
import { applyCodecPreferences, fromRtcCandidate, readStats, toRtcCandidate, toRtcIceServers, type RtcStatsSnapshot } from '@/lib/webrtc'
import { mapVideoTransceivers, primaryDisplay, videoTransceiverCount } from '@/lib/displays'
import { RtcFilesChannel } from '@/features/files/channel'
import { transferManager } from '@/features/files/store'

export type ViewerPhase = 'idle' | 'connecting' | 'awaiting_approval' | 'connected' | 'ended' | 'error'

export interface ViewerError {
  code: string
  message: string
}

export interface AgentStats {
  display: number
  codec: VideoCodec
  fps: number
  bitrate_kbps: number
  width: number
  height: number
  pipeline_ms: number
  hardware: boolean
}

export interface ChatLine {
  id: string
  from: ChatParty
  text: string
  tsMs: number
}

export interface RemoteClipboardRich {
  kind: ClipboardKind
  names: string[]
  totalBytes: number
  at: number
}

export interface ViewerState {
  phase: ViewerPhase
  sessionId: string | null
  codec: VideoCodec | null
  /** negotiated by the browser (what we asked for) */
  requestedCodec: 'h265' | 'h264' | 'unknown'
  error: ViewerError | null
  endReason: EndReason | null
  displays: DisplayInfo[]
  /** display `select_display` targets (input coordinates refer to it) */
  currentDisplay: number
  /** displays the agent is streaming */
  activeDisplays: number[]
  /** display index → stream */
  streams: Record<number, MediaStream>
  audioAvailable: boolean
  audioEnabled: boolean
  audioStream: MediaStream | null
  /** per display */
  agentStats: Record<number, AgentStats>
  rtcStats: RtcStatsSnapshot | null
  iceState: RTCIceConnectionState | 'new'
  remoteClipboard: string | null
  remoteClipboardRich: RemoteClipboardRich | null
  chat: ChatLine[]
  unreadChat: number
  filesOpen: boolean
  observers: string[]
}

const initial: ViewerState = {
  phase: 'idle',
  sessionId: null,
  codec: null,
  requestedCodec: 'unknown',
  error: null,
  endReason: null,
  displays: [],
  currentDisplay: 0,
  activeDisplays: [],
  streams: {},
  audioAvailable: false,
  audioEnabled: false,
  audioStream: null,
  agentStats: {},
  rtcStats: null,
  iceState: 'new',
  remoteClipboard: null,
  remoteClipboardRich: null,
  chat: [],
  unreadChat: 0,
  filesOpen: false,
  observers: [],
}

const CREATE_TIMEOUT_MS = 10_000
const CONNECT_TIMEOUT_MS = 30_000

const ERROR_TEXT: Record<string, string> = {
  device_offline: 'The device is offline.',
  device_busy: 'Someone else is already connected to this device.',
  forbidden: "You don't have connect permission for this device — ask an admin.",
  denied: 'The person at the device declined the request.',
  approval_timeout: 'Nobody answered at the device.',
  agent_error: 'The agent reported an error.',
  connection_failed: 'The connection could not be established. A TURN relay may be required.',
  no_ice_candidates:
    'Your browser gathered no network candidates, so WebRTC cannot connect: a VPN or privacy extension (e.g. Proton VPN, uBlock Origin) has set the WebRTC IP handling policy to "Disable non-proxied UDP". Allow WebRTC for this site, or configure a TURN relay on the console.',
  timeout: 'The console did not respond in time.',
  ws_closed: 'Lost the connection to the console.',
}

export interface ViewerSessionOptions {
  /** Displays known from the device summary before connecting (one transceiver each). */
  knownDisplays: DisplayInfo[]
  /** Whether the device config allows audio (an audio transceiver is added anyway; the agent ignores it otherwise). */
  wantAudio?: boolean
  /** Whether this viewer is opened in "watch" mode by an admin (chat marks as observer). */
  onChatNotify?: (line: ChatLine) => void
}

/**
 * Drives one remote control session: signaling over /ws/ui, the RTCPeerConnection with one
 * video transceiver per display plus audio, the `input`, `control` and `files` data channels,
 * chat and statistics.
 */
export function useViewerSession(deviceId: string, options: ViewerSessionOptions) {
  const [state, setState] = useState<ViewerState>(initial)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const inputRef = useRef<RTCDataChannel | null>(null)
  const controlRef = useRef<RTCDataChannel | null>(null)
  const filesRef = useRef<RTCDataChannel | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([])
  const remoteSet = useRef(false)
  const unsubscribe = useRef<(() => void) | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const statsTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const phaseRef = useRef<ViewerPhase>('idle')
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })
  const chatOpenRef = useRef(false)

  const patch = useCallback((p: Partial<ViewerState> | ((s: ViewerState) => Partial<ViewerState>)) => {
    setState((s) => {
      const next = typeof p === 'function' ? p(s) : p
      if (next.phase) phaseRef.current = next.phase
      return { ...s, ...next }
    })
  }, [])

  const clearTimers = () => {
    for (const t of timers.current) clearTimeout(t)
    timers.current = []
    if (statsTimer.current) clearInterval(statsTimer.current)
    statsTimer.current = null
  }

  const teardown = useCallback(() => {
    clearTimers()
    unsubscribe.current?.()
    unsubscribe.current = null
    transferManager.detach()
    inputRef.current?.close()
    controlRef.current?.close()
    filesRef.current?.close()
    inputRef.current = null
    controlRef.current = null
    filesRef.current = null
    pcRef.current?.close()
    pcRef.current = null
    remoteSet.current = false
    pendingCandidates.current = []
  }, [])

  const fail = useCallback(
    (code: string, message?: string) => {
      teardown()
      patch({ phase: 'error', error: { code, message: message ?? ERROR_TEXT[code] ?? 'Something went wrong.' } })
    },
    [teardown, patch],
  )

  const sendControl = useCallback((msg: ControlMessage) => {
    const ch = controlRef.current
    if (!ch || ch.readyState !== 'open') return false
    ch.send(JSON.stringify(msg, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))
    return true
  }, [])

  const sendInput = useCallback((ev: InputEvent) => {
    const ch = inputRef.current
    if (!ch || ch.readyState !== 'open') return false
    ch.send(JSON.stringify(ev))
    return true
  }, [])

  const end = useCallback(
    (reason: EndReason = 'operator_closed') => {
      const id = sessionIdRef.current
      sendInput({ t: 'rel' })
      if (id) uiSocket.send({ type: 'session_end', session_id: id })
      teardown()
      patch({ phase: 'ended', endReason: reason })
    },
    [sendInput, teardown, patch],
  )

  const handleSessionState = useCallback(
    (s: SessionState, reason?: EndReason | null) => {
      if (s === 'awaiting_approval') patch({ phase: 'awaiting_approval' })
      else if (s === 'connecting' && phaseRef.current === 'awaiting_approval') patch({ phase: 'connecting' })
      else if (s === 'ended') {
        const r = reason ?? 'error'
        if (r === 'denied' || r === 'approval_timeout' || r === 'agent_offline' || r === 'connection_failed' || r === 'error') {
          fail(r === 'agent_offline' ? 'device_offline' : r)
        } else {
          teardown()
          patch({ phase: 'ended', endReason: r })
        }
      }
    },
    [patch, fail, teardown],
  )

  const handleControl = useCallback(
    (msg: ControlMessage) => {
      switch (msg.t) {
        case 'display_info':
          patch({ displays: msg.displays, currentDisplay: msg.current, activeDisplays: msg.active ?? [], audioAvailable: !!msg.audio })
          break
        case 'stats':
          patch((s) => ({
            agentStats: {
              ...s.agentStats,
              [msg.display ?? 0]: {
                display: msg.display ?? 0,
                codec: msg.codec,
                fps: msg.fps,
                bitrate_kbps: msg.bitrate_kbps,
                width: msg.width,
                height: msg.height,
                pipeline_ms: msg.pipeline_ms,
                hardware: msg.hardware,
              },
            },
          }))
          break
        case 'clipboard_changed':
          patch({ remoteClipboard: msg.text })
          navigator.clipboard?.writeText(msg.text).catch(() => {
            /* needs a user gesture in some browsers; the toolbar offers a copy button */
          })
          break
        case 'clipboard_available':
          patch({ remoteClipboardRich: { kind: msg.kind, names: msg.names, totalBytes: Number(msg.total_bytes), at: Date.now() } })
          break
        case 'chat': {
          const line: ChatLine = { id: `${Number(msg.ts_ms)}-${Math.random().toString(36).slice(2, 8)}`, from: msg.from, text: msg.text, tsMs: Number(msg.ts_ms) }
          patch((s) => ({ chat: [...s.chat, line], unreadChat: chatOpenRef.current || msg.from === 'operator' ? s.unreadChat : s.unreadChat + 1 }))
          if (msg.from === 'device' && !chatOpenRef.current) optionsRef.current.onChatNotify?.(line)
          break
        }
        case 'session_ended_by_user':
          teardown()
          patch({ phase: 'ended', endReason: 'device_user_closed' })
          break
        default: {
          // Newer control messages (e.g. observers joining) are surfaced generically.
          const m = msg as { t: string; name?: string }
          if (m.t === 'observer_joined' && m.name) patch((s) => ({ observers: [...s.observers.filter((n) => n !== m.name), m.name!] }))
          if (m.t === 'observer_left' && m.name) patch((s) => ({ observers: s.observers.filter((n) => n !== m.name) }))
          break
        }
      }
    },
    [patch, teardown],
  )

  const start = useCallback(async () => {
    teardown()
    sessionIdRef.current = null
    patch({ ...initial, phase: 'connecting' })

    if (uiSocket.status !== 'open') {
      fail('ws_closed')
      return
    }

    const pc = new RTCPeerConnection({ iceCandidatePoolSize: 0 })
    pcRef.current = pc

    // One recvonly video transceiver per display, in DisplayInfo index order; the agent
    // binds the i-th video m-line to display i.
    const known = [...optionsRef.current.knownDisplays].sort((a, b) => a.index - b.index)
    const videoTransceivers: RTCRtpTransceiver[] = []
    let requestedCodec: 'h265' | 'h264' | 'unknown' = 'unknown'
    for (let i = 0; i < videoTransceiverCount(known); i++) {
      const tr = pc.addTransceiver('video', { direction: 'recvonly' })
      requestedCodec = applyCodecPreferences(tr)
      videoTransceivers.push(tr)
    }
    const bindings = mapVideoTransceivers(known, videoTransceivers)
    const audioTransceiver = pc.addTransceiver('audio', { direction: 'recvonly' })
    patch({ requestedCodec, displays: known, currentDisplay: primaryDisplay(known), activeDisplays: known.length ? [primaryDisplay(known)] : [0] })

    // Data channels are created by the browser (the offerer).
    const input = pc.createDataChannel('input', { ordered: true })
    const control = pc.createDataChannel('control', { ordered: true })
    const files = pc.createDataChannel('files', { ordered: true })
    inputRef.current = input
    controlRef.current = control
    filesRef.current = files
    control.onmessage = (ev) => {
      try {
        handleControl(JSON.parse(ev.data) as ControlMessage)
      } catch {
        /* ignore malformed */
      }
    }
    files.onopen = () => {
      transferManager.deviceId = deviceId
      transferManager.attach(new RtcFilesChannel(files))
    }

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track])
      if (ev.track.kind === 'audio' || ev.transceiver === audioTransceiver) {
        patch({ audioStream: stream })
        return
      }
      const b = bindings.find((x) => x.transceiver === ev.transceiver) ?? bindings.find((x) => x.transceiver.mid === ev.transceiver.mid)
      const display = b ? b.display : Number(ev.transceiver.mid ?? 0)
      patch((s) => ({ streams: { ...s.streams, [display]: stream } }))
    }
    pc.oniceconnectionstatechange = () => {
      patch({ iceState: pc.iceConnectionState })
    }
    // A browser whose WebRTC UDP is disabled (VPN / privacy extension policy) finishes
    // gathering without a single candidate; it would otherwise spin until the ICE timeout.
    let localCandidates = 0
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete' && localCandidates === 0 && pc.connectionState !== 'connected') {
        fail('no_ice_candidates')
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        patch({ phase: 'connected' })
        clearTimers()
        let prev: { bytes: number; at: number } | undefined
        statsTimer.current = setInterval(async () => {
          if (!pcRef.current) return
          try {
            const r = await readStats(pcRef.current, prev)
            prev = r.sample
            patch({ rtcStats: r.snapshot })
          } catch {
            /* stats unavailable */
          }
        }, 1000)
      } else if (pc.connectionState === 'failed') {
        fail('connection_failed')
      }
    }

    // ICE candidates go out as soon as we have a session id (gathering only starts after
    // setLocalDescription, which happens once `session_created` arrived).
    pc.onicecandidate = (ev) => {
      if (ev.candidate) localCandidates += 1
      if (!ev.candidate || !sessionIdRef.current) return
      uiSocket.send({ type: 'ice_candidate', session_id: sessionIdRef.current, candidate: fromRtcCandidate(ev.candidate) })
    }

    let offer: RTCSessionDescriptionInit
    try {
      offer = await pc.createOffer()
    } catch (e) {
      fail('agent_error', `Could not create an offer: ${(e as Error).message}`)
      return
    }
    if (pcRef.current !== pc) return

    // Wait for the console to accept the offer, then start ICE with the session's servers.
    const created = new Promise<{ session_id: string; ice_servers: IceServer[] }>((resolve, reject) => {
      const off = uiSocket.onMessage((m: ConsoleToUi) => {
        if (m.type === 'session_created' && m.device_id === deviceId && !sessionIdRef.current) {
          off()
          resolve({ session_id: m.session_id, ice_servers: m.ice_servers })
        } else if (m.type === 'error' && !m.session_id && !sessionIdRef.current) {
          off()
          reject(new SessionError(m.code, m.message))
        }
      })
      timers.current.push(
        setTimeout(() => {
          off()
          reject(new SessionError('timeout'))
        }, CREATE_TIMEOUT_MS),
      )
    })

    if (!uiSocket.send({ type: 'session_offer', device_id: deviceId, offer: { type: 'offer', sdp: offer.sdp ?? '' } })) {
      fail('ws_closed')
      return
    }

    let sessionId: string
    let iceServers: IceServer[]
    try {
      ;({ session_id: sessionId, ice_servers: iceServers } = await created)
    } catch (e) {
      const se = e as SessionError
      fail(se.code, ERROR_TEXT[se.code] ?? se.message)
      return
    }
    if (pcRef.current !== pc) return
    sessionIdRef.current = sessionId
    patch({ sessionId })

    // Everything for this session from now on.
    unsubscribe.current = uiSocket.onSession(sessionId, async (m) => {
      if (pcRef.current !== pc) return
      switch (m.type) {
        case 'session_answer': {
          patch({ codec: m.codec })
          try {
            await pc.setRemoteDescription({ type: 'answer', sdp: m.answer.sdp })
            remoteSet.current = true
            for (const c of pendingCandidates.current) await pc.addIceCandidate(c).catch(() => undefined)
            pendingCandidates.current = []
          } catch (e) {
            fail('agent_error', `Could not apply the answer: ${(e as Error).message}`)
          }
          break
        }
        case 'ice_candidate': {
          const c = toRtcCandidate(m.candidate)
          if (remoteSet.current) await pc.addIceCandidate(c).catch(() => undefined)
          else pendingCandidates.current.push(c)
          break
        }
        case 'session_update':
          handleSessionState(m.session.state, m.session.end_reason ?? null)
          break
        case 'error':
          fail(m.code, ERROR_TEXT[m.code] ?? m.message)
          break
        default:
          break
      }
    })

    try {
      pc.setConfiguration({ iceServers: toRtcIceServers(iceServers), iceCandidatePoolSize: 0 })
      await pc.setLocalDescription(offer)
    } catch (e) {
      fail('agent_error', `Could not start ICE: ${(e as Error).message}`)
      return
    }

    timers.current.push(
      setTimeout(() => {
        if (pcRef.current === pc && phaseRef.current !== 'connected' && phaseRef.current !== 'awaiting_approval') {
          fail('connection_failed')
        }
      }, CONNECT_TIMEOUT_MS),
    )
  }, [deviceId, teardown, patch, fail, handleControl, handleSessionState])

  // End the session when the socket dies or the page goes away.
  useEffect(() => {
    const off = uiSocket.onStatus((s) => {
      if (s === 'closed' && pcRef.current) fail('ws_closed')
    })
    const onUnload = () => {
      const id = sessionIdRef.current
      if (id) uiSocket.send({ type: 'session_end', session_id: id })
    }
    window.addEventListener('pagehide', onUnload)
    return () => {
      off()
      window.removeEventListener('pagehide', onUnload)
      onUnload()
      teardown()
    }
  }, [fail, teardown])

  const selectDisplay = useCallback(
    (index: number) => {
      if (sendControl({ t: 'select_display', index })) patch({ currentDisplay: index })
    },
    [sendControl, patch],
  )

  const setActiveDisplays = useCallback(
    (indices: number[]) => {
      const uniq = Array.from(new Set(indices)).sort((a, b) => a - b)
      if (uniq.length === 0) return
      if (sendControl({ t: 'set_active_displays', indices: uniq })) patch({ activeDisplays: uniq })
    },
    [sendControl, patch],
  )

  const setAudio = useCallback(
    (enabled: boolean) => {
      if (sendControl({ t: 'set_audio', enabled })) patch({ audioEnabled: enabled })
    },
    [sendControl, patch],
  )

  const sendChat = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return false
      const tsMs = Date.now()
      if (!sendControl({ t: 'chat', from: 'operator', text: trimmed, ts_ms: BigInt(tsMs) })) return false
      patch((s) => ({ chat: [...s.chat, { id: `${tsMs}-op`, from: 'operator', text: trimmed, tsMs }] }))
      return true
    },
    [sendControl, patch],
  )

  /** Called by the chat drawer so incoming lines don't count as unread while it is open. */
  const setChatOpen = useCallback(
    (open: boolean) => {
      chatOpenRef.current = open
      if (open) patch({ unreadChat: 0 })
    },
    [patch],
  )

  /** Seed the transcript from persisted session events (reconnect to the same session). */
  const seedChat = useCallback(
    (lines: ChatLine[]) => {
      patch((s) => {
        const known = new Set(s.chat.map((l) => `${l.tsMs}|${l.from}|${l.text}`))
        const add = lines.filter((l) => !known.has(`${l.tsMs}|${l.from}|${l.text}`))
        if (add.length === 0) return {}
        return { chat: [...s.chat, ...add].sort((a, b) => a.tsMs - b.tsMs) }
      })
    },
    [patch],
  )

  const clearRichClipboard = useCallback(() => patch({ remoteClipboardRich: null }), [patch])

  return { state, start, end, sendInput, sendControl, selectDisplay, setActiveDisplays, setAudio, sendChat, setChatOpen, seedChat, clearRichClipboard }
}

class SessionError extends Error {
  code: string
  constructor(code: string, message?: string) {
    super(message ?? code)
    this.code = code
  }
}
