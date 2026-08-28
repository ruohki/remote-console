import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Apple, Check, ChevronDown, Download, Loader2, Monitor } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import type { AgentDownload, AgentPlatform } from '@/lib/types'
import { bytes } from '@/lib/format'
import { toast } from '@/lib/toast'
import { agentDownloadUrl, isInFlight, phaseHint, phaseLabel, startAgentDownload, useAgentDownload, useAgentDownloadStore, type DownloadOutcome } from '@/lib/agentDownload'
import { Badge, Button, EmptyState, Skeleton, Table, Td, Th, Toggle, cx } from './ui'

export { agentDownloadUrl }

export const PLATFORMS: { id: AgentPlatform; label: string; short: string; ext: string; icon: typeof Apple }[] = [
  { id: 'macos-universal', label: 'macOS (Apple silicon + Intel)', short: 'macOS', ext: '.zip (app bundle)', icon: Apple },
  { id: 'windows-x86_64', label: 'Windows x64', short: 'Windows x64', ext: '.exe', icon: Monitor },
  { id: 'windows-aarch64', label: 'Windows ARM64', short: 'Windows ARM64', ext: '.exe', icon: Monitor },
]

export function useAgentDownloads(enabled = true) {
  return useQuery({ queryKey: ['agent-downloads'], queryFn: () => api.get<AgentDownload[]>('/api/agent/downloads'), enabled, staleTime: 60_000 })
}

/** Re-renders once a second while a download is in flight so the status copy can evolve. */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

/** Starts the fetch-driven download and reports the outcome via toasts + the downloads listing. */
function useStartDownload() {
  const qc = useQueryClient()
  return (platform: AgentPlatform, opts: { token?: string; quick?: boolean }) =>
    startAgentDownload(platform, {
      ...opts,
      onDone: (outcome, filename) => {
        void qc.invalidateQueries({ queryKey: ['agent-downloads'] })
        toast.success(`${filename} downloaded`, outcomeText(platform, outcome))
      },
      onError: (message) => toast.error('Agent download failed', message),
    })
}

function outcomeText(platform: AgentPlatform, o: DownloadOutcome): string {
  if (platform !== 'macos-universal') return o.signed ? 'Signed.' : 'Unsigned build.'
  if (o.notarized) return 'Signed and notarized — opens like any other app.'
  if (o.signed) return 'Signed but not notarized — other Macs may ask for “Open Anyway”.'
  return 'Unsigned — macOS will ask for “Open Anyway” on first launch.'
}

function OutcomeBadges({ platform, outcome }: { platform: AgentPlatform; outcome: DownloadOutcome }) {
  const isMac = platform === 'macos-universal'
  return (
    <span className="inline-flex items-center gap-1">
      {outcome.signed ? <Badge tone="live">Signed</Badge> : <Badge tone="warn">Unsigned</Badge>}
      {isMac && (outcome.notarized ? <Badge tone="live">Notarized</Badge> : <Badge tone="warn">Not notarized</Badge>)}
    </span>
  )
}

/**
 * One platform's download control: a button that turns into a spinner with live status while the
 * console bakes, signs and notarizes, then shows the outcome. `compact` is the dropdown-row layout.
 */
