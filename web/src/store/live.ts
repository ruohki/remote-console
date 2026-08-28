import { create } from 'zustand'
import type { ConsoleToUi, DeviceSummary, SessionSummary } from '@/protocol'
import type { WsStatus } from '@/lib/ws'

export interface LiveState {
  devices: Record<string, DeviceSummary>
  sessions: Record<string, SessionSummary>
  /** true once the first `snapshot` arrived on this connection */
  hydrated: boolean
  wsStatus: WsStatus
}

export const initialLiveState: LiveState = {
  devices: {},
  sessions: {},
  hydrated: false,
  wsStatus: 'closed',
}

const MAX_SESSIONS_KEPT = 300

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
