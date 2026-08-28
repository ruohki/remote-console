import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, errorMessage } from '@/lib/api'
import type { AuditEntry } from '@/lib/types'
import { Button, EmptyState, PageHeader, Skeleton, Table, Td, Th } from '@/components/ui'
import { dateTime } from '@/lib/format'

const PAGE = 100

export function Audit() {
  const [pages, setPages] = useState<AuditEntry[][]>([])
  const before = pages.at(-1)?.at(-1)?.id
  const q = useQuery({
    queryKey: ['audit', before],
    queryFn: () => api.get<AuditEntry[]>('/api/audit', { limit: PAGE, before }),
    // append each page once it arrives
    select: (rows) => rows,
  })

  const rows = [...pages.flat(), ...(q.data && !pages.some((p) => p === q.data) ? q.data : [])]
  const canLoadMore = (q.data?.length ?? 0) === PAGE

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Audit log" subtitle="Who did what, newest first." />
      {q.isPending && rows.length === 0 ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <div className="panel">
          <EmptyState title="Could not load the audit log" detail={errorMessage(q.error)} />
        </div>
      ) : rows.length === 0 ? (
        <div className="panel">
          <EmptyState title="Nothing logged yet" />
        </div>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th className="w-44">When</Th>
                <Th>Who</Th>
                <Th>Action</Th>
                <Th className="hidden md:table-cell">Target</Th>
                <Th className="hidden lg:table-cell">Details</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="row-hover">
                  <Td className="mono text-ink-muted">{dateTime(r.ts)}</Td>
                  <Td>{r.user_name ?? <span className="text-ink-faint">system</span>}</Td>
                  <Td className="mono">{r.action}</Td>
                  <Td className="mono hidden md:table-cell text-ink-muted">{r.target ?? ''}</Td>
                  <Td className="mono hidden max-w-md truncate lg:table-cell text-ink-faint" >
                    {r.details === null || r.details === undefined ? '' : typeof r.details === 'string' ? r.details : JSON.stringify(r.details)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {canLoadMore && (
            <div className="mt-3 flex justify-center">
              <Button onClick={() => q.data && setPages((p) => [...p, q.data])} loading={q.isFetching}>
                Load older entries
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
