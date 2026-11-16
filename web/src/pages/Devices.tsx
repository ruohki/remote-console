import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CircleArrowUp, Eye, FolderKanban, MonitorPlay, Plus, Search } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import type { DeviceSummary } from '@/protocol'
import type { BulkUpdateRequested } from '@/lib/types'
import { useLive } from '@/store/live'
import { Button, ConfirmDialog, EmptyState, Input, PageHeader, Skeleton, Table, Td, Th, cx } from '@/components/ui'
import { DesktopBadge, GroupChips, ModeBadge, OsIcon, OverrideBadge, StatusLed, Tags, UpdateBadge } from '@/components/badges'
import { useAgentVersions } from '@/hooks/useAgentVersions'
import { availableUpdate } from '@/lib/agentUpdate'
import { toast } from '@/lib/toast'
import { Pager } from '@/components/Pager'
import { slicePage } from '@/lib/paging'
import { useAuth } from '@/store/auth'
import { canConnect } from '@/lib/access'
import { AddDeviceDialog } from '@/components/AddDeviceDialog'
import { relativeTime, OS_LABEL } from '@/lib/format'

type Filter = 'all' | 'online' | 'offline'

/** Devices per page once the list grows beyond one page. */
const DEVICE_PAGE = 100

export function Devices() {
  // Select the stable map and derive the list; a selector returning a fresh array would
  // re-render endlessly under useSyncExternalStore.
  const deviceMap = useLive((s) => s.devices)
  const devices = useMemo(() => Object.values(deviceMap), [deviceMap])
  const hydrated = useLive((s) => s.hydrated)
  const seed = useLive((s) => s.seedDevices)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [tag, setTag] = useState<string | null>(null)
  const [group, setGroup] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  // Page is remembered together with the filter key it belongs to, so changing a filter
  // implicitly returns to page 1 without an effect.
  const [pageState, setPageState] = useState<{ key: string; page: number }>({ key: '', page: 1 })
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const versions = useAgentVersions()
  const [confirmUpdate, setConfirmUpdate] = useState(false)

  // REST fallback until the socket delivers its snapshot.
  const fallback = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<DeviceSummary[]>('/api/devices'),
    enabled: !hydrated,
  })
  useEffect(() => {
    if (fallback.data) seed(fallback.data)
  }, [fallback.data, seed])

  const allTags = useMemo(() => Array.from(new Set(devices.flatMap((d) => d.tags))).sort(), [devices])
  const allGroups = useMemo(() => {
    const m = new Map<string, string>()
    for (const d of devices) for (const g of d.groups) m.set(g.id, g.name)
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [devices])

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return devices
      .filter((d) => (filter === 'all' ? true : filter === 'online' ? d.online : !d.online))
      .filter((d) => (tag ? d.tags.includes(tag) : true))
      .filter((d) => (group ? d.groups.some((g) => g.id === group) : true))
      .filter((d) =>
        needle
          ? [d.name, d.hostname, d.logged_in_user ?? '', d.last_ip ?? '', ...d.tags].some((s) => s.toLowerCase().includes(needle))
          : true,
      )
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
  }, [devices, q, filter, tag, group])

  const filterKey = `${q}|${filter}|${tag ?? ''}|${group ?? ''}`
  const page = pageState.key === filterKey ? pageState.page : 1
  const setPage = (f: (p: number) => number) => setPageState({ key: filterKey, page: f(page) })
  const paged = useMemo(() => slicePage(list, page, DEVICE_PAGE), [list, page])

  const loading = !hydrated && fallback.isPending && devices.length === 0
  const onlineCount = devices.filter((d) => d.online).length

  // Bulk update: online, outdated devices the admin manages (within the group filter).
  const outdated = useMemo(
    () => devices.filter((d) => d.online && (group ? d.groups.some((g) => g.id === group) : true) && availableUpdate(d, versions.data)),
    [devices, group, versions.data],
  )
  const groupName = group ? allGroups.find((g) => g.id === group)?.name : undefined
  const bulkUpdate = useMutation({
    mutationFn: () => api.post<BulkUpdateRequested>('/api/devices/update-outdated', group ? { group_id: group } : {}),
    onSuccess: (r) => {
      setConfirmUpdate(false)
      const old = r.skipped.agent_too_old ?? 0
      const detail = old > 0 ? `${old} older agent${old === 1 ? ' needs' : 's need'} a reinstall` : undefined
      if (r.requested.length === 0) toast.info('No devices to update', detail)
      else toast.success(`Update requested for ${r.requested.length} device${r.requested.length === 1 ? '' : 's'}`, detail)
    },
    onError: (e) => toast.error('Could not request updates', errorMessage(e)),
  })

  return (
    <div className="w-full">
      <PageHeader
        title="Devices"
        subtitle={
          devices.length > 0 ? (
            <span className="inline-flex items-center gap-2">
              <span className={cx('led', onlineCount > 0 ? 'led-live' : 'led-off')} aria-hidden />
              {onlineCount} of {devices.length} online
            </span>
          ) : (
            'Machines running the agent appear here as soon as they enroll.'
          )
        }
        actions={
          isAdmin && (
            <>
              {outdated.length > 0 && (
                <Button icon={<CircleArrowUp size={14} />} onClick={() => setConfirmUpdate(true)} title="Update agents on online devices that run an older version">
                  Update outdated
                  <span className="mono rounded-sm bg-accent-soft px-1 text-[11px] text-accent">{outdated.length}</span>
                </Button>
              )}
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
                Add device
              </Button>
            </>
          )
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint" />
          <Input data-search placeholder="Search name, host, user, IP, tag" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8 pr-8" />
          <span aria-hidden className="kbd pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 sm:inline-flex">
            /
          </span>
        </div>
        <div className="flex rounded-md border border-line-strong p-0.5">
          {(['all', 'online', 'offline'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cx('rounded-sm px-2.5 py-1 text-[12.5px] capitalize', filter === f ? 'bg-raised text-ink font-medium' : 'text-ink-muted hover:text-ink')}
            >
              {f}
            </button>
          ))}
        </div>
        {allGroups.length > 0 && (
          <div className="flex flex-wrap items-center gap-1" aria-label="Filter by group">
            {allGroups.map((g) => (
              <button
                key={g.id}
                onClick={() => setGroup(group === g.id ? null : g.id)}
                className={cx(
                  'rounded-sm border px-1.5 py-px text-[11.5px]',
                  group === g.id ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-muted hover:text-ink',
                )}
              >
                <FolderKanban size={10} className="mr-1 inline-block align-[-1px]" />
                {g.name}
              </button>
            ))}
          </div>
        )}
        {allTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {allTags.map((t) => (
              <button
                key={t}
                onClick={() => setTag(tag === t ? null : t)}
                className={cx(
                  'rounded-sm border px-1.5 py-px text-[11.5px]',
                  tag === t ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-muted hover:text-ink',
                )}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading ? (
        <div className="panel divide-y divide-line">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-3">
              <Skeleton className="size-2 rounded-full" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="ml-auto h-4 w-24" />
            </div>
          ))}
        </div>
      ) : devices.length === 0 ? (
        <div className="panel">
          {isAdmin ? (
            <EmptyState
              title="No devices yet"
              detail="Add a device to get started."
              action={
                <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
                  Add device
                </Button>
              }
            />
          ) : (
            <EmptyState title="No devices available to you" detail="No device-group access yet." />
          )}
        </div>
      ) : list.length === 0 ? (
        <div className="panel">
          <EmptyState title="Nothing matches" detail="No matches." />
        </div>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th className="w-6" />
              <Th>Device</Th>
              <Th className="hidden md:table-cell">User</Th>
              <Th className="hidden lg:table-cell">Groups &amp; tags</Th>
              <Th className="hidden sm:table-cell">Mode</Th>
              <Th className="hidden sm:table-cell">Last seen</Th>
              <Th className="text-right">
                <span className="sr-only">Connect</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {paged.rows.map((d) => (
              <tr
                key={d.id}
                className="row-hover cursor-pointer"
                onClick={() => navigate(`/devices/${d.id}`)}
                onKeyDown={(e) => e.key === 'Enter' && navigate(`/devices/${d.id}`)}
                tabIndex={0}
              >
                <Td>
                  <StatusLed device={d} />
                </Td>
                {/* w-full + max-w-0: the device column takes the free width and truncates
                    instead of pushing the table wider than the screen */}
                <Td className="w-full max-w-0">
                  <div className="flex items-center gap-2">
                    <OsIcon os={d.os} />
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium">{d.name}</span>
                        <DesktopBadge device={d} />
                        <UpdateBadge version={availableUpdate(d, versions.data)} />
                      </div>
                      <div className="flex min-w-0 items-center gap-2.5 text-[12px] text-ink-faint">
                        {d.hostname && d.hostname.toLowerCase() !== d.name.toLowerCase() && <span className="mono truncate">{d.hostname}</span>}
                        <span className="shrink-0">
                          {OS_LABEL[d.os]} {d.arch === 'aarch64' ? 'arm64' : 'x64'}
                        </span>
                        <span className="mono shrink-0">v{d.agent_version}</span>
                        <span className="shrink-0 sm:hidden">{d.online ? 'Online' : relativeTime(d.last_seen_at)}</span>
                      </div>
                    </div>
                  </div>
                </Td>
                <Td className="hidden md:table-cell">
                  <span className={d.logged_in_user ? '' : 'text-ink-faint'}>{d.logged_in_user ?? '—'}</span>
                </Td>
                <Td className="hidden lg:table-cell">
                  <div className="flex flex-wrap items-center gap-1">
                    <GroupChips groups={d.groups} />
                    <Tags tags={d.tags} />
                  </div>
                </Td>
                <Td className="hidden sm:table-cell">
                  <div className="flex items-center gap-1 whitespace-nowrap">
                    <ModeBadge mode={d.mode} />
                    <OverrideBadge overrides={d.local_overrides} />
                  </div>
                </Td>
                <Td className="hidden whitespace-nowrap text-ink-muted sm:table-cell">{d.online ? 'now' : relativeTime(d.last_seen_at)}</Td>
                <Td className="text-right whitespace-nowrap">
                  {canConnect(d, user) ? (
                    <Link to={`/viewer/${d.id}`} onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="sm"
                        variant={d.online ? 'primary' : 'secondary'}
                        disabled={!d.online}
                        icon={<MonitorPlay size={13} />}
                        aria-label={d.active_session_id ? 'Join' : 'Connect'}
                      >
                        <span className="max-sm:hidden">{d.active_session_id ? 'Join' : 'Connect'}</span>
                      </Button>
                    </Link>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[12px] text-ink-faint" title="View only">
                      <Eye size={12} /> <span className="max-sm:hidden">View only</span>
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {list.length > DEVICE_PAGE && (
        <Pager
          page={paged.page}
          rows={paged.rows.length}
          pageSize={DEVICE_PAGE}
          total={list.length}
          hasPrev={paged.page > 1}
          hasNext={paged.page < paged.pages}
          onPrev={() => setPage((p) => p - 1)}
          onNext={() => setPage((p) => p + 1)}
        />
      )}

      <AddDeviceDialog open={adding} onClose={() => setAdding(false)} />
      <ConfirmDialog
        open={confirmUpdate}
        onClose={() => setConfirmUpdate(false)}
        onConfirm={() => bulkUpdate.mutate()}
        title="Update outdated agents?"
        confirmLabel="Update"
        loading={bulkUpdate.isPending}
        body={
          <div className="flex flex-col gap-2">
            <p>
              {outdated.length} online device{outdated.length === 1 ? '' : 's'}
              {groupName ? ` in ${groupName}` : ''} get the console's agent version and restart. Active sessions end.
            </p>
            <p className="text-[12.5px] text-ink-faint">Sent in batches. Older agents need a reinstall.</p>
          </div>
        }
      />
    </div>
  )
}
