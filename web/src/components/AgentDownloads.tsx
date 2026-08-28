import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Apple, ChevronDown, Download, Monitor } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import type { AgentDownload, AgentPlatform } from '@/lib/types'
import { bytes } from '@/lib/format'
import { Badge, Button, EmptyState, Skeleton, Table, Td, Th, Toggle, cx } from './ui'

export const PLATFORMS: { id: AgentPlatform; label: string; short: string; ext: string; icon: typeof Apple }[] = [
  { id: 'macos-universal', label: 'macOS (Apple silicon + Intel)', short: 'macOS', ext: '.zip (app bundle)', icon: Apple },
  { id: 'windows-x86_64', label: 'Windows x64', short: 'Windows x64', ext: '.exe', icon: Monitor },
  { id: 'windows-aarch64', label: 'Windows ARM64', short: 'Windows ARM64', ext: '.exe', icon: Monitor },
]

/** `GET /api/agent/download/:platform` with the optional enrollment token / quick-support flag. */
export function agentDownloadUrl(platform: AgentPlatform, opts: { token?: string; quick?: boolean } = {}): string {
  const params = new URLSearchParams()
  if (opts.token) params.set('token', opts.token)
  if (opts.quick) params.set('quick', '1')
  const qs = params.toString()
  return `/api/agent/download/${platform}${qs ? `?${qs}` : ''}`
}

export function useAgentDownloads(enabled = true) {
  return useQuery({ queryKey: ['agent-downloads'], queryFn: () => api.get<AgentDownload[]>('/api/agent/downloads'), enabled, staleTime: 60_000 })
}

/**
 * Dropdown offering the baked agent per platform. With `token` the binary enrolls itself with
 * that token; the quick-support switch produces a foreground build that offers "Install as a service".
 */
