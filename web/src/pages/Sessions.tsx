import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Square } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import type { SessionSummary } from '@/protocol'
import { useLive } from '@/store/live'
import { useAuth } from '@/store/auth'
import { Button, EmptyState, PageHeader, Select, Skeleton, Table, Td, Th } from '@/components/ui'
import { CodecBadge, SessionStateBadge } from '@/components/badges'
import { dateTime, duration, END_REASON_LABEL } from '@/lib/format'
import { toast } from '@/lib/toast'
import { useNow } from '@/hooks/useNow'

export function Sessions() {
  const { user } = useAuth()
  const live = useLive((s) => s.sessions)
  const [scope, setScope] = useState<'active' | 'all'>('active')
  const qc = useQueryClient()

  const history = useQuery({
    queryKey: ['sessions', scope],
    queryFn: () => api.get<SessionSummary[]>('/api/sessions', scope === 'active' ? { active: 1, limit: 200 } : { limit: 200 }),
  })

  const rows = useMemo(() => {
    const map = new Map<string, SessionSummary>()
    for (const s of history.data ?? []) map.set(s.id, s)
    for (const s of Object.values(live)) map.set(s.id, s) // live wins
    return Array.from(map.values())
      .filter((s) => (scope === 'active' ? s.state !== 'ended' : true))
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
  }, [history.data, live, scope])

  const end = useMutation({
    mutationFn: (id: string) => api.post(`/api/sessions/${id}/end`),
    onSuccess: () => {
      toast.success('Session ended')
      qc.invalidateQueries({ queryKey: ['sessions'] })
    },
    onError: (e) => toast.error('Could not end the session', errorMessage(e)),
  })

  const now = useNow(1000) // running durations tick every second

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Sessions"
        subtitle="Every remote control session, live and past."
        actions={
          <Select value={scope} onChange={(e) => setScope(e.target.value as 'active' | 'all')} className="w-36">
            <option value="active">Active only</option>
            <option value="all">All</option>
          </Select>
        }
      />
      {history.isPending && rows.length === 0 ? (
        <Skeleton className="h-40 w-full" />
      ) : rows.length === 0 ? (
        <div className="panel">
          <EmptyState title={scope === 'active' ? 'No active sessions' : 'No sessions yet'} detail="Connect to a device to start one." />
        </div>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>State</Th>
              <Th>Device</Th>
              <Th>Operator</Th>
              <Th className="hidden md:table-cell">Started</Th>
              <Th>Duration</Th>
              <Th className="hidden sm:table-cell">Codec</Th>
              <Th className="hidden lg:table-cell">Outcome</Th>
              <Th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const mine = s.operator_id === user?.id
              const canEnd = s.state !== 'ended' && (mine || user?.role === 'admin')
              return (
                <tr key={s.id} className="row-hover">
                  <Td>
                    <SessionStateBadge state={s.state} />
                  </Td>
                  <Td>
                    <Link to={`/devices/${s.device_id}`} className="font-medium hover:underline">
                      {s.device_name}
                    </Link>
                  </Td>
                  <Td>{s.operator_name}</Td>
                  <Td className="hidden md:table-cell text-ink-muted">{dateTime(s.started_at)}</Td>
                  <Td className="mono">{duration(s.connected_at ?? s.started_at, s.ended_at, now)}</Td>
                  <Td className="hidden sm:table-cell">
                    <CodecBadge codec={s.codec} />
                  </Td>
                  <Td className="hidden lg:table-cell text-ink-muted">{s.end_reason ? END_REASON_LABEL[s.end_reason] : s.state === 'ended' ? '—' : ''}</Td>
                  <Td className="text-right">
                    {canEnd && (
                      <Button size="sm" variant="danger" icon={<Square size={12} />} onClick={() => end.mutate(s.id)} loading={end.isPending && end.variables === s.id}>
                        End
                      </Button>
                    )}
                    {s.state === 'connected' && mine && (
                      <Link to={`/viewer/${s.device_id}`} className="ml-2 text-accent hover:underline">
                        Open
                      </Link>
                    )}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </Table>
      )}
    </div>
  )
}
