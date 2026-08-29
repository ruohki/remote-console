import { type FormEvent, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Button, Field, Input } from '@/components/ui'
import { api, ApiError, errorMessage } from '@/lib/api'
import { AuthShell } from './Login'

const BUTTON_LINK = 'inline-flex h-8 items-center justify-center rounded-md border border-transparent bg-accent px-3 text-[13px] font-medium text-accent-ink hover:brightness-110'

/** `/reset-password?token=…` — set a new password from an emailed link. */
export function ResetPassword() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<'form' | 'done' | 'invalid'>(token ? 'form' : 'invalid')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (password.length < 10) return setError('Use at least 10 characters for the password.')
    if (password !== confirm) return setError('The passwords do not match.')
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/auth/password/reset', { token, password })
      setStatus('done')
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_token') setStatus('invalid')
      else setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (status === 'invalid')
    return (
      <AuthShell title="Reset your password" subtitle="The link cannot be used.">
        <div className="flex flex-col gap-4">
          <p className="text-[13px]" data-testid="reset-invalid">
            This link is no longer valid. Request a new one.
          </p>
          <Link to="/forgot-password" className={BUTTON_LINK}>
            Request a new link
          </Link>
        </div>
      </AuthShell>
    )

  if (status === 'done')
    return (
      <AuthShell title="Password changed" subtitle="Use the new password from now on.">
        <div className="flex flex-col gap-4">
          <p className="text-[13px]" data-testid="reset-done">
            Your password was changed and every other session was signed out.
          </p>
          <Link to="/login" className={BUTTON_LINK} data-testid="reset-sign-in">
            Sign in
          </Link>
        </div>
      </AuthShell>
    )

  return (
    <AuthShell title="Choose a new password" subtitle="At least 10 characters.">
      <form onSubmit={submit} className="flex flex-col gap-3" data-testid="reset-form">
        <Field label="New password">
          <Input type="password" autoComplete="new-password" autoFocus required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password">
          <Input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {error && (
          <div role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
            {error}
          </div>
        )}
        <Button type="submit" variant="primary" loading={busy} className="mt-1">
          Change password
        </Button>
      </form>
    </AuthShell>
  )
}