export function AgentDownloadMenu({ token, label = 'Download agent', size = 'md', variant = 'secondary', align = 'right' }: { token?: string; label?: string; size?: 'sm' | 'md'; variant?: 'secondary' | 'primary' | 'ghost'; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const [quick, setQuick] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const downloads = useAgentDownloads(open)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const byPlatform = new Map((downloads.data ?? []).map((d) => [d.platform, d]))

  return (
    <div ref={ref} className="relative inline-block">
      <Button size={size} variant={variant} icon={<Download size={13} />} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        {label}
        <ChevronDown size={12} className="ml-0.5 opacity-70" />
      </Button>
      {open && (
        <div role="menu" className={cx('panel animate-fade-up absolute z-40 mt-1 w-72 p-1 shadow-pop', align === 'right' ? 'right-0' : 'left-0')}>
          {PLATFORMS.map((p) => {
            const d = byPlatform.get(p.id)
            const unavailable = downloads.isSuccess && (!d || !d.available)
            return (
              <a
                key={p.id}
                role="menuitem"
                href={unavailable ? undefined : agentDownloadUrl(p.id, { token, quick })}
                download
                aria-disabled={unavailable}
                onClick={(e) => {
                  if (unavailable) e.preventDefault()
                  else setOpen(false)
                }}
                className={cx('flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px]', unavailable ? 'cursor-not-allowed text-ink-faint' : 'hover:bg-raised')}
              >
                <p.icon size={14} className="text-ink-muted" />
                <span className="flex-1">{p.label}</span>
                {downloads.isPending && <Skeleton className="h-3 w-10" />}
                {d?.available && d.size !== undefined && <span className="mono text-ink-faint">{bytes(d.size)}</span>}
                {unavailable && <span className="text-[11px]">not available</span>}
              </a>
            )
          })}
          {downloads.isError && <div className="px-2.5 py-1.5 text-[12px] text-danger">{errorMessage(downloads.error)}</div>}
          {token && (
            <div className="mt-1 border-t border-line px-2.5 pt-2 pb-1">
              <Toggle checked={quick} onChange={setQuick} label="Quick support build" />
              <p className="mt-1 text-[11.5px] text-ink-faint">Runs in the foreground and offers “Install as a service” instead of installing right away.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SigningBadge({ d, platform }: { d: AgentDownload | undefined; platform: AgentPlatform }) {
  if (!d || !d.available) return <span className="text-ink-faint">—</span>
  const isMac = platform === 'macos-universal'
  if (d.notarized) return <Badge tone="live">Signed &amp; notarized</Badge>
  if (d.signed) return <Badge tone={isMac ? 'warn' : 'live'}>{isMac ? 'Signed, not notarized' : 'Signed'}</Badge>
  if (d.signing_configured) return <Badge tone="warn">Signing configured · not baked yet</Badge>
  return (
    <Badge tone="warn" className="whitespace-nowrap">
      Unsigned
    </Badge>
  )
}

/** Settings → Agent downloads: availability per platform plus an explanation of baking. */
export function AgentDownloadsPanel() {
  const downloads = useAgentDownloads()
  return (
    <div className="flex flex-col gap-4">
      <div className="panel p-4 text-ink-muted">
        <div className="mb-1 font-medium text-ink">What a branded agent is</div>
        <p>
          The console takes the released agent binary and appends a signed configuration: its own URL, the product name, colour and logo from{' '}
          <b>Branding</b>, and — when downloaded for an enrollment token — that token. The signature (ed25519, key shown on the Console tab) means a
          baked binary only ever talks to this console and cannot be pointed elsewhere.
        </p>
        <p className="mt-2">
          Install one-liners download the baked binary automatically; a baked agent that is started by double-clicking opens its application window
          and enrolls itself with the embedded token.
        </p>
      </div>
      <div className="flex items-center justify-between">
        <div className="text-ink-muted">Downloads use the branding as it is saved right now.</div>
        <AgentDownloadMenu label="Download branded agent" variant="primary" />
      </div>
      {downloads.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : downloads.isError ? (
        <div className="panel">
          <EmptyState title="Could not load the agent downloads" detail={errorMessage(downloads.error)} />
        </div>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Platform</Th>
              <Th>Status</Th>
              <Th>Signing</Th>
              <Th>Source</Th>
              <Th className="text-right">Size</Th>
              <Th className="w-32" />
            </tr>
          </thead>
          <tbody>
            {PLATFORMS.map((p) => {
              const d = downloads.data.find((x) => x.platform === p.id)
              const ok = !!d?.available
              return (
                <tr key={p.id} className="row-hover">
                  <Td>
                    <div className="flex items-center gap-2">
                      <p.icon size={14} className="text-ink-muted" />
                      <span className="font-medium">{p.label}</span>
                      <span className="mono text-ink-faint">{p.id}{p.ext}</span>
                    </div>
                  </Td>
                  <Td>{ok ? <Badge tone="live">Available</Badge> : <Badge tone="warn">Not available</Badge>}</Td>
                  <Td>
                    <SigningBadge d={d} platform={p.id} />
                  </Td>
                  <Td className="text-ink-muted">{d ? (d.source === 'local' ? 'AGENT_BINARY_DIR' : 'GitHub release') : '—'}</Td>
                  <Td className="mono text-right text-ink-muted">{d?.size !== undefined ? bytes(d.size) : '—'}</Td>
                  <Td className="text-right">
                    {ok ? (
                      <a href={agentDownloadUrl(p.id)} download className="inline-flex">
                        <Button size="sm" icon={<Download size={13} />}>
                          Download
                        </Button>
                      </a>
                    ) : (
                      <Button size="sm" disabled>
                        Download
                      </Button>
                    )}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </Table>
      )}
      <div className="panel p-4 text-[12.5px] text-ink-muted">
        <div className="mb-1 font-medium text-ink">macOS downloads and Gatekeeper</div>
        <p>
          macOS downloads are a <span className="mono">&lt;Product&gt;.zip</span> containing a double-clickable <span className="mono">&lt;Product&gt;.app</span>. When a
          Developer ID identity and notarization are configured on the console (<span className="mono">MACOS_SIGN_IDENTITY</span>,{' '}
          <span className="mono">MACOS_NOTARY_PROFILE</span>), the app is signed and notarized and opens like any other app.
        </p>
        <p className="mt-1.5">
          Without signing, macOS shows “Apple could not verify … is free of malware”. The person at the device then has to allow it once: System Settings →
          Privacy &amp; Security → <b>Open Anyway</b> (or remove the quarantine flag with <span className="mono">xattr -d com.apple.quarantine</span>).
        </p>
      </div>
      {downloads.isSuccess && downloads.data.every((d) => !d.available) && (
        <div className="rounded-md bg-warn-soft px-3 py-2 text-[12.5px]">
          No base binaries are available. Put release builds into <span className="mono">AGENT_BINARY_DIR</span> (files named like the release assets) or make sure
          the console can reach <span className="mono">AGENT_DOWNLOAD_BASE</span>.
        </div>
      )}
    </div>
  )
}
