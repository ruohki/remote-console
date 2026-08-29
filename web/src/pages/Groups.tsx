import { type FormEvent, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderKanban, Plus, Search } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import type { Group } from '@/lib/types'
import { Button, Dialog, EmptyState, Field, Input, PageHeader, Skeleton, Table, Td, Textarea, Th } from '@/components/ui'
import { dateTime } from '@/lib/format'
import { toast } from '@/lib/toast'

export function GroupsPage() {
  const navigate = useNavigate()
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api.get<Group[]>('/api/groups') })
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (groups.data ?? [])
      .filter((g) => (needle ? g.name.toLowerCase().includes(needle) || g.description.toLowerCase().includes(needle) : true))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [groups.data, q])

  return (
    <div className="w-full">
      <PageHeader
        title="Groups"
        actions={
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
            New group
          </Button>
        }
      />
      <div className="mb-3 flex items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint" />
          <Input data-search placeholder="Search groups" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
      </div>

      {groups.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : groups.isError ? (
        <div className="panel">
          <EmptyState title="Could not load groups" detail={errorMessage(groups.error)} />
        </div>
      ) : groups.data.length === 0 ? (
        <div className="panel">
          <EmptyState
            title="No groups yet"
            detail="Create a group, add devices, then grant access."
            action={
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
                New group
              </Button>
            }
          />
        </div>
      ) : list.length === 0 ? (
        <div className="panel">
          <EmptyState title="Nothing matches" detail="Try another search." />
        </div>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Group</Th>
              <Th className="w-28">Devices</Th>
              <Th className="hidden md:table-cell">Created</Th>
            </tr>
          </thead>
          <tbody>
            {list.map((g) => (
              <tr
                key={g.id}
                className="row-hover cursor-pointer"
                tabIndex={0}
                onClick={() => navigate(`/groups/${g.id}`)}
                onKeyDown={(e) => e.key === 'Enter' && navigate(`/groups/${g.id}`)}
              >
                <Td>
                  <div className="flex items-center gap-2.5">
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-raised text-ink-muted">
                      <FolderKanban size={14} />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{g.name}</div>
                      {g.description && <div className="truncate text-ink-faint">{g.description}</div>}
                    </div>
                  </div>
                </Td>
                <Td className="mono">{g.device_count}</Td>
                <Td className="hidden md:table-cell text-ink-muted">{dateTime(g.created_at)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <CreateGroupDialog open={creating} onClose={() => setCreating(false)} onCreated={(g) => navigate(`/groups/${g.id}`)} />
    </div>
  )
}

export function CreateGroupDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (g: Group) => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const create = useMutation({
    mutationFn: () => api.post<Group>('/api/groups', { name: name.trim(), description: description.trim() }),
    onSuccess: (g) => {
      toast.success('Group created', `Add devices and grant access to “${g.name}”.`)
      qc.invalidateQueries({ queryKey: ['groups'] })
      setName('')
      setDescription('')
      onClose()
      onCreated?.(g)
    },
    onError: (e) => toast.error('Could not create the group', errorMessage(e)),
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    create.mutate()
  }
  return (
    <Dialog open={open} onClose={onClose} title="New group" width="max-w-md">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Name">
          <Input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Berlin office" />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Front desk and meeting room PCs" />
        </Field>
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create group
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
