import { useState } from 'react'

const SESSION_PAGE = 25
import { Link, useNavigate, useParams } from 'react-router'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Eye, FolderKanban, MonitorPlay, Save, Trash2 } from 'lucide-react'
import { api, ApiError, errorMessage } from '@/lib/api'
import type { DeviceDetail as Detail, Group } from '@/lib/types'
import { canConnect } from '@/lib/access'
import type { AgentConfig, SessionSummary } from '@/protocol'
import { useLive } from '@/store/live'
import { useAuth, useIsAdmin } from '@/store/auth'
import { Badge, Button, DangerConfirmDialog, Dialog, EmptyState, Field, Input, PageHeader, Select, Skeleton, Table, Td, Textarea, Th, Toggle, cx } from '@/components/ui'
import { CodecBadge, GroupChips, ModeBadge, OsIcon, OverrideBadge, SessionStateBadge, StatusLed } from '@/components/badges'
import { LoadMore } from '@/components/Pager'
import { appendPage, isLastPage, timeCursor } from '@/lib/paging'
import { hasOverrides, overrideLabels } from '@/lib/overrides'
import { ShieldAlert } from 'lucide-react'
import { NotFound } from './NotFound'
import { dateTime, duration, END_REASON_LABEL, OS_LABEL, relativeTime, CODEC_LABEL } from '@/lib/format'
import { toast } from '@/lib/toast'
import { SessionDetailDialog } from '@/components/SessionDetailDialog'

