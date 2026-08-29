import { type FormEvent, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fingerprint, KeyRound, Pencil, Plus, RefreshCw, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react'
import { useAuth } from '@/store/auth'
import { api, ApiError, errorMessage } from '@/lib/api'
import type { AuthMethod, Passkey } from '@/lib/types'
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, Input, PageHeader, Skeleton, Table, Td, Th } from '@/components/ui'
import { dateTime, relativeTime } from '@/lib/format'
import { toast } from '@/lib/toast'
import { webauthnSupported } from '@/lib/webauthn'
import { PasskeyEnroll, RecoveryCodes, TotpEnroll } from './SecuritySetup'

const METHOD_LABEL: Record<AuthMethod, string> = { password: 'Password', passkey: 'Passkey / security key', oidc: 'Single sign-on (OIDC)', saml: 'Single sign-on (SAML)', ldap: 'Directory account (LDAP)' }

/** `/security` — every user's own second factors, passkeys and sign-in methods. */
export function SecurityPage() {
  const { user, refresh } = useAuth()
  const qc = useQueryClient()
  const passkeys = useQuery({
    queryKey: ['passkeys'],
    queryFn: async () => {
      try {
        return await api.get<Passkey[]>('/api/auth/passkeys')
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return [] as Passkey[]
        throw err
      }
    },
  })
  const [totpDialog, setTotpDialog] = useState<'closed' | 'enroll' | 'codes'>('closed')
  const [codes, setCodes] = useState<string[]>([])
  const [disableDialog, setDisableDialog] = useState(false)
  const [regenDialog, setRegenDialog] = useState(false)
  const [addKey, setAddKey] = useState(false)
  const [renaming, setRenaming] = useState<Passkey | null>(null)
  const [removing, setRemoving] = useState<Passkey | null>(null)

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['passkeys'] })
    void refresh()
  }

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/auth/passkeys/${id}`),
    onSuccess: () => {
      toast.success('Removed')
      setRemoving(null)
      invalidate()
    },
    onError: (e) =>
      toast.error(
        'Could not remove',
        e instanceof ApiError && e.status === 409 ? 'This is your only second factor and the policy requires one. Add another method first.' : errorMessage(e),
      ),
  })
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.patch<Passkey>(`/api/auth/passkeys/${id}`, { name }),
    onSuccess: () => {
      setRenaming(null)
      invalidate()
    },
    onError: (e) => toast.error('Could not rename', errorMessage(e)),
  })

  if (!user) return null
  const totpOn = !!user.two_factor_enabled
  const policyApplies = !!user.two_factor_required || (user.role === 'admin' && totpOn) // best effort: the server decides on disable

  return (
    <div className="w-full">
      <PageHeader title="Account security" />
      <div className="grid items-start gap-4 xl:grid-cols-2">

      {/* ── current session ── */}
      <section className="panel p-4 xl:col-span-2">
        <div className="eyebrow mb-2">Signed in as</div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-medium">{user.name}</span>
          <span className="mono text-ink-muted">{user.email}</span>
          <Badge tone="neutral">{user.role}</Badge>
          {user.auth_method && <span className="text-[12.5px] text-ink-muted">via {METHOD_LABEL[user.auth_method]}</span>}
          {user.break_glass && (
            <span title="Password sign-in always allowed">
              <Badge tone="warn">Break-glass account</Badge>
            </span>
          )}
        </div>
        {user.auth_methods && user.auth_methods.length > 0 && (
          <div className="mt-3 text-[12.5px] text-ink-muted">
            Linked sign-in methods:{' '}
            {user.auth_methods.map((m) => (
              <Badge key={m} className="mr-1">
                {METHOD_LABEL[m]}
              </Badge>
            ))}
          </div>
        )}
      </section>

      {/* ── authenticator app ── */}
      <section className="panel p-4">
        <div className="flex items-start gap-3">
          <span className={totpOn ? 'text-live' : 'text-ink-faint'}>{totpOn ? <ShieldCheck size={20} /> : <ShieldOff size={20} />}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold">Authenticator app (TOTP)</h2>
              {totpOn ? <Badge tone="live">On</Badge> : <Badge tone="warn">Off</Badge>}
              {user.two_factor_required && <Badge tone="danger">Required by policy</Badge>}
            </div>
            <p className="mt-1 text-[12.5px] text-ink-muted">
              {totpOn ? 'Codes from your authenticator app are asked after your password.' : 'Add time-based codes from an authenticator app as a second factor.'}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {totpOn ? (
                <>
                  <Button size="sm" icon={<RefreshCw size={13} />} onClick={() => setRegenDialog(true)}>
                    New recovery codes
                  </Button>
                  <Button size="sm" variant="danger" icon={<ShieldOff size={13} />} onClick={() => setDisableDialog(true)} disabled={policyApplies && (passkeys.data?.length ?? 0) === 0}>
                    Turn off
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="primary" icon={<KeyRound size={13} />} onClick={() => setTotpDialog('enroll')}>
                  Set up
                </Button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── passkeys / security keys ── */}
      <section className="panel p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Fingerprint size={20} className={passkeys.data?.length ? 'text-live' : 'text-ink-faint'} />
          <h2 className="font-semibold">Passkeys and security keys</h2>
          <span className="ml-auto">
            <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setAddKey(true)} disabled={!webauthnSupported()} title={webauthnSupported() ? undefined : 'Not available in this browser'}>
              Add
            </Button>
          </span>
        </div>
        <p className="mb-3 text-[12.5px] text-ink-muted">
          Passkeys (Touch ID, Windows Hello, phone) and FIDO2 keys such as a YubiKey. Resident passkeys sign you in without a password; every key also works as your second factor.
        </p>
        {passkeys.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : passkeys.isError ? (
          <EmptyState title="Could not load passkeys" detail={errorMessage(passkeys.error)} />
        ) : passkeys.data.length === 0 ? (
          <EmptyState title="No passkeys yet" detail="Passwordless sign-in or second factor." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th className="hidden sm:table-cell">Added</Th>
                <Th className="hidden sm:table-cell">Last used</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {passkeys.data.map((p) => (
                <tr key={p.id} className="row-hover">
                  <Td>
                    <span className="font-medium">{p.name}</span>
                    {p.backup_eligible && (
                      <span className="ml-2" title="Synced passkey">
                        <Badge>Synced</Badge>
                      </span>
                    )}
                  </Td>
                  <Td className="hidden sm:table-cell text-ink-muted">{dateTime(p.created_at)}</Td>
                  <Td className="hidden sm:table-cell text-ink-muted">{p.last_used_at ? relativeTime(p.last_used_at) : 'never'}</Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" icon={<Pencil size={13} />} title="Rename" onClick={() => setRenaming(p)} />
                      <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} title="Remove" onClick={() => setRemoving(p)} />
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
      </div>

      {/* dialogs */}
      <Dialog open={totpDialog !== 'closed'} onClose={() => setTotpDialog('closed')} title={totpDialog === 'codes' ? 'Recovery codes' : 'Set up an authenticator app'} width="max-w-md">
        {totpDialog === 'enroll' ? (
          <TotpEnroll onCodes={setCodes} onDone={() => setTotpDialog('codes')} />
        ) : (
          <RecoveryCodes
            codes={codes}
            onDone={() => {
              setTotpDialog('closed')
              setCodes([])
              invalidate()
            }}
          />
        )}
      </Dialog>
      <CodeDialog
        open={disableDialog}
        onClose={() => setDisableDialog(false)}
        title="Turn off the authenticator app"
        body="Enter a current code to confirm."
        confirmLabel="Turn off"
        danger
        onSubmit={async (code) => {
          try {
            await api.post('/api/auth/2fa/disable', { code })
            toast.success('Authenticator app turned off')
            setDisableDialog(false)
            invalidate()
          } catch (e) {
            throw new Error(e instanceof ApiError && e.code === 'policy_requires_2fa' ? 'The policy requires a second factor for your account.' : errorMessage(e), { cause: e })
          }
        }}
      />
      <CodeDialog
        open={regenDialog}
        onClose={() => setRegenDialog(false)}
        title="Generate new recovery codes"
        body="Your old codes stop working. Enter a current authenticator code to confirm."
        confirmLabel="Generate"
        onSubmit={async (code) => {
          const r = await api.post<{ recovery_codes: string[] }>('/api/auth/2fa/recovery-codes', { code })
          setRegenDialog(false)
          setCodes(r.recovery_codes)
          setTotpDialog('codes')
        }}
      />
      <Dialog open={addKey} onClose={() => setAddKey(false)} title="Add a passkey or security key" width="max-w-md">
        <PasskeyEnroll
          onDone={() => {
            setAddKey(false)
            invalidate()
          }}
        />
      </Dialog>
      <RenameDialog passkey={renaming} onClose={() => setRenaming(null)} onSubmit={(name) => rename.mutate({ id: renaming!.id, name })} loading={rename.isPending} />
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing.id)}
        title="Remove this passkey?"
        body={
          <>
            <b>{removing?.name}</b> will no longer sign you in or count as a second factor.
          </>
        }
        confirmLabel="Remove"
        danger
        loading={remove.isPending}
      />
    </div>
  )
}

function CodeDialog({
  open,
  onClose,
  title,
  body,
  confirmLabel,
  danger,
  onSubmit,
}: {
  open: boolean
  onClose: () => void
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  onSubmit: (code: string) => Promise<void>
}) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSubmit(code.replace(/\s+/g, ''))
      setCode('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title={title} width="max-w-sm">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="-mt-1 text-ink-muted">{body}</p>
        <Field label="Authenticator or recovery code">
          <Input autoFocus required value={code} onChange={(e) => setCode(e.target.value)} className="mono tracking-widest" inputMode="numeric" autoComplete="one-time-code" />
        </Field>
        {error && (
          <div role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={busy}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function RenameDialog({ passkey, onClose, onSubmit, loading }: { passkey: Passkey | null; onClose: () => void; onSubmit: (name: string) => void; loading: boolean }) {
  const [name, setName] = useState('')
  return (
    <Dialog open={!!passkey} onClose={onClose} title="Rename" width="max-w-sm">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit(name.trim() || passkey!.name)
        }}
        className="flex flex-col gap-3"
      >
        <Field label="Name">
          <Input autoFocus defaultValue={passkey?.name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={loading}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
