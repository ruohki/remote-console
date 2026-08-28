import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Square } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import type { SessionSummary } from '@/protocol'
import { useLive } from '@/store/live'
import { useAuth } from '@/store/auth'
import { Button, ConfirmDialog, EmptyState, PageHeader, Select, Skeleton, Table, Td, Th } from '@/components/ui'
import { Pager } from '@/components/Pager'
import { CodecBadge, SessionStateBadge } from '@/components/badges'
import { dateTime, duration, END_REASON_LABEL } from '@/lib/format'
import { firstPage, goNext, goPrev, isLastPage, pageNumber, timeCursor, type PageState } from '@/lib/paging'
import { toast } from '@/lib/toast'
import { useNow } from '@/hooks/useNow'
import { SessionDetailDialog } from '@/components/SessionDetailDialog'

const PAGE = 25

export function Sessions() {
  const { user } = useAuth()
  const live = useLive((s) => s.sessions)
  const [scope, setScope] = useState<'active' | 'all'>('active')
  const [pg, setPg] = useState<PageState<string>>(firstPage<string>())
  const [openSession, setOpenSession] = useState<SessionSummary | null>(null)
  const [ending, setEnding] = useState<SessionSummary | null>(null)
  const qc = useQueryClient()

  const history = useQuery({
    queryKey: ['sessions', scope, pg.current ?? null],
    queryFn: () =>
      api.get<SessionSummary[]>('/api/sessions', scope === 'active' ? { active: 1, limit: PAGE, before: pg.current } : { limit: PAGE, before: pg.current }),
    placeholderData: keepPreviousData,
  })

  const page = useMemo(() => history.data ?? [], [history.data])
  const firstPageShown = pg.stack.length === 0
  const hasNext = history.isSuccess && !isLastPage(page.length, PAGE)

  // Live sessions are pinned on top of the first page only; later pages are pure history.
  const rows = useMemo(() => {
    const map = new Map<string, SessionSummary>()
    for (const s of page) map.set(s.id, s)
    if (firstPageShown) for (const s of Object.values(live)) if (s.state !== 'ended' || map.has(s.id)) map.set(s.id, s) // live wins
    return Array.from(map.values())
      .filter((s) => (scope === 'active' ? s.state !== 'ended' : true))
      .sort((a, b) => Number(b.state !== 'ended') - Number(a.state !== 'ended') || Date.parse(b.started_at) - Date.parse(a.started_at))
  }, [page, live, scope, firstPageShown])

  const end = useMutation({
    mutationFn: (id: string) => api.post(`/api/sessions/${id}/end`),
    onSuccess: () => {
      toast.success('Session ended')
      setEnding(null)
      qc.invalidateQueries({ queryKey: ['sessions'] })
    },
    onError: (e) => toast.error('Could not end the session', errorMessage(e)),
  })

  const now = useNow(1000) // running durations tick every second

  const changeScope = (s: 'active' | 'all') => {
    setScope(s)
    setPg(firstPage<string>())
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Sessions"
        subtitle={`Every remote control session, live and past · ${PAGE} per page.`}
        actions={
          <Select
            value={scope}
            onChange={changeScope}
            className="w-36"
            aria-label="Filter sessions"
            options={[
              { value: 'active', label: 'Active only' },
              { value: 'all', label: 'All' },
            ]}
          />
        }
      />
      {history.isPending && rows.length === 0 ? (
        <Skeleton className="h-40 w-full" />
      ) : history.isError ? (
        <div className="panel">
          <EmptyState title="Could not load sessions" detail={errorMessage(history.error)} />
        </div>
      ) : rows.length === 0 && firstPageShown ? (
        <div className="panel">
          <EmptyState title={scope === 'active' ? 'No active sessions' : 'No sessions yet'} detail="Connect to a device to start one." />
        </div>
      ) : (
        <>
          <Table className={history.isFetching ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
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
                  <tr key={s.id} className="row-hover cursor-pointer" onClick={() => setOpenSession(s)}>
                    <Td>
                      <SessionStateBadge state={s.state} />
                    </Td>
                    <Td>
                      <Link to={`/devices/${s.device_id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                        {s.device_name}
                      </Link>
                    </Td>
                    <Td>
                      {s.operator_name}
                      {s.role === 'observer' && <span className="ml-1 text-[11px] text-ink-faint">(observer)</span>}
                    </Td>
                    <Td className="hidden md:table-cell text-ink-muted">{dateTime(s.started_at)}</Td>
                    <Td className="mono">{duration(s.connected_at ?? s.started_at, s.ended_at, now)}</Td>
                    <Td className="hidden sm:table-cell">
                      <CodecBadge codec={s.codec} />
                    </Td>
                    <Td className="hidden lg:table-cell text-ink-muted">{s.end_reason ? END_REASON_LABEL[s.end_reason] : s.state === 'ended' ? '—' : ''}</Td>
                    <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                      {canEnd && (
                        <Button size="sm" variant="danger" icon={<Square size={12} />} onClick={() => setEnding(s)}>
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
              {rows.length === 0 && (
                <tr>
                  <Td colSpan={8} className="py-6 text-center text-ink-faint">
                    No more sessions.
                  </Td>
                </tr>
              )}
            </tbody>
          </Table>
          <Pager
            page={pageNumber(pg)}
            rows={rows.length}
            pageSize={PAGE}
            hasPrev={!firstPageShown}
            hasNext={hasNext}
            loading={history.isFetching}
            onPrev={() => setPg(goPrev)}
            onNext={() => {
              const c = timeCursor(page)
              if (c !== undefined) setPg((s) => goNext(s, c))
            }}
          />
        </>
      )}
      <SessionDetailDialog session={openSession} open={!!openSession} onClose={() => setOpenSession(null)} />
      <ConfirmDialog
        open={!!ending}
        onClose={() => setEnding(null)}
        onConfirm={() => ending && end.mutate(ending.id)}
        title="End this session?"
        body={
          <>
            <b>{ending?.operator_name}</b> is disconnected from <b>{ending?.device_name}</b> immediately. They can reconnect if they still have access.
          </>
        }
        confirmLabel="End session"
        danger
        loading={end.isPending}
      />
    </div>
  )
}
