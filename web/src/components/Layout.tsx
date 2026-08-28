import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router'
import { Activity, ClipboardList, FolderKanban, LogOut, Menu, MonitorSmartphone, Moon, Settings, Sun, SunMoon, Users, X } from 'lucide-react'
import { useAuth } from '@/store/auth'
import { useLive } from '@/store/live'
import { applyTheme, readTheme, type Theme } from '@/lib/theme'
import { cx } from './ui'
import { toast } from '@/lib/toast'

const NAV = [
  { to: '/devices', label: 'Devices', icon: MonitorSmartphone },
  { to: '/sessions', label: 'Sessions', icon: Activity },
  { to: '/groups', label: 'Groups', icon: FolderKanban, admin: true },
  { to: '/users', label: 'Users', icon: Users, admin: true },
  { to: '/audit', label: 'Audit', icon: ClipboardList, admin: true },
  { to: '/settings', label: 'Settings', icon: Settings },
]

export function Layout() {
  const { user, logout } = useAuth()
  const wsStatus = useLive((s) => s.wsStatus)
  const deviceCount = useLive((s) => Object.values(s.devices).filter((d) => d.online).length)
  const activeSessions = useLive((s) => Object.values(s.sessions).filter((x) => x.state !== 'ended').length)
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()

  // "/" focuses whichever search box the page exposes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const box = document.querySelector<HTMLInputElement>('input[data-search]')
      if (box) {
        e.preventDefault()
        box.focus()
        box.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const nav = (
    <nav className="flex flex-col gap-0.5 px-2">
      {NAV.filter((n) => !n.admin || user?.role === 'admin').map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            cx(
              'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
              isActive ? 'bg-accent-soft text-accent font-medium' : 'text-ink-muted hover:bg-raised hover:text-ink',
            )
          }
        >
          <n.icon size={15} />
          <span className="flex-1">{n.label}</span>
          {n.to === '/devices' && deviceCount > 0 && <span className="mono text-ink-faint">{deviceCount}</span>}
          {n.to === '/sessions' && activeSessions > 0 && (
            <span className="mono rounded-sm bg-live-soft px-1 text-live">{activeSessions}</span>
          )}
        </NavLink>
      ))}
    </nav>
  )

  return (
    <div className="flex h-full">
      {/* sidebar */}
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r border-line bg-surface transition-transform md:static md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-12 items-center gap-2 border-b border-line px-4">
          <Wordmark />
          <button className="ml-auto text-ink-faint md:hidden" onClick={() => setOpen(false)} aria-label="Close menu">
            <X size={16} />
          </button>
        </div>
        <div className="py-3">{nav}</div>
        <div className="mt-auto border-t border-line p-3">
          <ConnectionPill status={wsStatus} />
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setOpen(false)} />}

      {/* main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
          <button className="text-ink-muted md:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu size={18} />
          </button>
          <div className="text-ink-faint text-[12.5px] hidden sm:block">
            Press <span className="kbd">/</span> to search
          </div>
          <div className="ml-auto flex items-center gap-1">
            <ThemeButton />
            <UserMenu
              name={user?.name ?? ''}
              role={user?.role ?? 'operator'}
              onLogout={async () => {
                await logout()
                toast.info('Signed out')
                navigate('/login')
              }}
            />
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cx('flex items-center gap-2 font-semibold tracking-tight', className)}>
      <span className="grid size-6 place-items-center rounded-md bg-accent text-accent-ink">
        <MonitorSmartphone size={14} />
      </span>
      Remote Console
    </span>
  )
}

function ConnectionPill({ status }: { status: 'connecting' | 'open' | 'closed' }) {
  const map = {
    open: { cls: 'led-live', text: 'Live updates on' },
    connecting: { cls: 'led-warn', text: 'Reconnecting…' },
    closed: { cls: 'led-off', text: 'Live updates off' },
  }[status]
  return (
    <div className="flex items-center gap-2 text-[12px] text-ink-muted">
      <span className={cx('led', map.cls)} />
      {map.text}
    </div>
  )
}

function ThemeButton() {
  const [theme, setTheme] = useState<Theme>(() => readTheme())
  const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' }
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : SunMoon
  return (
    <button
      className="rounded-md p-1.5 text-ink-muted hover:bg-raised hover:text-ink"
      title={`Theme: ${theme}`}
      onClick={() => {
        const t = next[theme]
        setTheme(t)
        applyTheme(t)
      }}
    >
      <Icon size={16} />
    </button>
  )
}

function UserMenu({ name, role, onLogout }: { name: string; role: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-raised">
        <span className="grid size-6 place-items-center rounded-full bg-raised text-[11px] font-semibold uppercase text-ink-muted">
          {name.slice(0, 1) || '?'}
        </span>
        <span className="hidden text-[13px] sm:block">{name}</span>
        <span className="eyebrow hidden sm:block">{role}</span>
      </button>
      {open && (
        <div className="panel animate-fade-up absolute right-0 mt-1 w-44 p-1 shadow-pop">
          <button onClick={onLogout} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-raised">
            <LogOut size={14} /> Sign out
          </button>
        </div>
      )}
    </div>
  )
}
