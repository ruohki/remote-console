import { type FormEvent, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, FolderKanban, KeyRound, LifeBuoy, Plus, ShieldCheck, ShieldOff, Trash2, UserX, UserCheck } from 'lucide-react'
import { Link } from 'react-router'
import { api, errorMessage } from '@/lib/api'
import type { Role, User, UserGrant } from '@/lib/types'
import { GROUP_PERMISSION_LABEL } from '@/lib/access'
import { useAuth } from '@/store/auth'
import { Badge, Button, ConfirmDialog, CopyButton, Dialog, EmptyState, Field, Input, PageHeader, Select, Skeleton, Table, Td, Th } from '@/components/ui'
import { PasswordSetField } from '@/components/PasswordSetField'
import { RowMenu } from '@/components/RowMenu'
import { compactDateTime, dateTime, relativeTime } from '@/lib/format'
import { signInDetails } from '@/lib/password'
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
  const [breakGlass, setBreakGlass] = useState<User | null>(null)

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
      toast.success('Two-factor reset', 'Enrollment required at next sign-in')
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
              <Th className="hidden sm:table-cell">Role</Th>
              <Th className="hidden md:table-cell">2FA</Th>
              <Th className="hidden md:table-cell">Access</Th>
              <Th className="hidden md:table-cell">Last sign-in</Th>
              <Th className="hidden lg:table-cell">Created</Th>
              <Th className="text-right">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {users.data.map((u) => (
              <tr key={u.id} className={u.disabled ? 'opacity-60' : 'row-hover'}>
                <Td className="w-full max-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{u.name}</span>
                    {u.id === me?.id && <span className="shrink-0 text-ink-faint">(you)</span>}
                    {u.disabled && (
                      <Badge tone="danger" className="shrink-0">
                        Disabled
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-[12px] text-ink-faint">
                    {u.email}
                    <span className="sm:hidden"> — {u.role === 'admin' ? 'Admin' : 'Operator'}</span>
                  </div>
                </Td>
                <Td className="hidden sm:table-cell">
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
                    <span className="whitespace-nowrap text-ink-faint">All devices</span>
                  ) : (
                    <Button size="sm" variant="ghost" icon={<FolderKanban size={13} />} onClick={() => setAccessFor(u)}>
                      Groups
                    </Button>
                  )}
                </Td>
                <Td className="hidden whitespace-nowrap text-ink-muted md:table-cell">{relativeTime(u.last_login_at)}</Td>
                <Td className="hidden lg:table-cell text-ink-muted whitespace-nowrap" title={dateTime(u.created_at)}>{compactDateTime(u.created_at)}</Td>
                <Td className="text-right">
                  <RowMenu
                    label={`Actions for ${u.name}`}
                    items={[
                      { label: 'Set password…', icon: <KeyRound size={14} />, onSelect: () => setResetFor(u) },
                      {
                        label: 'Reset two-factor…',
                        icon: <ShieldOff size={14} />,
                        onSelect: () => setReset2fa(u),
                        disabled: !u.two_factor_enabled && !u.passkeys,
                        title: !u.two_factor_enabled && !u.passkeys ? 'No second factor to reset' : 'Remove their authenticator, email codes and passkeys',
                      },
                      u.role === 'admin' && {
                        label: u.break_glass ? 'Remove break-glass…' : 'Make break-glass…',
                        icon: <LifeBuoy size={14} />,
                        onSelect: () => setBreakGlass(u),
                        title: 'Break-glass admins can always sign in with a password, even when single sign-on is enforced',
                      },
                      {
                        label: u.disabled ? 'Enable' : 'Disable',
                        icon: u.disabled ? <UserCheck size={14} /> : <UserX size={14} />,
                        onSelect: () => patch.mutate({ id: u.id, body: { disabled: !u.disabled } }),
                        disabled: u.id === me?.id,
                        title: u.id === me?.id ? 'You cannot disable yourself' : undefined,
                      },
                      {
                        label: 'Delete…',
                        icon: <Trash2 size={14} />,
                        onSelect: () => setDeleting(u),
                        danger: true,
                        disabled: u.id === me?.id,
                        title: u.id === me?.id ? 'You cannot delete yourself' : undefined,
                      },
                    ]}
                  />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <CreateUserDialog open={creating} onClose={() => setCreating(false)} onCreated={invalidate} />
      <UserAccessDialog user={accessFor} onClose={() => setAccessFor(null)} />
      <ResetPasswordDialog user={resetFor} onClose={() => setResetFor(null)} onDone={invalidate} />
      <ConfirmDialog
        open={!!breakGlass}
        onClose={() => setBreakGlass(null)}
        onConfirm={() => {
          if (breakGlass) patch.mutate({ id: breakGlass.id, body: { break_glass: !breakGlass.break_glass } })
          setBreakGlass(null)
        }}
        title={breakGlass?.break_glass ? 'Remove break-glass?' : 'Make break-glass account?'}
        body={
          breakGlass?.break_glass ? (
            <>
              <b>{breakGlass?.name}</b> can no longer sign in with a password once single sign-on is enforced (<span className="mono">LOCAL_LOGIN=0</span>).
            </>
          ) : (
            <>
              <b>{breakGlass?.name}</b> can always sign in with a password, even when single sign-on is enforced. Keep it for emergency access.
            </>
          )
        }
        confirmLabel={breakGlass?.break_glass ? 'Remove' : 'Make break-glass'}
      />
      <ConfirmDialog
        open={!!reset2fa}
        onClose={() => setReset2fa(null)}
        onConfirm={() => reset2fa && twoFactorReset.mutate(reset2fa.id)}
        title="Reset two-factor authentication?"
        body={
          <>
            <b>{reset2fa?.name}</b>’s authenticator app, email codes, recovery codes and passkeys are removed and they are signed out. They set up a new second factor at their next sign-in. Verify who is asking first.
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
      <p className="-mt-1 mb-3 text-ink-muted">Edit grants on the group page.</p>
      {grants.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : grants.isError ? (
        <EmptyState title="Could not load access" detail={errorMessage(grants.error)} />
      ) : grants.data.length === 0 ? (
        <EmptyState
          title="No access yet"
          detail="No device groups granted."
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

/** After a password is set: the details to send, exactly as stored. */
function Handover({ name, email, password, onClose }: { name: string; email: string; password: string; onClose: () => void }) {
  const details = signInDetails(email, password)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-live">
        <Check size={16} />
        <span className="font-medium text-ink">Password set for {name}</span>
      </div>
      <pre className="mono rounded-md border border-line bg-raised px-3 py-2 break-all whitespace-pre-wrap select-all">{details}</pre>
      <p className="text-[12.5px] text-ink-muted">Send it through a channel you trust. It is not shown again.</p>
      <div className="flex justify-end gap-2">
        <CopyButton text={details} label="Copy details" size="md" />
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  )
}

function CreateUserDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('operator')
  const [done, setDone] = useState<{ name: string; email: string; password: string } | null>(null)
  const reset = () => {
    setEmail('')
    setName('')
    setPassword('')
    setRole('operator')
    setDone(null)
  }
  const close = () => {
    reset()
    onClose()
  }
  const create = useMutation({
    mutationFn: () => api.post<User>('/api/users', { email: email.trim(), name: name.trim(), password: password.trim(), role }),
    onSuccess: (u) => {
      onCreated()
      setDone({ name: u.name, email: u.email, password: password.trim() })
    },
    onError: (e) => toast.error('Could not create the user', errorMessage(e)),
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }
  return (
    <Dialog open={open} onClose={close} title="Add user">
      {done ? (
        <Handover {...done} onClose={close} />
      ) : (
        // autoComplete off: a name / email / password form looks like a sign-in form, and the
        // browser would fill in the admin's own saved credentials.
        <form onSubmit={submit} autoComplete="off" className="flex flex-col gap-3">
          <Field label="Name">
            <Input required autoFocus autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email">
            <Input type="email" required autoComplete="off" data-1p-ignore data-lpignore="true" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <PasswordSetField value={password} onChange={setPassword} />
          <Field label="Role" hint={role === 'operator' ? 'Sees nothing until granted a device group.' : undefined}>
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
            <Button type="button" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={create.isPending}>
              Create user
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  )
}

function ResetPasswordDialog({ user, onClose, onDone }: { user: User | null; onClose: () => void; onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [done, setDone] = useState<{ name: string; email: string; password: string } | null>(null)
  const close = () => {
    setPw('')
    setDone(null)
    onClose()
  }
  const set = useMutation({
    mutationFn: (password: string) => api.patch<User>(`/api/users/${user!.id}`, { password }),
    onSuccess: (u, password) => {
      onDone()
      setDone({ name: u.name, email: u.email, password })
    },
    onError: (e) => toast.error('Could not set the password', errorMessage(e)),
  })
  return (
    <Dialog open={!!user} onClose={close} title={`Set password for ${user?.name ?? ''}`} width="max-w-md">
      {done ? (
        <Handover {...done} onClose={close} />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            set.mutate(pw.trim())
          }}
          autoComplete="off"
          className="flex flex-col gap-3"
        >
          <PasswordSetField value={pw} onChange={setPw} autoFocus />
          <p className="text-[12.5px] text-ink-muted">They are signed out everywhere. Their second factor stays.</p>
          <div className="mt-1 flex justify-end gap-2">
            <Button type="button" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={set.isPending}>
              Set password
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  )
}

function TwoFactorCell({ user: u }: { user: User }) {
  if (u.two_factor_enabled === undefined && u.passkeys === undefined) return <span className="text-ink-faint">—</span>
  const keys = u.passkeys ?? 0
  // Older servers report only "some factor": call it that rather than guess which.
  const app = u.totp_enabled ?? (!!u.two_factor_enabled && !u.email_2fa_enabled && keys === 0)
  const parts = [app && 'App', u.email_2fa_enabled && 'Email', keys > 0 && `${keys} passkey${keys === 1 ? '' : 's'}`].filter(Boolean) as string[]
  const on = !!u.two_factor_enabled || keys > 0
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      {on ? <ShieldCheck size={14} className="text-live" /> : <ShieldOff size={14} className="text-ink-faint" />}
      <span className="text-[12.5px]">
        {on ? parts.join(' + ') || 'On' : u.two_factor_required ? <Badge tone="warn">Pending</Badge> : <span className="text-ink-faint">off</span>}
      </span>
    </span>
  )
}
