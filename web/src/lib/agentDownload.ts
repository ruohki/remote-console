import { create } from 'zustand'
import type { AgentPlatform } from './types'

/**
 * Fetch-driven agent downloads.
 *
 * Baking a branded agent can take a minute (signing + Apple notarization on first download), so
 * a plain `<a href>` would leave the user staring at a button that does nothing. Instead the
 * download is fetched with progress, saved through an object URL, and its outcome (signed /
 * notarized headers) is shown inline. State lives in a module-level store keyed by platform so
 * navigating away and back still shows "download in progress".
 */

export type DownloadPhase = 'idle' | 'baking' | 'receiving' | 'saving' | 'done' | 'error'

export interface DownloadOutcome {
  signed: boolean
  notarized: boolean
}

export interface DownloadState {
  phase: DownloadPhase
  /** epoch ms when the request started (drives the "still signing…" copy) */
  startedAt: number
  receivedBytes: number
  totalBytes: number | null
  filename: string | null
  outcome: DownloadOutcome | null
  error: string | null
}

export const IDLE: DownloadState = { phase: 'idle', startedAt: 0, receivedBytes: 0, totalBytes: null, filename: null, outcome: null, error: null }

interface DownloadStore {
  byPlatform: Partial<Record<AgentPlatform, DownloadState>>
  set: (platform: AgentPlatform, patch: Partial<DownloadState>) => void
  reset: (platform: AgentPlatform) => void
}

export const useAgentDownloadStore = create<DownloadStore>((set) => ({
  byPlatform: {},
  set: (platform, patch) => set((s) => ({ byPlatform: { ...s.byPlatform, [platform]: { ...(s.byPlatform[platform] ?? IDLE), ...patch } } })),
  reset: (platform) => set((s) => ({ byPlatform: { ...s.byPlatform, [platform]: IDLE } })),
}))

/** Hook: state of one platform's download (idle when nothing happened yet). */
export function useAgentDownload(platform: AgentPlatform): DownloadState {
  return useAgentDownloadStore((s) => s.byPlatform[platform] ?? IDLE)
}

export function isInFlight(phase: DownloadPhase): boolean {
  return phase === 'baking' || phase === 'receiving' || phase === 'saving'
}

/** Build the download URL with the optional enrollment token / quick-support flag. */
export function agentDownloadUrl(platform: AgentPlatform, opts: { token?: string; quick?: boolean } = {}): string {
  const params = new URLSearchParams()
  if (opts.token) params.set('token', opts.token)
  if (opts.quick) params.set('quick', '1')
  const qs = params.toString()
  return `/api/agent/download/${platform}${qs ? `?${qs}` : ''}`
}

/**
 * Extract the file name from a `Content-Disposition` header. Handles the RFC 5987
 * `filename*=UTF-8''…` form (preferred when present), quoted and bare `filename=` values.
 */
