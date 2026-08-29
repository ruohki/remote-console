import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IDLE,
  filenameFromContentDisposition,
  isInFlight,
  outcomeFromHeaders,
  phaseHint,
  phaseLabel,
  startAgentDownload,
  useAgentDownloadStore,
} from './agentDownload'

describe('filenameFromContentDisposition', () => {
  it('reads quoted, bare and RFC 5987 encoded names', () => {
    expect(filenameFromContentDisposition('attachment; filename="Roj-Remote-Care.zip"')).toBe('Roj-Remote-Care.zip')
    expect(filenameFromContentDisposition('attachment; filename=agent-windows-x86_64.exe')).toBe('agent-windows-x86_64.exe')
    expect(filenameFromContentDisposition("attachment; filename=\"fallback.zip\"; filename*=UTF-8''R%C3%B6j%20Care.zip")).toBe('Röj Care.zip')
    expect(filenameFromContentDisposition('inline')).toBeNull()
    expect(filenameFromContentDisposition(null)).toBeNull()
  })

  it('never returns a path', () => {
    expect(filenameFromContentDisposition('attachment; filename="../../etc/passwd"')).toBe('passwd')
    expect(filenameFromContentDisposition('attachment; filename="C:\\temp\\x.exe"')).toBe('x.exe')
  })
})

describe('outcomeFromHeaders', () => {
  it('maps the bakery headers to booleans, defaulting to false', () => {
    expect(outcomeFromHeaders(new Headers({ 'x-agent-signed': '1', 'x-agent-notarized': '1' }))).toEqual({ signed: true, notarized: true })
    expect(outcomeFromHeaders(new Headers({ 'x-agent-signed': '1', 'x-agent-notarized': '0' }))).toEqual({ signed: true, notarized: false })
    expect(outcomeFromHeaders(new Headers())).toEqual({ signed: false, notarized: false })
  })
})

describe('phase copy', () => {
  it('switches from baking to signing copy after a couple of seconds when signing is configured', () => {
    const t0 = 1_000_000
    const baking = { ...IDLE, phase: 'baking' as const, startedAt: t0 }
    expect(phaseLabel(baking, true, t0 + 500)).toBe('Baking…')
    expect(phaseLabel(baking, true, t0 + 5000)).toBe('Signing & notarizing…')
    expect(phaseLabel(baking, false, t0 + 5000)).toBe('Baking…')
    expect(phaseHint(baking, true, t0 + 5000)).toMatch(/up to a minute/)
    expect(phaseLabel({ ...IDLE, phase: 'receiving', receivedBytes: 2 * 1_048_576, totalBytes: 10 * 1_048_576 }, false)).toBe('Receiving 2.0 / 10.0 MB')
    expect(isInFlight('baking')).toBe(true)
    expect(isInFlight('done')).toBe(false)
  })
})

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++])
      else controller.close()
    },
  })
}

describe('startAgentDownload', () => {
  beforeEach(() => {
    useAgentDownloadStore.getState().reset('macos-universal')
    useAgentDownloadStore.getState().reset('windows-x86_64')
  })

  it('shows the spinner while the console bakes, streams the body and reports the outcome', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const body = [new Uint8Array(1000), new Uint8Array(500)]
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('/api/agent/download/macos-universal?token=tok&quick=1')
      await gate
      return new Response(streamOf(body), {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-length': '1500',
          'content-disposition': 'attachment; filename="Acme.zip"',
          'x-agent-signed': '1',
          'x-agent-notarized': '1',
        },
      })
    }) as unknown as typeof fetch
    const saved: { name: string; size: number }[] = []
    const onDone = vi.fn()

    const p = startAgentDownload('macos-universal', { token: 'tok', quick: true, fetchImpl, onDone, save: (blob, name) => saved.push({ name, size: blob.size }) })
    // in flight → spinner state, and a second click joins the same promise
    expect(useAgentDownloadStore.getState().byPlatform['macos-universal']?.phase).toBe('baking')
    expect(startAgentDownload('macos-universal', { fetchImpl })).toBe(p)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    release()
    await p
    const st = useAgentDownloadStore.getState().byPlatform['macos-universal']!
    expect(st.phase).toBe('done')
    expect(st.filename).toBe('Acme.zip')
    expect(st.outcome).toEqual({ signed: true, notarized: true })
    expect(st.receivedBytes).toBe(1500)
    expect(saved).toEqual([{ name: 'Acme.zip', size: 1500 }])
    expect(onDone).toHaveBeenCalledWith({ signed: true, notarized: true }, 'Acme.zip')
  })

  it('surfaces the API error message and re-enables the button', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'token_exhausted', message: 'This token has no uses left.' } }), { status: 410, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const onError = vi.fn()
    await startAgentDownload('windows-x86_64', { fetchImpl, onError, save: () => undefined })
    const st = useAgentDownloadStore.getState().byPlatform['windows-x86_64']!
    expect(st.phase).toBe('error')
    expect(st.error).toBe('This token has no uses left.')
    expect(onError).toHaveBeenCalledWith('This token has no uses left.')
    expect(isInFlight(st.phase)).toBe(false)
  })

  it('falls back to a generic message for non-JSON failures', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    await startAgentDownload('windows-x86_64', { fetchImpl, save: () => undefined })
    expect(useAgentDownloadStore.getState().byPlatform['windows-x86_64']?.error).toMatch(/Not available/)
  })
})
