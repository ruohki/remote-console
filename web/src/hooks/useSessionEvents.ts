import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useLive, type SessionEventRow } from '@/store/live'

/**
 * Timeline of one session: the persisted rows from `GET /api/sessions/:id/events` merged
 * with the events pushed live on `/ws/ui` since this page connected (deduplicated by
 * timestamp + payload, since live rows have no server id yet).
 */
export function useSessionEvents(sessionId: string | null | undefined, opts: { enabled?: boolean } = {}) {
  const enabled = !!sessionId && (opts.enabled ?? true)
  const query = useQuery({
    queryKey: ['session-events', sessionId],
    queryFn: () => api.get<SessionEventRow[]>(`/api/sessions/${sessionId}/events`, { limit: 500 }),
    enabled,
    staleTime: 5_000,
  })
  const live = useLive((s) => (sessionId ? s.sessionEvents[sessionId] : undefined))

  const rows = useMemo(() => {
    const out: SessionEventRow[] = [...(query.data ?? [])]
    const seen = new Set(out.map((r) => `${r.ts}|${JSON.stringify(r.event)}`))
    for (const r of live ?? []) {
      const k = `${r.ts}|${JSON.stringify(r.event)}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(r)
    }
    out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    return out
  }, [query.data, live])

  return { rows, isPending: enabled && query.isPending, error: query.error, refetch: query.refetch }
}
