import { create } from 'zustand'
import type { ConsoleToUi, DeviceSummary, SessionEvent, SessionSummary } from '@/protocol'

/** One row of the session timeline (`GET /api/sessions/:id/events` and live pushes). */
export interface SessionEventRow {
  id: number
  session_id: string
  ts: string
  event: SessionEvent
}
import type { WsStatus } from '@/lib/ws'

export interface LiveState {
  devices: Record<string, DeviceSummary>
  sessions: Record<string, SessionSummary>
  /** Live session events received on this connection, newest last, per session. */
  sessionEvents: Record<string, SessionEventRow[]>
  /** true once the first `snapshot` arrived on this connection */
  hydrated: boolean
  wsStatus: WsStatus
}

export const initialLiveState: LiveState = {
  devices: {},
  sessions: {},
  sessionEvents: {},
  hydrated: false,
  wsStatus: 'closed',
}

const MAX_SESSIONS_KEPT = 300
const MAX_EVENTS_PER_SESSION = 500
const MAX_EVENT_SESSIONS = 20
let liveEventSeq = -1

/** Pure reducer applying one console message to the live state (unit tested). */
export function reduceLive(state: LiveState, msg: ConsoleToUi): LiveState {
  switch (msg.type) {
    case 'snapshot': {
      const devices: Record<string, DeviceSummary> = {}
      for (const d of msg.devices) devices[d.id] = d
      const sessions: Record<string, SessionSummary> = {}
      for (const s of msg.sessions) sessions[s.id] = s
      return { ...state, devices, sessions, hydrated: true }
    }
    case 'device_update':
      return { ...state, devices: { ...state.devices, [msg.device.id]: msg.device } }
    case 'device_removed': {
      if (!(msg.device_id in state.devices)) return state
      const devices = { ...state.devices }
      delete devices[msg.device_id]
      return { ...state, devices }
    }
    case 'session_update': {
      const sessions = { ...state.sessions, [msg.session.id]: msg.session }
      const ids = Object.keys(sessions)
      if (ids.length > MAX_SESSIONS_KEPT) {
        // keep active ones and the most recent history
        const sorted = ids
          .map((id) => sessions[id]!)
          .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
        const keep = new Set(sorted.filter((s) => s.state !== 'ended').map((s) => s.id))
        for (const s of sorted) {
          if (keep.size >= MAX_SESSIONS_KEPT) break
          keep.add(s.id)
        }
        for (const id of ids) if (!keep.has(id)) delete sessions[id]
      }
      return { ...state, sessions }
    }
    case 'session_event': {
      // Live rows get negative ids so they never collide with persisted ones.
      const row: SessionEventRow = { id: liveEventSeq--, session_id: msg.session_id, ts: msg.ts, event: msg.event }
      const list = [...(state.sessionEvents[msg.session_id] ?? []), row].slice(-MAX_EVENTS_PER_SESSION)
      const sessionEvents = { ...state.sessionEvents, [msg.session_id]: list }
      const keys = Object.keys(sessionEvents)
      if (keys.length > MAX_EVENT_SESSIONS) for (const k of keys.slice(0, keys.length - MAX_EVENT_SESSIONS)) delete sessionEvents[k]
      return { ...state, sessionEvents }
    }
    default:
      return state
  }
}

interface LiveStore extends LiveState {
  apply: (msg: ConsoleToUi) => void
  setWsStatus: (s: WsStatus) => void
  /** REST fallback before the socket delivers its snapshot */
  seedDevices: (devices: DeviceSummary[]) => void
  reset: () => void
}

export const useLive = create<LiveStore>((set) => ({
  ...initialLiveState,
  apply: (msg) => set((s) => reduceLive(s, msg)),
  setWsStatus: (wsStatus) =>
    set((s) => (wsStatus === 'open' ? { wsStatus } : { wsStatus, hydrated: s.hydrated && wsStatus !== 'closed' })),
  seedDevices: (list) =>
    set((s) => {
      if (s.hydrated) return s
      const devices = { ...s.devices }
      for (const d of list) devices[d.id] = d
      return { devices }
    }),
  reset: () => set({ ...initialLiveState }),
}))

/**
 * Derive lists outside the selector (e.g. `useMemo(() => Object.values(map), [map])`).
 * Selectors passed to `useLive` must return referentially stable values — a fresh array per
 * call trips React's `useSyncExternalStore` into an infinite update loop (React error #185).
 */
export const selectDeviceMap = (s: LiveState) => s.devices
export const selectSessionMap = (s: LiveState) => s.sessions
