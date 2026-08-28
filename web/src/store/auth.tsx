import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import type { LoginPending, User } from '@/lib/types'
import { uiSocket } from '@/lib/ws'
import { useLive } from './live'

export type LoginResult = { kind: 'ok'; user: User } | { kind: 'pending'; pending: LoginPending }

interface AuthState {
  /** undefined while bootstrapping */
  user: User | null | undefined
  needsSetup: boolean | undefined
  /** Password step; a `pending` result means a second factor is required (no session yet). */
  login: (email: string, password: string) => Promise<LoginResult>
  /** Directory (LDAP simple bind) sign-in; same 200/202 semantics as `login`. */
  loginLdap: (username: string, password: string) => Promise<LoginResult>
  /** Called once a session exists (after 2FA / passkey / SSO return). */
  completeLogin: (user: User) => void
  /** Re-read `/api/auth/me` (after enrolling 2FA, adding passkeys, …). */
  refresh: () => Promise<User | null>
  setup: (email: string, name: string, password: string) => Promise<User>
  logout: () => Promise<void>
  /** called by the API layer / pages on a 401 */
  clear: () => void
}

const AuthContext = createContext<AuthState | null>(null)

/** `/api/auth/me`, `/api/setup` and login answers wrap the user with policy fields. */
export function envelopeUser(env: { user: User; two_factor_required?: boolean; auth_method?: User['auth_method'] }): User {
  return { ...env.user, two_factor_required: env.two_factor_required ?? env.user.two_factor_required, auth_method: env.auth_method ?? env.user.auth_method }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [needsSetup, setNeedsSetup] = useState<boolean | undefined>(undefined)

  const refresh = useCallback(async () => {
    try {
      const env = await api.get<{ user: User; two_factor_required?: boolean; auth_method?: User['auth_method'] }>('/api/auth/me')
      const user = envelopeUser(env)
      setUser(user)
      return user
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) setUser(null)
      return null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { needs_setup } = await api.get<{ needs_setup: boolean }>('/api/setup')
        if (cancelled) return
        setNeedsSetup(needs_setup)
        if (needs_setup) {
          setUser(null)
          return
        }
      } catch {
        if (!cancelled) setNeedsSetup(false)
      }
      try {
        const env = await api.get<{ user: User; two_factor_required?: boolean; auth_method?: User['auth_method'] }>('/api/auth/me')
        if (!cancelled) setUser(envelopeUser(env))
      } catch {
        if (!cancelled) setUser(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // The 2FA policy gate answers any API call with 403 two_factor_required until the user
  // enrolled; flip the flag so the router sends them to /security/setup.
  useEffect(() => {
    const onGate = () => setUser((u) => (u && !u.two_factor_required ? { ...u, two_factor_required: true } : u))
    window.addEventListener('console:two-factor-required', onGate)
    return () => window.removeEventListener('console:two-factor-required', onGate)
  }, [])

  // The live socket follows the auth state (not while enrollment is pending: the gate would reject it).
  useEffect(() => {
    if (user && !user.two_factor_required) {
      const off = uiSocket.onStatus((s) => useLive.getState().setWsStatus(s))
      const offMsg = uiSocket.onMessage((m) => useLive.getState().apply(m))
      uiSocket.connect()
      return () => {
        off()
        offMsg()
        uiSocket.disconnect()
        useLive.getState().reset()
      }
    }
  }, [user])

  const loginAt = useCallback(async (path: string, body: Record<string, string>): Promise<LoginResult> => {
    const { status, data } = await api.postWithStatus<{ user: User; two_factor_required?: boolean; auth_method?: string } | LoginPending>(path, body)
    if (status === 202 && 'pending' in data) return { kind: 'pending', pending: data }
    const env = data as { user: User; two_factor_required?: boolean; auth_method?: User['auth_method'] }
    // The envelope carries the policy state and the method used; keep them on the user object.
    const user: User = { ...env.user, two_factor_required: env.two_factor_required ?? env.user.two_factor_required, auth_method: env.auth_method ?? env.user.auth_method }
    setUser(user)
    return { kind: 'ok', user }
  }, [])
  const login = useCallback((email: string, password: string) => loginAt('/api/auth/login', { email, password }), [loginAt])
  const loginLdap = useCallback((username: string, password: string) => loginAt('/api/auth/ldap/login', { username, password }), [loginAt])

  const completeLogin = useCallback((user: User) => setUser(user), [])

  const setup = useCallback(async (email: string, name: string, password: string) => {
    const env = await api.post<{ user: User; two_factor_required?: boolean; auth_method?: User['auth_method'] }>('/api/setup', { email, name, password })
    const user = envelopeUser(env)
    setNeedsSetup(false)
    setUser(user)
    return user
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout')
    } finally {
      setUser(null)
    }
  }, [])

  const clear = useCallback(() => setUser(null), [])

  const value = useMemo(
    () => ({ user, needsSetup, login, loginLdap, completeLogin, refresh, setup, logout, clear }),
    [user, needsSetup, login, loginLdap, completeLogin, refresh, setup, logout, clear],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

export function useIsAdmin() {
  return useAuth().user?.role === 'admin'
}
