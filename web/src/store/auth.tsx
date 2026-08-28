import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import type { User } from '@/lib/types'
import { uiSocket } from '@/lib/ws'
import { useLive } from './live'

interface AuthState {
  /** undefined while bootstrapping */
  user: User | null | undefined
  needsSetup: boolean | undefined
  login: (email: string, password: string) => Promise<User>
  setup: (email: string, name: string, password: string) => Promise<User>
  logout: () => Promise<void>
  /** called by the API layer / pages on a 401 */
  clear: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [needsSetup, setNeedsSetup] = useState<boolean | undefined>(undefined)

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
        const { user } = await api.get<{ user: User }>('/api/auth/me')
        if (!cancelled) setUser(user)
      } catch (err) {
        if (!cancelled) setUser(err instanceof ApiError && err.isUnauthorized ? null : null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // The live socket follows the auth state.
  useEffect(() => {
    if (user) {
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

  const login = useCallback(async (email: string, password: string) => {
    const { user } = await api.post<{ user: User }>('/api/auth/login', { email, password })
    setUser(user)
    return user
  }, [])

  const setup = useCallback(async (email: string, name: string, password: string) => {
    const { user } = await api.post<{ user: User }>('/api/setup', { email, name, password })
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

  const value = useMemo(() => ({ user, needsSetup, login, setup, logout, clear }), [user, needsSetup, login, setup, logout, clear])
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
