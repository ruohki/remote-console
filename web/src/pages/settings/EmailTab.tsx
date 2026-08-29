import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Save, Send } from 'lucide-react'
import { api, ApiError, errorMessage } from '@/lib/api'
import type { SmtpConfigInput, SmtpConfigPublic, SmtpSecurity } from '@/lib/types'
import { portAfterSecurityChange, smtpFormComplete, smtpFormFrom, smtpPayload } from '@/lib/email'
import { DEFAULT_BRANDING, useBranding } from '@/lib/branding'
import { useAuth } from '@/store/auth'
import { Button, EmptyState, Field, Input, Select, Skeleton, Toggle } from '@/components/ui'
import { toast } from '@/lib/toast'

/** `/settings/email` — outgoing mail (SMTP) used for password resets and email sign-in codes (admin). */
export function EmailTab() {
  const cfg = useQuery({
    queryKey: ['email-config'],
    queryFn: async () => {
      try {
        return await api.get<SmtpConfigPublic>('/api/email/config')
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null
        throw err
      }
    },
  })
  if (cfg.isPending) return <Skeleton className="h-60 w-full" />
  if (cfg.isError)
    return (
      <div className="panel">
        <EmptyState title="Email settings unavailable" detail={errorMessage(cfg.error)} />
      </div>
    )
  if (cfg.data === null)
    return (
      <div className="panel">
        <EmptyState title="This console version has no email settings" detail="Update the console server." />
      </div>
    )
  // Re-mount the form whenever the stored config changes so local edits start from it.
  return <EmailForm key={cfg.dataUpdatedAt} initial={cfg.data} />
}

function EmailForm({ initial }: { initial: SmtpConfigPublic }) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const branding = useBranding()
  const productName = branding.data?.product_name?.trim() || DEFAULT_BRANDING.product_name
  const [form, setForm] = useState<SmtpConfigInput>(() => smtpFormFrom(initial))
  const [testTo, setTestTo] = useState(() => user?.email ?? '')

  const set = <K extends keyof SmtpConfigInput>(k: K, v: SmtpConfigInput[K]) => setForm((f) => ({ ...f, [k]: v }))
  const setSecurity = (s: SmtpSecurity) => setForm((f) => ({ ...f, security: s, port: portAfterSecurityChange(f.port, f.security, s) }))

  const save = useMutation({
    mutationFn: () => api.put<SmtpConfigPublic>('/api/email/config', smtpPayload(form)),
    onSuccess: () => {
      toast.success('Email settings saved')
      void qc.invalidateQueries({ queryKey: ['email-config'] })
      void qc.invalidateQueries({ queryKey: ['auth-providers'] })
    },
    onError: (e) => toast.error('Could not save', errorMessage(e)),
  })
  // Tests the values in the form, saved or not.
  const test = useMutation({
    mutationFn: () => api.post<{ ok: true; detail: string }>('/api/email/test', { config: smtpPayload(form), to: testTo.trim() || undefined }),
  })

  const canSend = !!form.host.trim() && !!form.from_address.trim()

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12.5px] text-ink-muted">Used for password resets and email sign-in codes.</p>
      <section className="panel grid gap-3 p-4 sm:grid-cols-2">
        <div className="sm:col-span-2 flex items-center justify-between">
          <h2 className="font-semibold">SMTP server</h2>
          <Toggle checked={form.enabled} onChange={(v) => set('enabled', v)} label="Enabled" />
        </div>
        <Field label="Host">
          <Input value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.example.com" className="mono" data-testid="smtp-host" />
        </Field>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
          <Field label="Port">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={form.port || ''}
              onChange={(e) => set('port', Number(e.target.value) || 0)}
              className="mono"
              data-testid="smtp-port"
            />
          </Field>
          <Field label="Security" tip="None is for local relays only">
            <Select<SmtpSecurity>
              value={form.security}
              onChange={setSecurity}
              aria-label="Security"
              options={[
                { value: 'starttls', label: 'STARTTLS', description: 'Upgrade a plain connection (port 587)' },
                { value: 'tls', label: 'TLS', description: 'Encrypted from the start (port 465)' },
                { value: 'none', label: 'None', description: 'Unencrypted — local relays only' },
              ]}
            />
          </Field>
        </div>
        <Field label="Username" hint="Leave empty when the server needs no authentication">
          <Input value={form.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" className="mono" data-testid="smtp-username" />
        </Field>
        <Field label="Password" hint={initial.password_set ? 'Leave empty to keep the stored password' : undefined}>
          <Input type="password" autoComplete="new-password" value={form.password ?? ''} onChange={(e) => set('password', e.target.value)} className="mono" data-testid="smtp-password" />
        </Field>
        <Field label="From address">
          <Input type="email" value={form.from_address} onChange={(e) => set('from_address', e.target.value)} placeholder="console@example.com" className="mono" data-testid="smtp-from" />
        </Field>
        <Field label="From name">
          <Input value={form.from_name} onChange={(e) => set('from_name', e.target.value)} placeholder={productName} />
        </Field>
        <Field label="Reply-to" hint="Optional">
          <Input type="email" value={form.reply_to} onChange={(e) => set('reply_to', e.target.value)} placeholder="it@example.com" className="mono" />
        </Field>
        <div className="sm:col-span-2 flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <Field label="Send a test email to" className="w-full sm:w-72">
            <Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder={user?.email} className="mono" data-testid="email-test-to" />
          </Field>
          <Button icon={<Send size={13} />} onClick={() => test.mutate()} loading={test.isPending} disabled={!canSend} title="Uses the values in the form, saved or not" data-testid="email-test">
            Send test email
          </Button>
          {test.data && (
            <span className="text-[12px] text-ink-muted" data-testid="email-test-result">
              OK — {test.data.detail}
            </span>
          )}
          {test.isError && (
            <span className="text-[12px] text-danger" data-testid="email-test-result">
              {errorMessage(test.error)}
            </span>
          )}
        </div>
      </section>

      <div className="flex justify-end">
        <Button variant="primary" icon={<Save size={14} />} loading={save.isPending} disabled={!smtpFormComplete(form)} onClick={() => save.mutate()} data-testid="email-save">
          Save email settings
        </Button>
      </div>
    </div>
  )
}
