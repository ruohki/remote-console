import { type FormEvent, useEffect, useMemo, useReducer, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Building2, Fingerprint, KeyRound, LogIn, ShieldCheck } from 'lucide-react'
import { envelopeUser, useAuth } from '@/store/auth'
import { Button, Field, Input } from '@/components/ui'
import { Wordmark } from '@/components/Layout'
import { api, ApiError, errorMessage } from '@/lib/api'
import type { AuthMethod, AuthProviders, User } from '@/lib/types'
import { LEGACY_PROVIDERS, initialLoginState, nextRouteAfterLogin, parseLoginParams, reduceLogin, require2faText } from '@/lib/authFlow'
import { friendlyWebAuthnError, getCredential, webauthnSupported, type JsonRequestOptions } from '@/lib/webauthn'

export function AuthShell({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle: React.ReactNode }) {
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

/** Public provider discovery; an older console without the endpoint means password only. */
export function useAuthProviders() {
  return useQuery({
    queryKey: ['auth-providers'],
    queryFn: async (): Promise<AuthProviders> => {
      try {
        return await api.get<AuthProviders>('/api/auth/providers')
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 405)) return LEGACY_PROVIDERS
        throw err
      }
    },
    staleTime: 60_000,
    retry: false,
  })
}

/** Session-creating responses wrap the user with the method used and where to go next. */
type LoginEnvelope = { user: User; two_factor_required?: boolean; auth_method?: AuthMethod; return_to?: string | null }

function failedEvent(err: unknown) {
  const e = err instanceof ApiError ? err : null
  // `Retry-After` (parsed by the API client) wins; the message pattern is the fallback for older servers.
  const retry = e && /(\d+)\s*s/.exec(e.message)
  return {
    type: 'failed' as const,
    status: e?.status ?? 0,
    code: e?.code ?? 'error',
    message: errorMessage(err),
    retryAfterS: e?.retryAfterS ?? (retry ? Number(retry[1]) : undefined),
  }
}