export function DeviceDetail() {
  const { id = '' } = useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const isAdmin = useIsAdmin()
  const { user } = useAuth()
  const live = useLive((s) => s.devices[id])
  const [editingGroups, setEditingGroups] = useState(false)

  const detail = useQuery({
    queryKey: ['device', id],
    queryFn: () => api.get<Detail>(`/api/devices/${id}`),
    retry: false,
  })
  const [openSession, setOpenSession] = useState<SessionSummary | null>(null)
  // Session history: first page plus one query per "load older" cursor (no effects needed).
  const [cursors, setCursors] = useState<string[]>([])
  const sessions = useQuery({
    queryKey: ['device-sessions', id],
    queryFn: () => api.get<SessionSummary[]>(`/api/devices/${id}/sessions`, { limit: SESSION_PAGE }),
  })
  const olderQueries = useQueries({
    queries: cursors.map((before) => ({
      queryKey: ['device-sessions', id, before],
      queryFn: () => api.get<SessionSummary[]>(`/api/devices/${id}/sessions`, { limit: SESSION_PAGE, before }),
    })),
  })
  let sessionRows: SessionSummary[] = sessions.data ?? []
  for (const q of olderQueries) if (q.data) sessionRows = appendPage(sessionRows, q.data)
  const lastLoaded = olderQueries.length ? olderQueries.at(-1)?.data : sessions.data
  const moreSessions = !!lastLoaded && !isLastPage(lastLoaded.length, SESSION_PAGE)
  const olderLoading = olderQueries.some((q) => q.isFetching)

  const [deleting, setDeleting] = useState(false)
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/devices/${id}`),
    onSuccess: () => {
      toast.success('Device removed')
      navigate('/devices')
    },
    onError: (e) => toast.error('Could not remove the device', errorMessage(e)),
  })

  if (detail.isError && detail.error instanceof ApiError && detail.error.status === 404) return <NotFound />
  if (detail.isPending) {
    return (
      <div className="mx-auto max-w-5xl">
        <Skeleton className="mb-4 h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (detail.isError) {
    return (
      <div className="panel mx-auto max-w-5xl">
        <EmptyState title="Could not load this device" detail={errorMessage(detail.error)} />
      </div>
    )
  }

  // Live fields win over the fetched snapshot.
  const d: Detail = { ...detail.data, ...(live ?? {}) }
  const mayConnect = canConnect(d, user)

  return (
    <div className="mx-auto max-w-5xl">
      <Link to="/devices" className="mb-3 inline-flex items-center gap-1 text-ink-muted hover:text-ink">
        <ArrowLeft size={14} /> Devices
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <StatusLed device={d} className="size-2.5" />
            {d.name}
          </span>
        }
        subtitle={
          <span className="mono">
            {d.hostname} · {OS_LABEL[d.os]} {d.arch === 'aarch64' ? 'arm64' : 'x64'} · agent v{d.agent_version} · {d.id}
          </span>
        }
        actions={
          <>
            {isAdmin && (
              <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => setDeleting(true)}>
                Remove
              </Button>
            )}
            {mayConnect ? (
              <Link to={`/viewer/${d.id}`}>
                <Button variant="primary" icon={<MonitorPlay size={14} />} disabled={!d.online}>
                  {d.active_session_id ? 'Join session' : 'Connect'}
                </Button>
              </Link>
            ) : (
              <Badge className="h-8 gap-1 px-2.5">
                <Eye size={13} /> View-only access
              </Badge>
            )}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-4">
          <section className="panel">
            <div className="border-b border-line px-4 py-2.5 font-medium">Status</div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 px-4 py-3 sm:grid-cols-3">
              <Item label="State">
                {d.online ? <Badge tone="live">Online</Badge> : <Badge>Offline · {relativeTime(d.last_seen_at)}</Badge>}
              </Item>
              <Item label="Mode">
                <span className="inline-flex flex-wrap items-center gap-1">
                  <ModeBadge mode={d.mode} />
                  <OverrideBadge overrides={d.local_overrides} />
                </span>
              </Item>
              <Item label="Signed-in user">{d.logged_in_user ?? <span className="text-ink-faint">nobody</span>}</Item>
              <Item label="Last IP">
                <span className="mono">{d.last_ip ?? '—'}</span>
              </Item>
              <Item label="Encoders">
                <span className="mono">{d.codecs.length ? d.codecs.map((c) => CODEC_LABEL[c]).join(', ') : '—'}</span>
              </Item>
              <Item label="Enrolled">
                {dateTime(d.created_at)}
                {d.enrolled_with && <span className="text-ink-faint"> via {d.enrolled_with}</span>}
              </Item>
            </dl>
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
              <span className="eyebrow">Groups</span>
              {d.groups.length > 0 ? <GroupChips groups={d.groups} linked={isAdmin} /> : <span className="text-ink-faint">{isAdmin ? 'Not in any group — only admins can see this device.' : 'None'}</span>}
              {isAdmin && (
                <Button size="sm" variant="ghost" icon={<FolderKanban size={13} />} className="ml-auto" onClick={() => setEditingGroups(true)}>
                  Edit groups
                </Button>
              )}
            </div>
            {d.displays.length > 0 && (
              <div className="border-t border-line px-4 py-3">
                <div className="eyebrow mb-2">Displays</div>
                <div className="flex flex-wrap gap-2">
                  {d.displays.map((s) => (
                    <div key={s.index} className="rounded-md border border-line bg-raised px-2.5 py-1.5">
                      <div className="flex items-center gap-2">
                        <OsIcon os={d.os} size={12} />
                        <span className="font-medium">{s.name}</span>
                        {s.primary && <Badge tone="accent">Primary</Badge>}
                      </div>
                      <div className="mono text-ink-faint">
                        {s.width}×{s.height} @{s.scale}x · origin {s.x},{s.y}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* keyed on the saved values so the form resets when fresh data arrives */}
          <MetaForm key={`${d.id}|${d.name}|${d.tags.join(',')}|${d.notes}`} device={d} editable={mayConnect} onSaved={() => qc.invalidateQueries({ queryKey: ['device', id] })} />

          <section className="panel">
            <div className="border-b border-line px-4 py-2.5 font-medium">Recent sessions</div>
            {sessions.isPending ? (
              <Skeleton className="m-4 h-24" />
            ) : sessionRows.length === 0 ? (
              <EmptyState title="No sessions yet" />
            ) : (
              <Table className="rounded-none border-0">
                <thead>
                  <tr>
                    <Th>State</Th>
                    <Th>Operator</Th>
                    <Th>Started</Th>
                    <Th>Duration</Th>
                    <Th>Codec</Th>
                    <Th className="hidden md:table-cell">Outcome</Th>
                  </tr>
                </thead>
                <tbody>
                  {sessionRows.map((s) => (
                    <tr key={s.id} className="row-hover cursor-pointer" onClick={() => setOpenSession(s)}>
                      <Td>
                        <SessionStateBadge state={s.state} />
                      </Td>
                      <Td>{s.operator_name}</Td>
                      <Td className="text-ink-muted">{dateTime(s.started_at)}</Td>
                      <Td className="mono">{duration(s.connected_at ?? s.started_at, s.ended_at)}</Td>
                      <Td>
                        <CodecBadge codec={s.codec} />
                      </Td>
                      <Td className="hidden md:table-cell text-ink-muted">{s.end_reason ? END_REASON_LABEL[s.end_reason] : ''}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {sessionRows.length > 0 && (
              <LoadMore
                shown={sessionRows.length}
                hasMore={moreSessions}
                loading={olderLoading}
                onClick={() => {
                  const c = timeCursor(lastLoaded ?? [])
                  if (c !== undefined && !cursors.includes(c)) setCursors((cs) => [...cs, c])
                }}
                label="Load older sessions"
              />
            )}
          </section>
          <SessionDetailDialog session={openSession} open={!!openSession} onClose={() => setOpenSession(null)} />
        </div>

        <div className="flex flex-col gap-4">
          <RestrictionsPanel device={d} />
          <ConfigForm key={`${d.id}|${JSON.stringify(d.config)}`} device={d} editable={isAdmin} onSaved={() => qc.invalidateQueries({ queryKey: ['device', id] })} />
        </div>
      </div>

      {isAdmin && (
        <GroupsEditor
          open={editingGroups}
          onClose={() => setEditingGroups(false)}
          device={d}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['device', id] })
            qc.invalidateQueries({ queryKey: ['groups'] })
          }}
        />
      )}

      <DangerConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={() => remove.mutate()}
        title="Remove this device?"
        expectedName={d.name}
        confirmLabel="Remove device"
        loading={remove.isPending}
        body={
          <div className="flex flex-col gap-2">
            <div className="rounded-md border border-line bg-raised px-3 py-2">
              <div className="font-medium text-ink">{d.name}</div>
              <div className="mono text-[12px] text-ink-faint">
                {d.hostname} · {d.id}
              </div>
              {d.groups.length > 0 && (
                <div className="mt-1.5">
                  <GroupChips groups={d.groups} />
                </div>
              )}
            </div>
            <ul className="list-disc pl-5 text-[12.5px]">
              <li>The agent receives a goodbye and stops; any running session ends.</li>
              <li>Its enrollment is deleted — the device must be enrolled again with a new token to come back.</li>
              <li>Session history and audit entries for this device are removed with it.</li>
            </ul>
          </div>
        }
      />
    </div>
  )
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="eyebrow mb-0.5">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function GroupsEditor({ open, onClose, device, onSaved }: { open: boolean; onClose: () => void; device: Detail; onSaved: () => void }) {
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api.get<Group[]>('/api/groups'), enabled: open })
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const savedIds = new Set(device.groups.map((g) => g.id))
  const current = selected ?? savedIds
  const save = useMutation({
    mutationFn: () => api.put<Detail>(`/api/devices/${device.id}/groups`, { group_ids: [...current] }),
    onSuccess: () => {
      toast.success('Groups updated')
      setSelected(null)
      onSaved()
      onClose()
    },
    onError: (e) => toast.error('Could not update groups', errorMessage(e)),
  })
  const toggle = (gid: string) => {
    const next = new Set(current)
    if (next.has(gid)) next.delete(gid)
    else next.add(gid)
    setSelected(next)
  }
  return (
    <Dialog open={open} onClose={onClose} title={`Groups for ${device.name}`} width="max-w-md">
      {groups.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : !groups.data?.length ? (
        <EmptyState
          title="No groups yet"
          detail="Create a group first."
          action={
            <Link to="/groups">
              <Button size="sm">Go to groups</Button>
            </Link>
          }
        />
      ) : (
        <ul className="max-h-80 divide-y divide-line overflow-auto rounded-md border border-line">
          {groups.data
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((g) => (
              <li key={g.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-raised">
                  <input type="checkbox" className="accent-accent" checked={current.has(g.id)} onChange={() => toggle(g.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{g.name}</span>
                    {g.description && <span className="block truncate text-ink-faint">{g.description}</span>}
                  </span>
                  <span className="mono text-ink-faint">{g.device_count}</span>
                </label>
              </li>
            ))}
        </ul>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon={<Save size={14} />} disabled={selected === null} loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
    </Dialog>
  )
}

function MetaForm({ device, editable, onSaved }: { device: Detail; editable: boolean; onSaved: () => void }) {
  const [name, setName] = useState(device.name)
  const [tags, setTags] = useState(device.tags.join(', '))
  const [notes, setNotes] = useState(device.notes)
  const save = useMutation({
    mutationFn: () =>
      api.patch<Detail>(`/api/devices/${device.id}`, {
        name: name.trim() || device.hostname,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        notes,
      }),
    onSuccess: () => {
      toast.success('Device saved')
      onSaved()
    },
    onError: (e) => toast.error('Could not save', errorMessage(e)),
  })
  const dirty = name !== device.name || tags !== device.tags.join(', ') || notes !== device.notes

  return (
    <section className="panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="font-medium">Details</span>
        {!editable && <span className="text-[11.5px] text-ink-faint">Connect permission needed to edit</span>}
      </div>
      <form
        className="grid gap-3 px-4 py-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <fieldset disabled={!editable} className="contents">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Tags" hint="Comma separated.">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Location, owner, quirks…" />
          </Field>
        </fieldset>
        {editable && (
          <div className="flex justify-end sm:col-span-2">
            <Button type="submit" variant="primary" icon={<Save size={14} />} disabled={!dirty} loading={save.isPending}>
              Save
            </Button>
          </div>
        )}
      </form>
    </section>
  )
}

function ConfigForm({ device, editable, onSaved }: { device: Detail; editable: boolean; onSaved: () => void }) {
  const [cfg, setCfg] = useState<AgentConfig>(device.config)
  const set = <K extends keyof AgentConfig>(k: K, v: AgentConfig[K]) => setCfg((c) => ({ ...c, [k]: v }))

  const save = useMutation({
    mutationFn: () => api.patch<Detail>(`/api/devices/${device.id}/config`, cfg),
    onSuccess: () => {
      toast.success('Settings saved', device.online ? 'The agent applies them right away.' : 'The agent picks them up when it reconnects.')
      onSaved()
    },
    onError: (e) => toast.error('Could not save settings', errorMessage(e)),
  })
  const dirty = JSON.stringify(cfg) !== JSON.stringify(device.config)

  return (
    <section className={cx('panel', !editable && 'opacity-90')}>
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="font-medium">Agent settings</span>
        {!editable && <span className="text-[11.5px] text-ink-faint">Admins can change these</span>}
      </div>
      <form
        className="flex flex-col gap-3 px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <fieldset disabled={!editable} className="contents">
          <div className="eyebrow">Access</div>
          <div className="rounded-md border border-line bg-raised p-2.5">
            <div className="mb-1.5 font-medium">Access mode</div>
            <div className="flex gap-1">
              {(['unattended', 'help_me'] as const).map((m) => (
                <button
                  type="button"
                  key={m}
                  onClick={() => set('mode', m)}
                  className={cx(
                    'flex-1 rounded-md border px-2 py-1.5 text-left',
                    cfg.mode === m ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-raised',
                  )}
                >
                  <div className="text-[12.5px] font-medium">{m === 'unattended' ? 'Unattended' : 'Help me'}</div>
                  <div className="text-[11.5px] text-ink-muted">{m === 'unattended' ? 'Connect any time' : 'User approves each session'}</div>
                </button>
              ))}
            </div>
          </div>
          {cfg.mode === 'help_me' && (
            <Field label="Approval timeout (seconds)">
              <Input type="number" min={10} max={600} value={cfg.approval_timeout_s} onChange={(e) => set('approval_timeout_s', Number(e.target.value))} />
            </Field>
          )}
          <div className="eyebrow pt-2">Permissions</div>
          <div className="flex flex-col gap-2">
            <Toggle checked={cfg.allow_input} onChange={(v) => set('allow_input', v)} label="Allow mouse and keyboard control" />
            <Toggle checked={cfg.allow_clipboard} onChange={(v) => set('allow_clipboard', v)} label="Allow clipboard sync" />
            <Toggle checked={cfg.allow_file_transfer} onChange={(v) => set('allow_file_transfer', v)} label="Allow file transfer and remote file browsing" />
            <Toggle checked={cfg.allow_audio} onChange={(v) => set('allow_audio', v)} label="Allow streaming the device's audio" />
            <Toggle checked={cfg.allow_annotations ?? true} onChange={(v) => set('allow_annotations', v)} label="Allow on-screen annotations (guidance drawings, independent of input control)" />
          </div>
          {cfg.allow_file_transfer && (
            <Field label="Upload folder on the device" hint="Leave empty for Downloads/RemoteAgent in the user's home.">
              <Input value={cfg.transfer_dir ?? ''} placeholder="~/Downloads/RemoteAgent" onChange={(e) => set('transfer_dir', e.target.value.trim() ? e.target.value : undefined)} />
            </Field>
          )}
          <div className="eyebrow pt-2">Video</div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Max frame rate">
              <Select value={cfg.max_fps} onChange={(v) => set('max_fps', v)} options={[15, 30, 60].map((v) => ({ value: v, label: `${v} fps` }))} />
            </Field>
            <Field label="Max bitrate">
              <Select
                value={cfg.max_bitrate_kbps}
                onChange={(v) => set('max_bitrate_kbps', v)}
                options={[2000, 4000, 8000, 15000, 30000].map((v) => ({ value: v, label: `${v / 1000} Mb/s` }))}
              />
            </Field>
          </div>
          <Field label="Preferred codec" hint="H.265 needs hardware support on both ends; H.264 is the fallback.">
            <Select
              value={cfg.preferred_codec}
              onChange={(v) => set('preferred_codec', v)}
              options={[
                { value: 'h265', label: 'H.265 (HEVC)' },
                { value: 'h264', label: 'H.264' },
              ]}
            />
          </Field>
          <div className="eyebrow pt-2">Agent</div>
          <Field label="Heartbeat interval (seconds)">
            <Input type="number" min={5} max={300} value={cfg.heartbeat_interval_s} onChange={(e) => set('heartbeat_interval_s', Number(e.target.value))} />
          </Field>
          <Field label="Display name shown on the device">
            <Input value={cfg.display_name} onChange={(e) => set('display_name', e.target.value)} />
          </Field>
        </fieldset>
        {editable && (
          <div className="flex justify-end">
            <Button type="submit" variant="primary" icon={<Save size={14} />} disabled={!dirty} loading={save.isPending}>
              Save settings
            </Button>
          </div>
        )}
      </form>
    </section>
  )
}

/** Read-only view of what the person at the device restricted in the agent app. */
function RestrictionsPanel({ device }: { device: Detail }) {
  const labels = overrideLabels(device.local_overrides)
  const active = hasOverrides(device.local_overrides)
  return (
    <section className="panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <ShieldAlert size={14} className={active ? 'text-warn' : 'text-ink-faint'} />
        <span className="font-medium">Device-side restrictions</span>
        {active && <Badge tone="warn" className="ml-auto">Active</Badge>}
      </div>
      <div className="px-4 py-3 text-[12.5px]">
        {active ? (
          <ul className="flex flex-col gap-1">
            {labels.map((l) => (
              <li key={l} className="flex items-center gap-2">
                <span className="size-1.5 shrink-0 rounded-full bg-warn" />
                {l}
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-ink-muted">The person at the device has not restricted anything; the settings below apply as-is.</div>
        )}
        <p className="mt-2 text-ink-faint">Set in the agent app on the device. Restrictions only tighten the console settings and cannot be changed from here.</p>
      </div>
    </section>
  )
}
