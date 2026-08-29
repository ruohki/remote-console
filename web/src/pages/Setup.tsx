import { type FormEvent, useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { useAuth } from '@/store/auth'
import { Button, Field, Input } from '@/components/ui'
import { AuthShell } from './Login'
import { errorMessage } from '@/lib/api'

export function Setup() {
  const { needsSetup, setup } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (needsSetup === false) return <Navigate to="/login" replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (password.length < 10) return setError('Use at least 10 characters for the password.')
    if (password !== confirm) return setError('The passwords do not match.')
    setBusy(true)
    setError(null)
    try {
      await setup(email.trim(), name.trim(), password)
      navigate('/devices', { replace: true })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell title="Create the admin account" subtitle="The first account becomes the administrator.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Your name">
          <Input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email">
          <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <Input type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password">
          <Input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {error && <div className="rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{error}</div>}
        <Button type="submit" variant="primary" loading={busy} className="mt-1">
          Create account and sign in
        </Button>
      </form>
    </AuthShell>
  )
}