export function Login() {
  const { user, needsSetup, login, loginLdap, completeLogin } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const providers = useAuthProviders()
  // The server's SSO redirects land here with `?pending=two_factor…` or `?error=…` (see API.md).
  const params = useMemo(() => parseLoginParams(location.search), [location.search])
  const [state, dispatch] = useReducer(reduceLogin, initialLoginState, (s) => (params.pending ? reduceLogin(s, { type: 'pending', pending: params.pending }) : s))
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [ssoError] = useState(() => params.ssoError)
  const [breakGlass, setBreakGlass] = useState(false)
  const [directory, setDirectory] = useState(false)
  const canWebAuthn = webauthnSupported()

  const from = (location.state as { from?: string } | null)?.from ?? params.returnTo

  // Countdown for a lockout message.
  const [, tick] = useState(0)
  useEffect(() => {
    if (!state.lockedForS) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [state.lockedForS])

  if (needsSetup) return <Navigate to="/setup" replace />
  if (user) return <Navigate to={nextRouteAfterLogin(user, from)} replace />

  const finish = (env: LoginEnvelope) => {
    const u = envelopeUser(env)
    completeLogin(u)
    navigate(nextRouteAfterLogin(u, from, env.return_to), { replace: true })
  }

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    dispatch({ type: 'submitted' })
    try {
      const r = useDirectory ? await loginLdap(username.trim(), password) : await login(email.trim(), password)
      if (r.kind === 'ok') {
        dispatch({ type: 'ok', user: r.user })
        navigate(nextRouteAfterLogin(r.user, from), { replace: true })
      } else {
        dispatch({ type: 'pending', pending: r.pending })
        setCode('')
      }
    } catch (err) {
      dispatch(failedEvent(err))
    } finally {
      setBusy(false)
    }
  }

  const submitCode = async (e: FormEvent) => {
    e.preventDefault()
    if (!state.challengeId) return
    setBusy(true)
    dispatch({ type: 'submitted' })
    try {
      const env = await api.post<LoginEnvelope>('/api/auth/2fa/verify', { challenge_id: state.challengeId, code: code.replace(/\s+/g, '') })
      dispatch({ type: 'ok', user: env.user })
      finish(env)
    } catch (err) {
      dispatch(failedEvent(err))
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  const secondFactorPasskey = async () => {
    if (!state.challengeId) return
    setBusy(true)
    dispatch({ type: 'submitted' })
    try {
      const options = await api.post<JsonRequestOptions>('/api/auth/2fa/passkey/start', { challenge_id: state.challengeId })
      const credential = await getCredential(options)
      const env = await api.post<LoginEnvelope>('/api/auth/2fa/passkey/finish', { challenge_id: state.challengeId, credential })
      dispatch({ type: 'ok', user: env.user })
      finish(env)
    } catch (err) {
      if (err instanceof ApiError) dispatch(failedEvent(err))
      else dispatch({ type: 'failed', status: 0, code: 'webauthn', message: friendlyWebAuthnError(err).message })
    } finally {
      setBusy(false)
    }
  }

  const passkeyLogin = async () => {
    setBusy(true)
    dispatch({ type: 'submitted' })
    try {
      const options = await api.post<JsonRequestOptions & { challenge_id?: string }>('/api/auth/passkeys/login/start', {})
      const credential = await getCredential(options)
      // Newer servers hand out a challenge id with the options and expect it back with the assertion.
      const body = options.challenge_id ? { challenge_id: options.challenge_id, credential } : credential
      const env = await api.post<LoginEnvelope>('/api/auth/passkeys/login/finish', body)
      dispatch({ type: 'ok', user: env.user })
      finish(env)
    } catch (err) {
      if (err instanceof ApiError) dispatch(failedEvent(err))
      else dispatch({ type: 'failed', status: 0, code: 'webauthn', message: friendlyWebAuthnError(err).message })
    } finally {
      setBusy(false)
    }
  }

  const p = providers.data ?? LEGACY_PROVIDERS
  const ssoReturn = encodeURIComponent(from && from.startsWith('/') && !from.startsWith('//') ? from : '/devices')
  const showSso = !!(p.oidc || p.saml)
  const showPasskey = canWebAuthn && p.passkeys
  const showLdap = !!p.ldap
  const localAvailable = p.local_login || breakGlass
  // Directory sign-in is the only credential form when passwords are off; otherwise it is a toggle.
  const useDirectory = showLdap && (directory || !localAvailable)
  const policyNote = require2faText(p.require_2fa)

  if (state.step === 'second_factor') {
    return (
      <AuthShell
        title="Verify it’s you"
        subtitle={
          state.mode === 'recovery'
            ? 'Enter one of your recovery codes. Each code works once.'
            : state.mode === 'passkey'
              ? 'Confirm with your security key or passkey.'
              : 'Enter the 6-digit code from your authenticator app.'
        }
      >
        {state.mode === 'passkey' ? (
          <div className="flex flex-col gap-3">
            <Button variant="primary" icon={<KeyRound size={14} />} loading={busy} onClick={secondFactorPasskey} data-testid="second-factor-passkey">
              Use security key / passkey
            </Button>
            {state.error && <ErrorBox>{state.error}</ErrorBox>}
            {state.methods.includes('totp') && (
              <button type="button" className="text-left text-[12.5px] text-accent hover:underline" onClick={() => dispatch({ type: 'set_mode', mode: 'code' })}>
                Use an authenticator code instead
              </button>
            )}
          </div>
        ) : (
          <form onSubmit={submitCode} className="flex flex-col gap-3">
            <Field label={state.mode === 'recovery' ? 'Recovery code' : 'Authentication code'}>
              <Input
                autoFocus
                required
                inputMode={state.mode === 'recovery' ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                placeholder={state.mode === 'recovery' ? 'xxxxx-xxxxx' : '123 456'}
                pattern={state.mode === 'recovery' ? undefined : '[0-9 ]{6,7}'}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="mono tracking-widest"
                data-testid="second-factor-code"
              />
            </Field>
            {state.error && <ErrorBox>{state.error}</ErrorBox>}
            {state.attemptsLeft !== null && state.attemptsLeft < 5 && state.attemptsLeft > 0 && (
              <div className="text-[12px] text-ink-faint">{state.attemptsLeft} attempts left before you have to sign in again.</div>
            )}
            <Button type="submit" variant="primary" loading={busy}>
              Verify
            </Button>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
              {state.mode === 'code' ? (
                <button type="button" className="text-accent hover:underline" onClick={() => dispatch({ type: 'set_mode', mode: 'recovery' })}>
                  Use a recovery code
                </button>
              ) : (
                <button type="button" className="text-accent hover:underline" onClick={() => dispatch({ type: 'set_mode', mode: 'code' })}>
                  Use an authenticator code
                </button>
              )}
              {state.methods.includes('passkey') && canWebAuthn && (
                <button type="button" className="text-accent hover:underline" onClick={() => dispatch({ type: 'set_mode', mode: 'passkey' })}>
                  Use a security key
                </button>
              )}
              <button type="button" className="ml-auto text-ink-muted hover:underline" onClick={() => dispatch({ type: 'back' })}>
                Start over
              </button>
            </div>
          </form>
        )}
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="Sign in"
      subtitle={p.local_login ? 'Use the account an admin created for you.' : 'Sign in with your organisation’s identity provider.'}
    >
      <div className="flex flex-col gap-3">
        {ssoError && <ErrorBox>{ssoError}</ErrorBox>}
        {showSso && (
          <div className="flex flex-col gap-2" data-testid="sso-buttons">
            {p.oidc && (
              <Button variant="primary" icon={<LogIn size={14} />} onClick={() => window.location.assign(`/api/auth/oidc/start?return=${ssoReturn}`)} data-testid="sso-oidc">
                Continue with {p.oidc.display_name || 'single sign-on'}
              </Button>
            )}
            {p.saml && (
              <Button variant="primary" icon={<ShieldCheck size={14} />} onClick={() => window.location.assign(`/api/auth/saml/start?return=${ssoReturn}`)} data-testid="sso-saml">
                Continue with {p.saml.display_name || 'SAML single sign-on'}
              </Button>
            )}
          </div>
        )}
        {showPasskey && (
          <Button variant={showSso ? 'secondary' : 'primary'} icon={<Fingerprint size={14} />} loading={busy && state.step === 'form'} onClick={passkeyLogin} data-testid="passkey-login">
            Sign in with a passkey or security key
          </Button>
        )}
        {(showSso || showPasskey) && (p.local_login || breakGlass) && (
          <div className="my-1 flex items-center gap-3 text-[11px] uppercase tracking-wider text-ink-faint">
            <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
          </div>
        )}
        {localAvailable || showLdap ? (
          <form onSubmit={submitPassword} className="flex flex-col gap-3" data-testid={useDirectory ? 'ldap-form' : 'password-form'}>
            {showLdap && localAvailable && (
              <div className="flex rounded-md border border-line p-0.5 text-[12.5px]" role="tablist" aria-label="Account type">
                {(
                  [
                    ['local', 'Console account'],
                    ['ldap', p.ldap?.display_name || 'Directory account'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={useDirectory === (k === 'ldap')}
                    onClick={() => setDirectory(k === 'ldap')}
                    className={`flex-1 rounded px-2 py-1 ${useDirectory === (k === 'ldap') ? 'bg-accent-soft text-ink font-medium' : 'text-ink-muted hover:text-ink'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {useDirectory ? (
              <Field label="Username" hint={p.ldap?.display_name ? `Your ${p.ldap.display_name} account` : undefined}>
                <Input autoComplete="username" autoFocus={!showSso} required value={username} onChange={(e) => setUsername(e.target.value)} data-testid="ldap-username" />
              </Field>
            ) : (
              <Field label="Email">
                <Input type="email" autoComplete="username webauthn" autoFocus={!showSso} required value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
            )}
            <Field label="Password">
              <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {state.error && <ErrorBox>{state.error}</ErrorBox>}
            <Button type="submit" variant="primary" loading={busy} disabled={!!state.lockedForS} className="mt-1" icon={useDirectory ? <Building2 size={14} /> : undefined}>
              {useDirectory ? `Sign in with ${p.ldap?.display_name || 'directory account'}` : 'Sign in'}
            </Button>
          </form>
        ) : (
          !showSso && !showPasskey && <ErrorBox>No sign-in method is available. An administrator needs to enable single sign-on or password login.</ErrorBox>
        )}
        {policyNote && (
          <p className="text-[12px] text-ink-faint" data-testid="require-2fa-note">
            {policyNote}
          </p>
        )}
        {!p.local_login && !breakGlass && (
          <p className="text-[12px] text-ink-faint">
            Password sign-in is disabled on this console.{' '}
            <button type="button" className="text-accent hover:underline" onClick={() => setBreakGlass(true)}>
              Break-glass administrator sign-in
            </button>
          </p>
        )}
      </div>
    </AuthShell>
  )
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
      {children}
    </div>
  )
}
