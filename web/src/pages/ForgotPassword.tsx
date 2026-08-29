import { type FormEvent, useState } from 'react'
import { Link, Navigate } from 'react-router'
import { useAuth } from '@/store/auth'
import { Button, Field, Input } from '@/components/ui'
import { api, ApiError, errorMessage } from '@/lib/api'
import { AuthShell, useAuthProviders } from './Login'

export const FORGOT_SENT_TEXT = 'If an account with that email exists and signs in with a password, we sent a link. It expires in 30 minutes.'

/** `/forgot-password` — request a reset link for a local account. The answer never reveals whether the account exists. */
export function ForgotPassword() {
  const { user, needsSetup } = useAuth()
  const providers = useAuthProviders()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (needsSetup) return <Navigate to="/setup" replace />
  if (user) return <Navigate to="/devices" replace />

  // Known to be off (older server or no SMTP); while loading the form is shown as usual.
  const unavailable = !!providers.data && !providers.data.password_reset

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/auth/password/forgot', { email: email.trim() })
      setSent(true)
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? 'Too many requests. Try again later.' : errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell title="Reset your password" subtitle={sent ? 'Check your inbox.' : 'Enter the email of your console account.'}>
      {sent ? (
        <div className="flex flex-col gap-4">
          <p className="text-[13px]" data-testid="forgot-sent">
            {FORGOT_SENT_TEXT}
          </p>
          <Link to="/login" className="text-[12.5px] text-accent hover:underline">
            Back to sign in
          </Link>
        </div>
      ) : unavailable ? (
        <div className="flex flex-col gap-4">
          <p className="text-[13px] text-ink-muted" data-testid="forgot-unavailable">
            Password reset is not available on this console. Contact your administrator.
          </p>
          <Link to="/login" className="text-[12.5px] text-accent hover:underline">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3" data-testid="forgot-form">
          <Field label="Email">
            <Input type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {error && (
            <div role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
              {error}
            </div>
          )}
          <Button type="submit" variant="primary" loading={busy} className="mt-1">
            Send reset link
          </Button>
          <Link to="/login" className="text-[12.5px] text-ink-muted hover:underline">
            Back to sign in
          </Link>
        </form>
      )}
    </AuthShell>
  )
}
