import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConsoleToUi, ControlMessage, DisplayInfo, EndReason, IceServer, InputEvent, SessionState, VideoCodec } from '@/protocol'
import { uiSocket } from '@/lib/ws'
import { applyCodecPreferences, fromRtcCandidate, readStats, toRtcCandidate, toRtcIceServers, type RtcStatsSnapshot } from '@/lib/webrtc'

export type ViewerPhase = 'idle' | 'connecting' | 'awaiting_approval' | 'connected' | 'ended' | 'error'

export interface ViewerError {
  code: string
  message: string
}

export interface AgentStats {
  codec: VideoCodec
  fps: number
  bitrate_kbps: number
  width: number
  height: number
  pipeline_ms: number
  hardware: boolean
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
  currentDisplay: number
  agentStats: AgentStats | null
  rtcStats: RtcStatsSnapshot | null
  iceState: RTCIceConnectionState | 'new'
  remoteClipboard: string | null
  stream: MediaStream | null
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
  agentStats: null,
  rtcStats: null,
  iceState: 'new',
  remoteClipboard: null,
  stream: null,
}

const CREATE_TIMEOUT_MS = 10_000
const CONNECT_TIMEOUT_MS = 30_000

const ERROR_TEXT: Record<string, string> = {
  device_offline: 'The device is offline.',
  device_busy: 'Someone else is already connected to this device.',
  denied: 'The person at the device declined the request.',
  approval_timeout: 'Nobody answered at the device.',
  agent_error: 'The agent reported an error.',
  connection_failed: 'The connection could not be established. A TURN relay may be required.',
  timeout: 'The console did not respond in time.',
  ws_closed: 'Lost the connection to the console.',
}

/**
 * Drives one remote control session: signaling over /ws/ui, the RTCPeerConnection,
 * the `input` and `control` data channels and statistics.
 */
export function useViewerSession(deviceId: string) {
  const [state, setState] = useState<ViewerState>(initial)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const inputRef = useRef<RTCDataChannel | null>(null)
  const controlRef = useRef<RTCDataChannel | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([])
  const remoteSet = useRef(false)
  const unsubscribe = useRef<(() => void) | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const statsTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const phaseRef = useRef<ViewerPhase>('idle')

  const patch = useCallback((p: Partial<ViewerState>) => {
    if (p.phase) phaseRef.current = p.phase
    setState((s) => ({ ...s, ...p }))
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
    inputRef.current?.close()
    controlRef.current?.close()
    inputRef.current = null
    controlRef.current = null
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
    ch.send(JSON.stringify(msg))
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
          patch({ displays: msg.displays, currentDisplay: msg.current })
          break
        case 'stats':
          patch({
            agentStats: {
              codec: msg.codec,
              fps: msg.fps,
              bitrate_kbps: msg.bitrate_kbps,
              width: msg.width,
              height: msg.height,
              pipeline_ms: msg.pipeline_ms,
              hardware: msg.hardware,
            },
          })
          break
        case 'clipboard_changed':
          patch({ remoteClipboard: msg.text })
          navigator.clipboard?.writeText(msg.text).catch(() => {
            /* needs a user gesture in some browsers; the toolbar offers a copy button */
          })
          break
        case 'session_ended_by_user':
          teardown()
          patch({ phase: 'ended', endReason: 'device_user_closed' })
          break
        default:
          break
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

    const transceiver = pc.addTransceiver('video', { direction: 'recvonly' })
    const requestedCodec = applyCodecPreferences(transceiver)
    patch({ requestedCodec })

    // Data channels are created by the browser (the offerer).
    const input = pc.createDataChannel('input', { ordered: true })
    const control = pc.createDataChannel('control', { ordered: true })
    inputRef.current = input
    controlRef.current = control
    control.onmessage = (ev) => {
      try {
        handleControl(JSON.parse(ev.data) as ControlMessage)
      } catch {
        /* ignore malformed */
      }
    }

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track])
      patch({ stream })
    }
    pc.oniceconnectionstatechange = () => {
      patch({ iceState: pc.iceConnectionState })
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

  return { state, start, end, sendInput, sendControl, selectDisplay }
}

class SessionError extends Error {
  code: string
  constructor(code: string, message?: string) {
    super(message ?? code)
    this.code = code
  }
}
