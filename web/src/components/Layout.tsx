import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router'
import {
  Activity,
  ChevronsUpDown,
  ClipboardList,
  FolderKanban,
  LogOut,
  type LucideIcon,
  Menu,
  MonitorSmartphone,
  Moon,
  Settings,
  ShieldCheck,
  Sun,
  SunMoon,
  Users,
  X,
} from 'lucide-react'
import { useAuth } from '@/store/auth'
import { useLive } from '@/store/live'
import { applyTheme, readTheme, type Theme } from '@/lib/theme'
import type { WsStatus } from '@/lib/ws'
import { cx } from './ui'
import { toast } from '@/lib/toast'
import { DEFAULT_BRANDING, consoleBranding, logoUrl, useBranding } from '@/lib/branding'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
}
interface NavGroup {
  label: string
  admin?: boolean
  items: NavItem[]
}

// Operator work first, admin plumbing second, the console itself last. Settings' own
// sub-pages live in its tab strip, so they are not repeated here.
const GROUPS: NavGroup[] = [
  {
    label: 'Operate',
    items: [
      { to: '/devices', label: 'Devices', icon: MonitorSmartphone },
      { to: '/sessions', label: 'Sessions', icon: Activity },
    ],
  },
  {
    label: 'Manage',
    admin: true,
    items: [
      { to: '/groups', label: 'Groups', icon: FolderKanban },
      { to: '/users', label: 'Users', icon: Users },
      { to: '/audit', label: 'Audit', icon: ClipboardList },
    ],
  },
  {
    label: 'Console',
    items: [{ to: '/settings', label: 'Settings', icon: Settings, end: true }],
  },
]

