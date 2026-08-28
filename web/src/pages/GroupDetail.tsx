import { type FormEvent, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, FolderKanban, Save, Search, Trash2 } from 'lucide-react'
import { api, ApiError, errorMessage } from '@/lib/api'
import type { Group, GroupGrant, User } from '@/lib/types'
import type { DeviceSummary } from '@/protocol'
import { useLive } from '@/store/live'
import { Badge, Button, ConfirmDialog, EmptyState, Field, Input, PageHeader, Select, Skeleton, Table, Td, Textarea, Th, cx } from '@/components/ui'
import { OsIcon, StatusLed } from '@/components/badges'
import { NotFound } from './NotFound'
import { toast } from '@/lib/toast'
import { buildGrantsPayload, type GrantChoice, grantsDiff, grantsToChoices } from '@/lib/access'

export function GroupDetail() {
  const { id = '' } = useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()

  const group = useQuery({
    queryKey: ['group', id],
    queryFn: async () => {
      const all = await api.get<Group[]>('/api/groups')
      const g = all.find((x) => x.id === id)
      if (!g) throw new ApiError(404, 'not_found', 'Group not found')
      return g
    },
    retry: false,
  })
  const members = useQuery({ queryKey: ['group-devices', id], queryFn: () => api.get<DeviceSummary[]>(`/api/groups/${id}/devices`) })
  const grants = useQuery({ queryKey: ['group-grants', id], queryFn: () => api.get<GroupGrant[]>(`/api/groups/${id}/grants`) })
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/api/users') })

  const [deleting, setDeleting] = useState(false)
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/groups/${id}`),
    onSuccess: () => {
      toast.success('Group deleted', 'Its devices stay enrolled; they are just no longer in this group.')
      qc.invalidateQueries({ queryKey: ['groups'] })
      qc.invalidateQueries({ queryKey: ['devices'] })
      navigate('/groups')
    },
    onError: (e) => toast.error('Could not delete the group', errorMessage(e)),
  })

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['groups'] })
    qc.invalidateQueries({ queryKey: ['group', id] })
    qc.invalidateQueries({ queryKey: ['group-devices', id] })
    qc.invalidateQueries({ queryKey: ['group-grants', id] })
    qc.invalidateQueries({ queryKey: ['devices'] })
  }

  if (group.isError && group.error instanceof ApiError && group.error.status === 404) return <NotFound />
  if (group.isPending) {
    return (
      <div className="mx-auto max-w-5xl">
        <Skeleton className="mb-4 h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (group.isError) {
    return (
      <div className="panel mx-auto max-w-5xl">
        <EmptyState title="Could not load this group" detail={errorMessage(group.error)} />
      </div>
    )
  }
  const g = group.data

  return (
    <div className="mx-auto max-w-5xl">
      <Link to="/groups" className="mb-3 inline-flex items-center gap-1 text-ink-muted hover:text-ink">
        <ArrowLeft size={14} /> Groups
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span className="grid size-8 place-items-center rounded-md bg-raised text-ink-muted">
              <FolderKanban size={16} />
            </span>
            {g.name}
          </span>
        }
        subtitle={g.description || <span className="text-ink-faint">No description</span>}
        actions={
          <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => setDeleting(true)}>
            Delete group
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="flex flex-col gap-4">
          <DevicesPanel groupId={id} members={members.data} loading={members.isPending} onSaved={invalidateAll} />
          <AccessPanel groupId={id} grants={grants.data} users={users.data} loading={grants.isPending || users.isPending} onSaved={invalidateAll} />
        </div>
        <div className="flex flex-col gap-4">
          <MetaForm key={`${g.id}|${g.name}|${g.description}`} group={g} onSaved={invalidateAll} />
          <section className="panel px-4 py-3 text-[12.5px] text-ink-muted">
            <div className="mb-1 font-medium text-ink">How access works</div>
            Operators only see devices in groups they are granted. <b>View</b> shows status and history; <b>Connect</b> also allows opening
            sessions, renaming and tagging. Admins are never restricted. A device in several groups gets the strongest grant.
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={() => remove.mutate()}
        title="Delete this group?"
        body={
          <>
            <b>{g.name}</b> and its access grants are removed. The {g.device_count} device{g.device_count === 1 ? '' : 's'} in it stay enrolled —
            operators who only had access through this group will no longer see them.
          </>
        }
        confirmLabel="Delete group"
        danger
        loading={remove.isPending}
      />
    </div>
  )
}

function MetaForm({ group, onSaved }: { group: Group; onSaved: () => void }) {
  const [name, setName] = useState(group.name)
  const [description, setDescription] = useState(group.description)
  const save = useMutation({
    mutationFn: () => api.patch<Group>(`/api/groups/${group.id}`, { name: name.trim(), description: description.trim() }),
    onSuccess: () => {
      toast.success('Group saved')
      onSaved()
    },
    onError: (e) => toast.error('Could not save', errorMessage(e)),
  })
  const dirty = name !== group.name || description !== group.description
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim()) save.mutate()
  }
  return (
    <section className="panel">
      <div className="border-b border-line px-4 py-2.5 font-medium">Details</div>
      <form onSubmit={submit} className="flex flex-col gap-3 px-4 py-3">
        <Field label="Name">
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" icon={<Save size={14} />} disabled={!dirty} loading={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </section>
  )
}

function DevicesPanel({ groupId, members, loading, onSaved }: { groupId: string; members?: DeviceSummary[]; loading: boolean; onSaved: () => void }) {
  // All devices (admins see everything): live store first, REST as fallback while it hydrates.
  const deviceMap = useLive((s) => s.devices)
  const hydrated = useLive((s) => s.hydrated)
  const all = useQuery({ queryKey: ['devices'], queryFn: () => api.get<DeviceSummary[]>('/api/devices'), enabled: !hydrated })
  const devices = useMemo(() => {
    const live = Object.values(deviceMap)
    const list = live.length > 0 ? live : (all.data ?? [])
    return [...list].sort((a, b) => a.name.localeCompare(b.name))
  }, [deviceMap, all.data])

  const savedIds = useMemo(() => new Set((members ?? []).map((d) => d.id)), [members])
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const current = selected ?? savedIds
  const [q, setQ] = useState('')

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return devices.filter((d) => (needle ? [d.name, d.hostname, ...d.tags].some((s) => s.toLowerCase().includes(needle)) : true))
  }, [devices, q])

  const dirty = selected !== null && (selected.size !== savedIds.size || [...selected].some((x) => !savedIds.has(x)))
  const save = useMutation({
    mutationFn: () => api.put(`/api/groups/${groupId}/devices`, { device_ids: [...current] }),
    onSuccess: () => {
      toast.success('Devices updated')
      setSelected(null)
      onSaved()
    },
    onError: (e) => toast.error('Could not update devices', errorMessage(e)),
  })

  const toggle = (id: string) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  return (
    <section className="panel">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <span className="font-medium">
          Devices <span className="mono text-ink-faint">{current.size}</span>
        </span>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-ink-faint" />
            <Input placeholder="Filter devices" value={q} onChange={(e) => setQ(e.target.value)} className="h-7 w-44 pl-7 text-[12.5px]" />
          </div>
          <Button size="sm" variant="primary" icon={<Save size={13} />} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </div>
      </div>
      {loading ? (
        <Skeleton className="m-4 h-24" />
      ) : devices.length === 0 ? (
        <EmptyState title="No devices enrolled yet" detail="Enroll devices first, then add them here." />
      ) : filtered.length === 0 ? (
        <EmptyState title="Nothing matches" />
      ) : (
        <ul className="max-h-96 divide-y divide-line overflow-auto">
          {filtered.map((d) => {
            const checked = current.has(d.id)
            return (
              <li key={d.id}>
                <label className={cx('flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-raised', checked && 'bg-accent-soft/40')}>
                  <input type="checkbox" className="accent-accent" checked={checked} onChange={() => toggle(d.id)} />
                  <StatusLed device={d} />
                  <OsIcon os={d.os} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{d.name}</span>
                    <span className="mono block truncate text-ink-faint">{d.hostname}</span>
                  </span>
                  {d.groups.filter((x) => x.id !== groupId).length > 0 && (
                    <span className="hidden text-[11.5px] text-ink-faint sm:block">
                      also in{' '}
                      {d.groups
                        .filter((x) => x.id !== groupId)
                        .map((x) => x.name)
                        .join(', ')}
                    </span>
                  )}
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function AccessPanel({ groupId, grants, users, loading, onSaved }: { groupId: string; grants?: GroupGrant[]; users?: User[]; loading: boolean; onSaved: () => void }) {
  const saved = useMemo(() => grantsToChoices(grants ?? []), [grants])
  const [edited, setEdited] = useState<Record<string, GrantChoice> | null>(null)
  const choices = edited ?? saved
  const diff = grantsDiff(saved, choices)
  const dirty = diff.length > 0

  const save = useMutation({
    mutationFn: () => api.put<GroupGrant[]>(`/api/groups/${groupId}/grants`, buildGrantsPayload(choices)),
    onSuccess: () => {
      toast.success('Access updated', `${diff.length} change${diff.length === 1 ? '' : 's'} applied. Operators see the difference immediately.`)
      setEdited(null)
      onSaved()
    },
    onError: (e) => toast.error('Could not update access', errorMessage(e)),
  })

  const operators = (users ?? []).filter((u) => u.role !== 'admin').sort((a, b) => a.name.localeCompare(b.name))
  const admins = (users ?? []).filter((u) => u.role === 'admin')

  return (
    <section className="panel">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <span className="font-medium">Access</span>
        <Button size="sm" variant="primary" icon={<Save size={13} />} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
      {loading ? (
        <Skeleton className="m-4 h-24" />
      ) : operators.length === 0 ? (
        <EmptyState
          title="No operators yet"
          detail="Create operator users first; admins always have full access."
          action={
            <Link to="/users">
              <Button size="sm">Manage users</Button>
            </Link>
          }
        />
      ) : (
        <Table className="rounded-none border-0">
          <thead>
            <tr>
              <Th>User</Th>
              <Th className="w-44">Permission</Th>
            </tr>
          </thead>
          <tbody>
            {operators.map((u) => {
              const value = choices[u.id] ?? 'none'
              const changed = (saved[u.id] ?? 'none') !== value
              return (
                <tr key={u.id} className={cx(u.disabled && 'opacity-60')}>
                  <Td>
                    <div className="font-medium">
                      {u.name}
                      {u.disabled && (
                        <Badge tone="danger" className="ml-2">
                          Disabled
                        </Badge>
                      )}
                      {changed && (
                        <Badge tone="accent" className="ml-2">
                          Changed
                        </Badge>
                      )}
                    </div>
                    <div className="mono text-ink-faint">{u.email}</div>
                  </Td>
                  <Td>
                    <Select
                      value={value}
                      aria-label={`Permission for ${u.name}`}
                      onChange={(v) => setEdited({ ...choices, [u.id]: v })}
                      size="sm"
                      className="w-32"
                      options={[
                        { value: 'none', label: 'No access' },
                        { value: 'view', label: 'View' },
                        { value: 'connect', label: 'Connect' },
                      ]}
                    />
                  </Td>
                </tr>
              )
            })}
            {admins.map((u) => (
              <tr key={u.id} className="text-ink-muted">
                <Td>
                  <div className="font-medium">{u.name}</div>
                  <div className="mono text-ink-faint">{u.email}</div>
                </Td>
                <Td>
                  <Badge tone="accent">Admin · full access</Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  )
}
