import { useState } from 'react'
import { Link } from 'react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, errorMessage } from '@/lib/api'
import type { AuditEntry } from '@/lib/types'
import { Badge, CopyButton, Dialog, EmptyState, PageHeader, Skeleton, Table, Td, Th } from '@/components/ui'
import { Pager } from '@/components/Pager'
import { dateTime, relativeTime } from '@/lib/format'
import { useNow } from '@/hooks/useNow'
import { firstPage, goNext, goPrev, idCursor, isLastPage, pageNumber, type PageState } from '@/lib/paging'

const PAGE = 25

export function Audit() {
  const [pg, setPg] = useState<PageState<string>>(firstPage<string>())
  const [openEntry, setOpenEntry] = useState<AuditEntry | null>(null)
  const now = useNow(30_000)
  const q = useQuery({
    queryKey: ['audit', pg.current ?? null],
    queryFn: () => api.get<AuditEntry[]>('/api/audit', { limit: PAGE, before: pg.current }),
    placeholderData: keepPreviousData,
  })
  const rows = q.data ?? []
  const hasNext = q.isSuccess && !isLastPage(rows.length, PAGE)

  return (
    <div className="w-full">
      <PageHeader title="Audit log" subtitle={`Who did what, newest first · ${PAGE} entries per page · click an entry for the full record.`} />
      {q.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <div className="panel">
          <EmptyState title="Could not load the audit log" detail={errorMessage(q.error)} />
        </div>
      ) : rows.length === 0 && pageNumber(pg) === 1 ? (
        <div className="panel">
          <EmptyState title="Nothing logged yet" />
        </div>
      ) : (
        <>
          <Table fixed className={q.isFetching ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
            <colgroup>
              <col className="w-[120px]" />
              <col className="w-[180px]" />
              <col className="w-[220px]" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Actor</Th>
                <Th>Action</Th>
                <Th>Target</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="row-hover cursor-pointer"
                  tabIndex={0}
                  onClick={() => setOpenEntry(r)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setOpenEntry(r)
                    }
                  }}
                >
                  <Td className="whitespace-nowrap text-ink-muted" title={dateTime(r.ts)}>
                    {relativeTime(r.ts, now)}
                  </Td>
                  <Td className="truncate">
                    <Actor entry={r} />
                  </Td>
                  <Td>
                    <ActionBadge action={r.action} />
                  </Td>
                  <Td className="mono max-w-0 truncate text-ink-muted" title={r.target ?? ''}>
                    {r.target ? shortTarget(r.target) : <span className="text-ink-faint">—</span>}
                  </Td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <Td colSpan={4} className="py-6 text-center text-ink-faint">
                    No more entries.
                  </Td>
                </tr>
              )}
            </tbody>
          </Table>
          <Pager
            page={pageNumber(pg)}
            rows={rows.length}
            pageSize={PAGE}
            hasPrev={pg.stack.length > 0}
            hasNext={hasNext}
            loading={q.isFetching}
            onPrev={() => setPg(goPrev)}
            onNext={() => {
              const c = idCursor(rows)
              if (c !== undefined) setPg((s) => goNext(s, c))
            }}
          />
        </>
      )}
      <AuditDetailDialog entry={openEntry} onClose={() => setOpenEntry(null)} />
    </div>
  )
}

/* ───────────── cells ───────────── */

function actorLabel(r: AuditEntry): string {
  if (r.user_name) return r.user_name
  return r.action === 'enroll' || r.action.startsWith('session.') ? 'agent' : 'system'
}

function Actor({ entry }: { entry: AuditEntry }) {
  const label = actorLabel(entry)
  return <span className={entry.user_name ? '' : 'text-ink-faint'}>{label}</span>
}

function actionTone(action: string): 'neutral' | 'accent' | 'live' | 'warn' | 'danger' {
  const verb = action.split('.').pop() ?? action
  if (/delete|revoke|deny|failed|remove/.test(verb)) return 'danger'
  if (/create|enroll|approve|start|bake/.test(verb)) return 'live'
  if (/login_failed/.test(action)) return 'warn'
  if (/update|config|members|grants|groups|end|transfer|clipboard|shadow/.test(verb)) return 'accent'
  return 'neutral'
}

function ActionBadge({ action }: { action: string }) {
  return (
    <Badge tone={actionTone(action)} className="mono whitespace-nowrap">
      {action}
    </Badge>
  )
}

/** Ids are long; show the prefix and the first characters, the full value is in the title. */
function shortTarget(t: string): string {
  return t.length > 28 ? `${t.slice(0, 26)}…` : t
}

/** Where a target id points to in the console, when it has a page. */
function targetLink(t: string | undefined): { to: string; label: string } | null {
  if (!t) return null
  if (t.startsWith('dev_')) return { to: `/devices/${t}`, label: 'Open device' }
  if (t.startsWith('grp_')) return { to: `/groups/${t}`, label: 'Open group' }
  if (t.startsWith('ses_')) return { to: '/sessions', label: 'Sessions' }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(t)) return { to: '/users', label: 'Users' }
  return null
}

/* ───────────── details modal ───────────── */

function AuditDetailDialog({ entry, onClose }: { entry: AuditEntry | null; onClose: () => void }) {
  const details = entry ? prettyDetails(entry.details) : ''
  const link = targetLink(entry?.target)
  return (
    <Dialog open={!!entry} onClose={onClose} title="Audit entry" width="max-w-2xl">
      {entry && (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-[130px_1fr] gap-x-4 gap-y-2 text-[13px]">
            <dt className="text-ink-muted">Timestamp</dt>
            <dd>
              <div>{dateTime(entry.ts)}</div>
              <div className="mono text-[12px] text-ink-faint">{entry.ts}</div>
            </dd>
            <dt className="text-ink-muted">Actor</dt>
            <dd>
              {entry.user_name ? (
                <>
                  <span className="font-medium">{entry.user_name}</span>
                  {entry.user_id && <span className="mono ml-2 text-[12px] text-ink-faint">{entry.user_id}</span>}
                </>
              ) : (
                <span className="text-ink-faint">{actorLabel(entry)}</span>
              )}
            </dd>
            <dt className="text-ink-muted">Action</dt>
            <dd>
              <ActionBadge action={entry.action} />
            </dd>
            <dt className="text-ink-muted">Target</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-2">
              {entry.target ? <span className="mono break-all">{entry.target}</span> : <span className="text-ink-faint">—</span>}
              {link && (
                <Link to={link.to} className="text-accent hover:underline" onClick={onClose}>
                  {link.label} →
                </Link>
              )}
            </dd>
            <dt className="text-ink-muted">Entry id</dt>
            <dd className="mono text-ink-faint">{entry.id}</dd>
          </dl>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="eyebrow">Details</span>
              {details && <CopyButton text={details} label="Copy JSON" />}
            </div>
            {details ? (
              <pre className="mono max-h-[45vh] overflow-auto rounded-md border border-line bg-raised p-3 text-[12px] leading-relaxed whitespace-pre">{details}</pre>
            ) : (
              <div className="rounded-md border border-line bg-raised px-3 py-2 text-ink-faint">No details recorded.</div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  )
}

function prettyDetails(d: unknown): string {
  if (d === null || d === undefined || d === '') return ''
  if (typeof d === 'string') {
    try {
      return JSON.stringify(JSON.parse(d), null, 2)
    } catch {
      return d
    }
  }
  return JSON.stringify(d, null, 2)
}
