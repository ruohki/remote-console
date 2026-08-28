import { type FormEvent, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderKanban, KeyRound, Plus, ShieldAlert, ShieldCheck, ShieldOff, Trash2, UserX, UserCheck } from 'lucide-react'
import { Link } from 'react-router'
import { api, errorMessage } from '@/lib/api'
import type { Role, User, UserGrant } from '@/lib/types'
import { GROUP_PERMISSION_LABEL } from '@/lib/access'
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
  const [accessFor, setAccessFor] = useState<User | null>(null)
  const [reset2fa, setReset2fa] = useState<User | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['users'] })

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Pick<User, 'name' | 'role' | 'disabled' | 'break_glass'>> & { password?: string } }) =>
      api.patch<User>(`/api/users/${id}`, body),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error('Could not update the user', errorMessage(e)),
  })
  const twoFactorReset = useMutation({
    mutationFn: (id: string) => api.post(`/api/users/${id}/2fa/reset`),
    onSuccess: () => {
      toast.success('Two-factor reset', 'The user must enroll again at their next sign-in.')
      setReset2fa(null)
      invalidate()
    },
    onError: (e) => toast.error('Could not reset two-factor', errorMessage(e)),
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
    <div className="w-full">
      <PageHeader
        title="Users"
        subtitle="Operators only see the device groups they are granted (view or connect). Admins see everything and manage users, groups, tokens and device settings."
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
              <Th className="hidden md:table-cell">2FA</Th>
              <Th className="hidden md:table-cell">Access</Th>
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
                    onChange={(v) => patch.mutate({ id: u.id, body: { role: v } })}
                    size="sm"
                    className="w-32"
                    aria-label={`Role for ${u.name}`}
                    options={[
                      { value: 'admin', label: 'Admin' },
                      { value: 'operator', label: 'Operator' },
                    ]}
                  />
                </Td>
                <Td className="hidden md:table-cell">
                  <TwoFactorCell user={u} />
                </Td>
                <Td className="hidden md:table-cell">
                  {u.role === 'admin' ? (
                    <span className="text-ink-faint">All devices</span>
                  ) : (
                    <Button size="sm" variant="ghost" icon={<FolderKanban size={13} />} onClick={() => setAccessFor(u)}>
                      Groups
                    </Button>
                  )}
                </Td>
                <Td className="hidden md:table-cell text-ink-muted">{relativeTime(u.last_login_at)}</Td>
                <Td className="hidden lg:table-cell text-ink-muted">{dateTime(u.created_at)}</Td>
                <Td>
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" icon={<KeyRound size={13} />} title="Reset password" onClick={() => setResetFor(u)} />
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<ShieldOff size={13} />}
                      title="Reset two-factor (user must enroll again)"
                      disabled={!u.two_factor_enabled && !u.passkeys}
                      onClick={() => setReset2fa(u)}
                    />
                    {u.role === 'admin' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<ShieldAlert size={13} className={u.break_glass ? 'text-warn' : undefined} />}
                        title={u.break_glass ? 'Break-glass account: password sign-in always allowed (click to remove)' : 'Mark as break-glass account (password sign-in stays possible when local login is disabled)'}
                        onClick={() => patch.mutate({ id: u.id, body: { break_glass: !u.break_glass } })}
                      />
                    )}
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
      <UserAccessDialog user={accessFor} onClose={() => setAccessFor(null)} />
      <ResetPasswordDialog user={resetFor} onClose={() => setResetFor(null)} onSubmit={(pw) => patch.mutateAsync({ id: resetFor!.id, body: { password: pw } })} />
      <ConfirmDialog
        open={!!reset2fa}
        onClose={() => setReset2fa(null)}
        onConfirm={() => reset2fa && twoFactorReset.mutate(reset2fa.id)}
        title="Reset two-factor authentication?"
        body={
          <>
            <b>{reset2fa?.name}</b>’s authenticator app and recovery codes are removed and every passkey is unlinked. They will be asked to enroll again at their next sign-in. Do this only after verifying their identity.
          </>
        }
        confirmLabel="Reset two-factor"
        danger
        loading={twoFactorReset.isPending}
      />
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

function UserAccessDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const grants = useQuery({
    queryKey: ['user-grants', user?.id],
    queryFn: () => api.get<UserGrant[]>(`/api/users/${user!.id}/grants`),
    enabled: !!user,
  })
  return (
    <Dialog open={!!user} onClose={onClose} title={`Device access for ${user?.name ?? ''}`} width="max-w-md">
      <p className="-mt-1 mb-3 text-ink-muted">Operators only see devices in groups listed here. Grants are edited on the group page.</p>
      {grants.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : grants.isError ? (
        <EmptyState title="Could not load access" detail={errorMessage(grants.error)} />
      ) : grants.data.length === 0 ? (
        <EmptyState
          title="No access yet"
          detail="This operator cannot see any device. Grant them a group."
          action={
            <Link to="/groups" onClick={onClose}>
              <Button size="sm">Go to groups</Button>
            </Link>
          }
        />
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {grants.data.map((g) => (
            <li key={g.group_id} className="flex items-center gap-3 px-3 py-2">
              <FolderKanban size={14} className="text-ink-faint" />
              <Link to={`/groups/${g.group_id}`} onClick={onClose} className="min-w-0 flex-1 truncate font-medium hover:underline">
                {g.group_name}
              </Link>
              <Badge tone={g.permission === 'connect' ? 'accent' : 'neutral'}>{GROUP_PERMISSION_LABEL[g.permission]}</Badge>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Dialog>
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
        <Field label="Role" hint={role === 'operator' ? 'Operators see nothing until you grant them a device group.' : undefined}>
          <Select
            value={role}
            onChange={setRole}
            options={[
              { value: 'operator', label: 'Operator', description: 'Connects to granted device groups' },
              { value: 'admin', label: 'Admin', description: 'Full access' },
            ]}
          />
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

function TwoFactorCell({ user: u }: { user: User }) {
  if (u.two_factor_enabled === undefined && u.passkeys === undefined) return <span className="text-ink-faint">—</span>
  const keys = u.passkeys ?? 0
  const on = !!u.two_factor_enabled || keys > 0
  return (
    <span className="flex items-center gap-1.5">
      {on ? <ShieldCheck size={14} className="text-live" /> : <ShieldOff size={14} className="text-ink-faint" />}
      <span className="text-[12.5px]">
        {u.two_factor_enabled ? 'App' : null}
        {u.two_factor_enabled && keys > 0 ? ' + ' : null}
        {keys > 0 ? `${keys} passkey${keys === 1 ? '' : 's'}` : null}
        {!on && (u.two_factor_required ? <Badge tone="warn">Pending</Badge> : <span className="text-ink-faint">off</span>)}
      </span>
    </span>
  )
}
