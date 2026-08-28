import { type FormEvent, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Plus, Trash2, UserX, UserCheck } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import type { Role, User } from '@/lib/types'
import { useAuth } from '@/store/auth'
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, Input, PageHeader, Select, Skeleton, Table, Td, Th } from '@/components/ui'
import { dateTime, relativeTime } from '@/lib/format'
import { toast } from '@/lib/toast'

export function UsersPage() {
  const qc = useQueryClient()
  const me = useAuth().user
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/api/users') })
  const [creating, setCreating] = useState(false)
  const [resetFor, setResetFor] = useState<User | null>(null)
  const [deleting, setDeleting] = useState<User | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['users'] })

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Pick<User, 'name' | 'role' | 'disabled'>> & { password?: string } }) =>
      api.patch<User>(`/api/users/${id}`, body),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error('Could not update the user', errorMessage(e)),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/users/${id}`),
    onSuccess: () => {
      toast.success('User deleted')
      setDeleting(null)
      invalidate()
    },
    onError: (e) => toast.error('Could not delete the user', errorMessage(e)),
  })

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Users"
        subtitle="Operators can connect to devices. Admins also manage users, tokens and device settings."
        actions={
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
            Add user
          </Button>
        }
      />
      {users.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : users.isError ? (
        <div className="panel">
          <EmptyState title="Could not load users" detail={errorMessage(users.error)} />
        </div>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Role</Th>
              <Th className="hidden md:table-cell">Last sign-in</Th>
              <Th className="hidden lg:table-cell">Created</Th>
              <Th className="w-40" />
            </tr>
          </thead>
          <tbody>
            {users.data.map((u) => (
              <tr key={u.id} className={u.disabled ? 'opacity-60' : 'row-hover'}>
                <Td>
                  <span className="font-medium">{u.name}</span>
                  {u.id === me?.id && <span className="ml-2 text-ink-faint">(you)</span>}
                  {u.disabled && (
                    <Badge tone="danger" className="ml-2">
                      Disabled
                    </Badge>
                  )}
                </Td>
                <Td className="mono">{u.email}</Td>
                <Td>
                  <Select
                    value={u.role}
                    disabled={u.id === me?.id}
                    onChange={(e) => patch.mutate({ id: u.id, body: { role: e.target.value as Role } })}
                    className="h-7 w-32 text-[12.5px]"
                  >
                    <option value="admin">Admin</option>
                    <option value="operator">Operator</option>
                  </Select>
                </Td>
                <Td className="hidden md:table-cell text-ink-muted">{relativeTime(u.last_login_at)}</Td>
                <Td className="hidden lg:table-cell text-ink-muted">{dateTime(u.created_at)}</Td>
                <Td>
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" icon={<KeyRound size={13} />} title="Reset password" onClick={() => setResetFor(u)} />
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={u.disabled ? <UserCheck size={13} /> : <UserX size={13} />}
                      title={u.disabled ? 'Enable' : 'Disable'}
                      disabled={u.id === me?.id}
                      onClick={() => patch.mutate({ id: u.id, body: { disabled: !u.disabled } })}
                    />
                    <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} title="Delete" disabled={u.id === me?.id} onClick={() => setDeleting(u)} />
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <CreateUserDialog open={creating} onClose={() => setCreating(false)} onCreated={invalidate} />
      <ResetPasswordDialog user={resetFor} onClose={() => setResetFor(null)} onSubmit={(pw) => patch.mutateAsync({ id: resetFor!.id, body: { password: pw } })} />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        title="Delete user?"
        body={
          <>
            <b>{deleting?.name}</b> will lose access immediately. Their past sessions stay in the audit log.
          </>
        }
        confirmLabel="Delete user"
        danger
        loading={remove.isPending}
      />
    </div>
  )
}

function CreateUserDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('operator')
  const create = useMutation({
    mutationFn: () => api.post<User>('/api/users', { email: email.trim(), name: name.trim(), password, role }),
    onSuccess: () => {
      toast.success('User created', `${name} can sign in now.`)
      onCreated()
      onClose()
      setEmail('')
      setName('')
      setPassword('')
      setRole('operator')
    },
    onError: (e) => toast.error('Could not create the user', errorMessage(e)),
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }
  return (
    <Dialog open={open} onClose={onClose} title="Add user">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Name">
          <Input required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email">
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" hint="At least 10 characters. Share it with the user; they can't reset it themselves.">
          <Input type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="operator">Operator — connects to devices</option>
            <option value="admin">Admin — full access</option>
          </Select>
        </Field>
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create user
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function ResetPasswordDialog({ user, onClose, onSubmit }: { user: User | null; onClose: () => void; onSubmit: (pw: string) => Promise<unknown> }) {
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={!!user} onClose={onClose} title={`Reset password for ${user?.name ?? ''}`} width="max-w-md">
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          try {
            await onSubmit(pw)
            toast.success('Password updated')
            setPw('')
            onClose()
          } finally {
            setBusy(false)
          }
        }}
        className="flex flex-col gap-3"
      >
        <Field label="New password" hint="At least 10 characters.">
          <Input type="password" required minLength={10} autoFocus autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Set password
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