export function AgentDownloadButton({
  platform,
  token,
  quick,
  download,
  listingPending,
  compact = false,
  onStarted,
}: {
  platform: AgentPlatform
  token?: string
  quick?: boolean
  download: AgentDownload | undefined
  listingPending?: boolean
  compact?: boolean
  onStarted?: () => void
}) {
  const state = useAgentDownload(platform)
  const start = useStartDownload()
  const busy = isInFlight(state.phase)
  const now = useTicker(busy)
  const signingConfigured = !!download?.signing_configured
  const unavailable = !listingPending && (!download || !download.available)
  const meta = PLATFORMS.find((p) => p.id === platform)!
  const label = phaseLabel(state, signingConfigured, now)
  const hint = phaseHint(state, signingConfigured, now)

  const trigger = () => {
    if (busy || unavailable) return
    onStarted?.()
    void start(platform, { token, quick })
  }

  if (compact) {
    return (
      <button
        type="button"
        role="menuitem"
        aria-disabled={unavailable || busy}
        aria-busy={busy}
        onClick={trigger}
        className={cx(
          'flex w-full items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px]',
          unavailable ? 'cursor-not-allowed text-ink-faint' : busy ? 'cursor-progress' : 'hover:bg-raised',
        )}
      >
        {busy ? <Loader2 size={14} className="mt-0.5 animate-spin text-accent" /> : <meta.icon size={14} className="mt-0.5 text-ink-muted" />}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="flex-1">{meta.label}</span>
            {listingPending && <Skeleton className="h-3 w-10" />}
            {!busy && download?.available && download.size !== undefined && <span className="mono text-ink-faint">{bytes(download.size)}</span>}
            {unavailable && <span className="text-[11px]">not available</span>}
          </span>
          {busy && (
            <span className="mt-0.5 block text-[11.5px] text-ink-muted" aria-live="polite">
              {label}
            </span>
          )}
          {state.phase === 'done' && state.outcome && (
            <span className="mt-0.5 flex items-center gap-1 text-[11.5px] text-ink-muted">
              <Check size={11} className="text-live" /> {state.filename} · <OutcomeBadges platform={platform} outcome={state.outcome} />
            </span>
          )}
          {state.phase === 'error' && (
            <span className="mt-0.5 flex items-center gap-1 text-[11.5px] text-danger">
              <AlertCircle size={11} /> {state.error}
            </span>
          )}
        </span>
      </button>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" icon={<Download size={13} />} loading={busy} disabled={unavailable} onClick={trigger} aria-busy={busy} title={unavailable ? 'No base binary available for this platform' : undefined}>
        {busy ? label : 'Download'}
      </Button>
      {busy && hint && (
        <span className="max-w-[16rem] text-right text-[11px] leading-snug text-ink-faint" aria-live="polite">
          {hint}
        </span>
      )}
      {state.phase === 'done' && state.outcome && (
        <span className="flex items-center gap-1 text-[11.5px] text-ink-muted">
          <Check size={11} className="text-live" />
          <span className="mono">{state.filename}</span>
          <OutcomeBadges platform={platform} outcome={state.outcome} />
        </span>
      )}
      {state.phase === 'error' && (
        <span className="flex max-w-[18rem] items-center gap-1 text-right text-[11.5px] text-danger">
          <AlertCircle size={11} className="shrink-0" /> {state.error}
        </span>
      )}
    </div>
  )
}

/**
 * Dropdown offering the baked agent per platform. With `token` the binary enrolls itself with
 * that token; the quick-support switch produces a foreground build that offers "Install as a service".
 * Downloads run through {@link AgentDownloadButton}, so the menu stays open while a download is in
 * flight and shows its progress.
 */
export function AgentDownloadMenu({ token, label = 'Download agent', size = 'md', variant = 'secondary', align = 'right' }: { token?: string; label?: string; size?: 'sm' | 'md'; variant?: 'secondary' | 'primary' | 'ghost'; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const [quick, setQuick] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const downloads = useAgentDownloads(open)
  const snapshot = useAgentDownloadStore((s) => s.byPlatform)
  const anyBusy = PLATFORMS.some((p) => isInFlight(snapshot[p.id]?.phase ?? 'idle'))

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
      <Button size={size} variant={variant} icon={anyBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        {anyBusy ? 'Preparing download…' : label}
        <ChevronDown size={12} className="ml-0.5 opacity-70" />
      </Button>
      {open && (
        <div role="menu" className={cx('panel animate-fade-up absolute z-40 mt-1 w-80 p-1 shadow-pop', align === 'right' ? 'right-0' : 'left-0')}>
          {PLATFORMS.map((p) => (
            <AgentDownloadButton key={p.id} platform={p.id} token={token} quick={quick} download={byPlatform.get(p.id)} listingPending={downloads.isPending} compact />
          ))}
          {downloads.isError && <div className="px-2.5 py-1.5 text-[12px] text-danger">{errorMessage(downloads.error)}</div>}
          <p className="px-2.5 pt-1.5 pb-1 text-[11px] text-ink-faint">The first download of a build takes up to a minute when the console signs and notarizes it; later ones are instant.</p>
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
        <>
          <Table>
            <thead>
              <tr>
                <Th>Platform</Th>
                <Th>Status</Th>
                <Th>Signing</Th>
                <Th>Source</Th>
                <Th className="text-right">Size</Th>
                <Th className="w-44" />
              </tr>
            </thead>
            <tbody>
              {PLATFORMS.map((p) => {
                const d = downloads.data.find((x) => x.platform === p.id)
                const ok = !!d?.available
                return (
                  <tr key={p.id} className="row-hover align-top">
                    <Td>
                      <div className="flex items-center gap-2">
                        <p.icon size={14} className="text-ink-muted" />
                        <span className="font-medium">{p.label}</span>
                        <span className="mono text-ink-faint">
                          {p.id}
                          {p.ext}
                        </span>
                      </div>
                    </Td>
                    <Td>{ok ? <Badge tone="live">Available</Badge> : <Badge tone="warn">Not available</Badge>}</Td>
                    <Td>
                      <SigningBadge d={d} platform={p.id} />
                    </Td>
                    <Td className="text-ink-muted">{d ? (d.source === 'local' ? 'AGENT_BINARY_DIR' : 'GitHub release') : '—'}</Td>
                    <Td className="mono text-right text-ink-muted">{d?.size !== undefined ? bytes(d.size) : '—'}</Td>
                    <Td className="text-right">
                      <AgentDownloadButton platform={p.id} download={d} />
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
          <p className="-mt-2 text-[12px] text-ink-faint">
            The first download of a build is baked on demand — with signing and notarization configured that takes up to a minute; the result is cached, so
            later downloads are instant. macOS downloads are a <span className="mono">&lt;Product&gt;.zip</span> containing <span className="mono">&lt;Product&gt;.app</span>:
            when notarized it opens directly, otherwise macOS asks for “Open Anyway” once.
          </p>
        </>
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