export function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null
  const star = /filename\*\s*=\s*(?:([\w-]+)'[^']*')?([^;]+)/i.exec(header)
  if (star && star[2]) {
    const raw = star[2].trim().replace(/^"(.*)"$/, '$1')
    try {
      return sanitizeFilename(decodeURIComponent(raw))
    } catch {
      return sanitizeFilename(raw)
    }
  }
  const quoted = /filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(header)
  // Only `\"` and `\\` are escapes in a quoted-string; Windows paths keep their backslashes.
  if (quoted?.[1] !== undefined) return sanitizeFilename(quoted[1].replace(/\\(["\\])/g, '$1'))
  const bare = /filename\s*=\s*([^;\s]+)/i.exec(header)
  if (bare?.[1]) return sanitizeFilename(bare[1])
  return null
}

function sanitizeFilename(name: string): string | null {
  // strip any path component a hostile header might smuggle in
  const base = name.split(/[\\/]/).pop()?.trim() ?? ''
  return base.length > 0 ? base : null
}

/** Map the bakery's outcome headers to booleans (absent header = false). */
export function outcomeFromHeaders(headers: Headers): DownloadOutcome {
  const flag = (name: string) => {
    const v = headers.get(name)
    return v === '1' || v?.toLowerCase() === 'true'
  }
  return { signed: flag('x-agent-signed'), notarized: flag('x-agent-notarized') }
}

/** Human status for the in-flight phases; `signingConfigured` picks the honest copy. */
export function phaseLabel(state: DownloadState, signingConfigured: boolean, now: number = Date.now()): string {
  switch (state.phase) {
    case 'baking': {
      const elapsed = now - state.startedAt
      if (signingConfigured && elapsed > 2500) return 'Signing & notarizing…'
      return 'Baking…'
    }
    case 'receiving': {
      const mb = (n: number) => (n / 1_048_576).toFixed(1)
      return state.totalBytes ? `Receiving ${mb(state.receivedBytes)} / ${mb(state.totalBytes)} MB` : `Receiving ${mb(state.receivedBytes)} MB`
    }
    case 'saving':
      return 'Saving…'
    case 'done':
      return 'Downloaded'
    case 'error':
      return state.error ?? 'Failed'
    default:
      return ''
  }
}

/** Longer explanation shown under the spinner while the console works. */
export function phaseHint(state: DownloadState, signingConfigured: boolean, now: number = Date.now()): string | null {
  if (state.phase !== 'baking') return null
  if (!signingConfigured) return ''
  return now - state.startedAt > 2500
    ? 'Signing and notarizing — up to a minute the first time.'
    : 'Baking…'
}

// Module-level guard: one in-flight request per platform, survives unmounts / route changes.
const inflight = new Map<AgentPlatform, Promise<void>>()

export interface StartOptions {
  token?: string
  quick?: boolean
  /** called after a successful save (e.g. to refresh the downloads listing) */
  onDone?: (outcome: DownloadOutcome, filename: string) => void
  onError?: (message: string) => void
  /** test seam */
  fetchImpl?: typeof fetch
  save?: (blob: Blob, filename: string) => void
}

/** Start (or join) the download for `platform`. Returns when the file has been handed to the browser. */
export function startAgentDownload(platform: AgentPlatform, opts: StartOptions = {}): Promise<void> {
  const existing = inflight.get(platform)
  if (existing) return existing
  const run = performDownload(platform, opts).finally(() => inflight.delete(platform))
  inflight.set(platform, run)
  return run
}

export function isDownloadInFlight(platform: AgentPlatform): boolean {
  return inflight.has(platform)
}

async function performDownload(platform: AgentPlatform, opts: StartOptions): Promise<void> {
  const store = useAgentDownloadStore.getState()
  const fetchImpl = opts.fetchImpl ?? fetch
  const save = opts.save ?? saveBlob
  store.set(platform, { ...IDLE, phase: 'baking', startedAt: Date.now() })

  let res: Response
  try {
    res = await fetchImpl(agentDownloadUrl(platform, opts), { credentials: 'same-origin', headers: { Accept: 'application/octet-stream, application/zip, application/json' } })
  } catch {
    return fail(platform, 'Console unreachable.', opts)
  }

  if (!res.ok) {
    return fail(platform, await errorFromResponse(res), opts)
  }

  const outcome = outcomeFromHeaders(res.headers)
  const filename = filenameFromContentDisposition(res.headers.get('content-disposition')) ?? defaultFilename(platform)
  const total = Number(res.headers.get('content-length'))
  store.set(platform, { phase: 'receiving', receivedBytes: 0, totalBytes: Number.isFinite(total) && total > 0 ? total : null, filename, outcome })

  let blob: Blob
  try {
    blob = await readWithProgress(res, (received) => store.set(platform, { receivedBytes: received }))
  } catch {
    return fail(platform, 'Download interrupted.', opts)
  }

  store.set(platform, { phase: 'saving' })
  try {
    save(blob, filename)
  } catch {
    return fail(platform, 'Could not save the file.', opts)
  }
  store.set(platform, { phase: 'done', receivedBytes: blob.size, totalBytes: blob.size })
  opts.onDone?.(outcome, filename)
}

function fail(platform: AgentPlatform, message: string, opts: StartOptions) {
  useAgentDownloadStore.getState().set(platform, { phase: 'error', error: message })
  opts.onError?.(message)
}

async function errorFromResponse(res: Response): Promise<string> {
  const generic: Record<number, string> = {
    401: 'Admin sign-in or a valid enrollment token required.',
    404: 'Not available for this platform.',
    410: 'Enrollment token exhausted or expired.',
  }
  try {
    const text = await res.text()
    const json = text ? (JSON.parse(text) as { error?: { message?: string } }) : undefined
    if (json?.error?.message) return json.error.message
  } catch {
    /* not JSON */
  }
  return generic[res.status] ?? `The console answered with HTTP ${res.status}.`
}

async function readWithProgress(res: Response, onProgress: (received: number) => void): Promise<Blob> {
  const type = res.headers.get('content-type') ?? 'application/octet-stream'
  if (!res.body || typeof res.body.getReader !== 'function') {
    const blob = await res.blob()
    onProgress(blob.size)
    return blob
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let lastReport = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      received += value.byteLength
      // throttle store writes to ~10/s
      const now = Date.now()
      if (now - lastReport > 100) {
        lastReport = now
        onProgress(received)
      }
    }
  }
  onProgress(received)
  return new Blob(chunks as BlobPart[], { type })
}

function defaultFilename(platform: AgentPlatform): string {
  return platform === 'macos-universal' ? 'remote-agent.zip' : `remote-agent-${platform}.exe`
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Give the browser a moment to start the save before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