export function Layout() {
  const { user, logout } = useAuth()
  const wsStatus = useLive((s) => s.wsStatus)
  const online = useLive((s) => Object.values(s.devices).filter((d) => d.online).length)
  const inSession = useLive((s) => Object.values(s.sessions).filter((x) => x.state !== 'ended').length)
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const isAdmin = user?.role === 'admin'

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

  // Escape closes the mobile drawer.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const close = () => setOpen(false)

  return (
    <div className="flex h-full">
      {/* sidebar */}
      <aside
        id="console-nav"
        aria-label="Console navigation"
        className={cx(
          'fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-line bg-ground transition-transform max-md:shadow-pop md:static md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 shrink-0 items-center px-4">
          <Wordmark />
          <button
            type="button"
            className="ml-auto rounded-md p-1 text-ink-faint hover:bg-surface hover:text-ink md:hidden dark:hover:bg-raised"
            onClick={close}
            aria-label="Close menu"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <Cluster online={online} inSession={inSession} status={wsStatus} onNavigate={close} />

        <nav aria-label="Primary" className="min-h-0 flex-1 overflow-y-auto pb-3">
          {GROUPS.filter((g) => !g.admin || isAdmin).map((g) => (
            <div key={g.label}>
              <div className="eyebrow px-4 pt-4 pb-1">{g.label}</div>
              {g.items.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.end}
                  onClick={close}
                  className={({ isActive }) =>
                    cx(
                      'relative flex items-center gap-2.5 px-4 py-[7px] text-[13px] transition-colors focus-visible:outline-offset-[-2px]',
                      // the sidebar sits on `ground`, so the lift is `surface` (dark: `raised`)
                      isActive ? 'bg-surface font-medium text-ink dark:bg-raised' : 'text-ink-muted hover:bg-surface hover:text-ink dark:hover:bg-raised',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && <span aria-hidden className="absolute top-1/2 left-0 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-accent" />}
                      <n.icon size={15} aria-hidden className={cx('shrink-0', isActive ? 'text-accent' : 'text-ink-faint')} />
                      {n.label}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <UserRow
          name={user?.name ?? ''}
          role={user?.role ?? 'operator'}
          onNavigate={close}
          onSignOut={async () => {
            await logout()
            toast.info('Signed out')
            navigate('/login')
          }}
        />
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={close} aria-hidden />}

      {/* main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 md:hidden">
          <button
            type="button"
            className="rounded-md p-1.5 text-ink-muted hover:bg-raised hover:text-ink"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            aria-controls="console-nav"
            aria-expanded={open}
          >
            <Menu size={18} aria-hidden />
          </button>
          <Wordmark />
        </div>
        <main className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export function Wordmark({ className }: { className?: string }) {
  const branding = consoleBranding(useBranding().data)
  const logo = logoUrl(branding)
  return (
    <span className={cx('flex min-w-0 items-center gap-2 font-semibold tracking-tight', className)}>
      {logo ? (
        <img src={logo} alt="" className="size-6 shrink-0 rounded-md object-contain" />
      ) : (
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent text-accent-ink">
          <MonitorSmartphone size={14} />
        </span>
      )}
      <span className="truncate">{branding.product_name || DEFAULT_BRANDING.product_name}</span>
    </span>
  )
}

/* ───────────── Instrument cluster ───────────── */

const LINK: Record<WsStatus, { led: string; text: string; title: string }> = {
  open: { led: 'led-live', text: 'Live', title: 'Live updates connected' },
  connecting: { led: 'led-warn', text: 'Retrying', title: 'Reconnecting live updates' },
  closed: { led: 'led-off', text: 'Off', title: 'Live updates disconnected' },
}

function Cluster({ online, inSession, status, onNavigate }: { online: number; inSession: number; status: WsStatus; onNavigate: () => void }) {
  const link = LINK[status]
  return (
    <div className="mx-3 mb-2 overflow-hidden rounded-lg border border-line bg-surface">
      <div className="grid grid-cols-2 divide-x divide-line">
        <Readout to="/devices" label="Online" value={online} onClick={onNavigate} />
        <Readout to="/sessions" label="In session" value={inSession} tone={inSession > 0 ? 'text-live' : undefined} onClick={onNavigate} />
      </div>
      <div className="flex items-center border-t border-line px-3 py-1.5" title={link.title}>
        <span className="text-[10.5px] tracking-[0.1em] text-ink-faint uppercase">Link</span>
        <span className="ml-auto flex items-center gap-2 text-[12px] font-medium text-ink-muted">
          <span className={cx('led', link.led)} aria-hidden />
          {link.text}
        </span>
      </div>
    </div>
  )
}

function Readout({ to, label, value, tone, onClick }: { to: string; label: string; value: number; tone?: string; onClick: () => void }) {
  return (
    <Link to={to} onClick={onClick} className="block px-3 py-2.5 transition-colors hover:bg-raised focus-visible:outline-offset-[-2px]">
      <div className={cx('font-mono text-[20px] leading-none font-semibold tabular-nums', tone ?? 'text-ink')}>{value}</div>
      <div className="mt-1 text-[10.5px] tracking-[0.1em] text-ink-faint uppercase">{label}</div>
    </Link>
  )
}

/* ───────────── User row + menu ───────────── */

const THEMES: { value: Theme; label: string; icon: LucideIcon }[] = [
  { value: 'system', label: 'System', icon: SunMoon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

function ThemeSegments() {
  const [theme, setTheme] = useState<Theme>(() => readTheme())
  return (
    <div role="group" aria-label="Theme" className="grid grid-cols-3 gap-0.5 rounded-md bg-ground p-0.5">
      {THEMES.map((o) => {
        const selected = theme === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            onClick={() => {
              setTheme(o.value)
              applyTheme(o.value)
            }}
            className={cx(
              'flex items-center justify-center gap-1.5 rounded-[5px] px-1 py-1.5 text-[12px] transition-colors',
              selected ? 'bg-surface font-medium text-ink shadow-sm ring-1 ring-line dark:bg-raised' : 'text-ink-muted hover:text-ink',
            )}
          >
            <o.icon size={14} aria-hidden />
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function UserRow({ name, role, onNavigate, onSignOut }: { name: string; role: string; onNavigate: () => void; onSignOut: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const item = 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink-muted hover:bg-raised hover:text-ink'

  return (
    <div ref={ref} className="relative mt-auto border-t border-line p-2">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-surface dark:hover:bg-raised"
      >
        <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-md bg-raised text-[11px] font-semibold text-ink-muted uppercase ring-1 ring-line">
          {name.slice(0, 1) || '?'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-tight font-medium">{name || 'Signed in'}</span>
          <span className="block text-[11px] leading-tight text-ink-faint">{role === 'admin' ? 'Administrator' : 'Operator'}</span>
        </span>
        <ChevronsUpDown size={14} aria-hidden className="shrink-0 text-ink-faint" />
      </button>

      {open && (
        <div role="menu" aria-label="Account" className="panel animate-fade-up absolute right-2 bottom-full left-2 mb-1.5 p-1 shadow-pop">
          <ThemeSegments />
          <div className="my-1 border-t border-line" />
          <Link
            role="menuitem"
            to="/security"
            onClick={() => {
              setOpen(false)
              onNavigate()
            }}
            className={item}
          >
            <ShieldCheck size={14} aria-hidden /> Account security
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onSignOut()
            }}
            className={item}
          >
            <LogOut size={14} aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  )
}
