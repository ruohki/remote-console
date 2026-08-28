import { type FormEvent, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { useAuth } from '@/store/auth'
import { Button, Field, Input } from '@/components/ui'
import { Wordmark } from '@/components/Layout'
import { errorMessage } from '@/lib/api'

export function AuthShell({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-ground p-6">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-8 justify-center text-[15px]" />
        <div className="panel animate-fade-up p-6">
          <h1 className="text-[17px] font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 mb-5 text-ink-muted">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  )
}

export function Login() {
  const { user, needsSetup, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (needsSetup) return <Navigate to="/setup" replace />
  if (user) return <Navigate to={(location.state as { from?: string } | null)?.from ?? '/devices'} replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(email.trim(), password)
      navigate((location.state as { from?: string } | null)?.from ?? '/devices', { replace: true })
    } catch (err) {
      setError(
        errorMessage(err) === 'invalid_credentials' || /credential/i.test(errorMessage(err))
          ? 'Email or password is wrong.'
          : errorMessage(err),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell title="Sign in" subtitle="Use the account an admin created for you.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Email">
          <Input type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <div className="rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{error}</div>}
        <Button type="submit" variant="primary" loading={busy} className="mt-1">
          Sign in
        </Button>
      </form>
    </AuthShell>
  )
}
