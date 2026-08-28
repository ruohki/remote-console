import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronRight, FolderInput, Inbox, RotateCcw, Upload, X, Zap } from 'lucide-react'
import { Button, Select, cx } from '@/components/ui'
import { useNow } from '@/hooks/useNow'
import { bytes, eta, throughput } from '@/lib/format'
import { toast } from '@/lib/toast'
import { transferManager, useFiles } from './store'
import { isTerminal, type Transfer } from './manager'
import { FileSystemSink } from './sinks'
import { resumeStore, type DownloadRecord, type UploadRecord } from './resume'
import { TransferRow } from './TransferRow'
import { summarize } from './summary'
import type { CompressionPref } from './prefs'

const COMPRESSION_OPTIONS = [
  { value: 'auto' as const, label: 'Auto', description: 'Compress on the fly when it helps' },
  { value: 'off' as const, label: 'Off', description: 'Always send raw bytes' },
]

export function TransfersTab({
  deviceId,
  destDir,
  compression,
  onChangeDest,
  onResetDest,
  onChangeCompression,
  onReveal,
}: {
  deviceId: string
  destDir: string | null
  compression: CompressionPref
  onChangeDest: () => void
  onResetDest: () => void
  onChangeCompression: (p: CompressionPref) => void
  onReveal: (dir: string) => void
}) {
  const transfers = useFiles((s) => s.transfers)
  const fileInput = useRef<HTMLInputElement>(null)
  const summary = summarize(transfers)
  const now = useNow(1000)

  // Interrupted transfers persisted in IndexedDB (re-read whenever the live list changes).
  const fingerprint = transfers.map((t) => `${t.token}:${t.status}`).join(',')
  const resumablesQuery = useQuery({
    queryKey: ['resumables', deviceId, fingerprint],
    queryFn: async () => {
      const [uploads, downloads] = await Promise.all([resumeStore.listUploads(deviceId), resumeStore.listDownloads(deviceId)])
      const activeTokens = new Set(transfers.map((t) => t.token))
      return {
        uploads: uploads.filter((u) => !activeTokens.has(u.token)),
        downloads: downloads.filter((d) => d.bytesWritten > 0 && !transfers.some((t) => t.path === d.remotePath && !isTerminal(t.status))),
      } as { uploads: UploadRecord[]; downloads: DownloadRecord[] }
    },
    staleTime: 0,
  })
  const resumables = resumablesQuery.data ?? { uploads: [], downloads: [] }
  const refreshResumables = () => void resumablesQuery.refetch()

  const onPick = (files: FileList | null) => {
    if (!files) return
    for (const f of Array.from(files)) void transferManager.upload(f)
  }

  const active = transfers.filter((t) => !isTerminal(t.status))
  const failed = transfers.filter((t) => t.status === 'failed' || t.status === 'cancelled')
  const done = transfers.filter((t) => t.status === 'done')
  const empty = transfers.length === 0 && resumables.uploads.length === 0 && resumables.downloads.length === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <Button size="sm" variant="primary" icon={<Upload size={13} />} onClick={() => fileInput.current?.click()}>
          Send files…
        </Button>
        <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => onPick(e.target.files)} data-testid="send-files-input" />
        <span className="text-[11.5px] text-[#6b7381]">or drop files anywhere</span>
        <span className="ml-auto flex items-center gap-1">
          {failed.length > 0 && failed.some((t) => t.resumable) && (
            <button onClick={() => transferManager.retryFailed()} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-[#9aa3b2] hover:bg-white/10 hover:text-white" title="Retry every failed transfer">
              <RotateCcw size={11} /> Retry failed
            </button>
          )}
          {active.length > 0 && (
            <button onClick={() => transferManager.cancelAll()} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-[#9aa3b2] hover:bg-white/10 hover:text-[#f87171]" title="Cancel every running transfer">
              <X size={11} /> Cancel all
            </button>
          )}
        </span>
      </div>

      {summary.active > 0 && (
        <div className="border-b border-white/10 bg-white/[0.03] px-3 py-2" data-testid="transfer-summary">
          <div className="mono flex items-center gap-2.5 text-[11.5px] text-[#c8ced8]">
            {summary.sending > 0 && (
              <span className="inline-flex items-center gap-1">
                <ArrowUpFromLine size={11} className="text-[#6cb6ff]" /> {summary.sending}
              </span>
            )}
            {summary.receiving > 0 && (
              <span className="inline-flex items-center gap-1">
                <ArrowDownToLine size={11} className="text-[#34d399]" /> {summary.receiving}
              </span>
            )}
            <span className="text-[#6b7381]">
              {bytes(summary.bytesDone)} / {bytes(summary.bytesTotal)}
            </span>
            {summary.speedBps > 0 && <span>{throughput(summary.speedBps)}</span>}
            {summary.etaS !== null && <span className="ml-auto text-[#9aa3b2]">ETA {eta(summary.etaS)}</span>}
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded bg-white/10">
            <div className="h-full bg-[#6cb6ff] transition-[width] duration-150" style={{ width: `${summary.bytesTotal > 0 ? (summary.bytesDone / summary.bytesTotal) * 100 : 0}%` }} />
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5 text-[11.5px]">
        <FolderInput size={13} className="shrink-0 text-[#9aa3b2]" />
        <span className="shrink-0 text-[#6b7381]">Save to</span>
        <span className="mono min-w-0 flex-1 truncate text-[#c8ced8]" title={destDir ?? undefined}>
          {destDir ?? 'Device default folder'}
        </span>
        <button onClick={onChangeDest} className="shrink-0 rounded px-1.5 py-0.5 text-[#6cb6ff] hover:bg-white/10">
          Change…
        </button>
        {destDir && (
          <button onClick={onResetDest} className="shrink-0 rounded px-1.5 py-0.5 text-[#9aa3b2] hover:bg-white/10 hover:text-white">
            Reset
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5 text-[11.5px]">
        <Zap size={13} className="shrink-0 text-[#9aa3b2]" />
        <span className="shrink-0 text-[#6b7381]">Compression</span>
        <Select size="sm" variant="hud" menuTone="dark" value={compression} onChange={onChangeCompression} options={COMPRESSION_OPTIONS} aria-label="Compression" className="min-w-[88px]" />
        <span className="mono ml-auto truncate text-[#6b7381]" title="Bytes that compression kept off the wire in this list">
          {summary.savedBytes > 0 ? `saved ${bytes(summary.savedBytes)}` : compression === 'auto' ? 'files & clipboard, both ways' : 'raw bytes only'}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {empty && (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-[#6b7381]">
            <Inbox size={28} className="text-[#3b4250]" />
            <div className="text-[13px] text-[#9aa3b2]">No transfers yet</div>
            <div className="text-[12px]">Drop files on the screen or the drawer to send them, or fetch files from the Browse tab.</div>
          </div>
        )}
        {active.length > 0 && (
          <Section title="In progress" count={active.length} defaultOpen>
            {active.map((t) => (
              <TransferRow key={t.key} t={t} now={now} onReveal={onReveal} />
            ))}
          </Section>
        )}
        {failed.length > 0 && (
          <Section
            title="Failed"
            count={failed.length}
            defaultOpen
            action={
              <button onClick={() => failed.forEach((t) => transferManager.remove(t.token))} className="text-[11px] text-[#9aa3b2] hover:text-white">
                Clear
              </button>
            }
          >
            {failed.map((t) => (
              <TransferRow key={t.key} t={t} now={now} onReveal={onReveal} />
            ))}
          </Section>
        )}
        {done.length > 0 && (
          <Section
            title="Completed"
            count={done.length}
            defaultOpen
            action={
              <button onClick={() => done.forEach((t) => transferManager.remove(t.token))} className="text-[11px] text-[#9aa3b2] hover:text-white">
                Clear
              </button>
            }
          >
            {done.map((t) => (
              <TransferRow key={t.key} t={t} now={now} onReveal={onReveal} />
            ))}
          </Section>
        )}
        {(resumables.uploads.length > 0 || resumables.downloads.length > 0) && (
          <Section title="Interrupted earlier" count={resumables.uploads.length + resumables.downloads.length} defaultOpen>
            <div className="px-3 py-1">
              {resumables.uploads.map((u) => (
                <ResumeUploadRow key={u.key} rec={u} onDone={refreshResumables} />
              ))}
              {resumables.downloads.map((d) => (
                <ResumeDownloadRow key={d.key} rec={d} onDone={refreshResumables} />
              ))}
            </div>
          </Section>
        )}
      </div>
    </div>
  )
}

function Section({ title, count, defaultOpen, action, children }: { title: string; count: number; defaultOpen?: boolean; action?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen ?? true)
  return (
    <div>
      <div className="sticky top-0 z-[1] flex items-center gap-1 border-b border-white/5 bg-[#0e1116]/95 px-2 py-1 text-[11px] font-medium tracking-wide text-[#6b7381] uppercase backdrop-blur">
        <button onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 rounded px-1 hover:text-white" aria-expanded={open}>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {title} <span className="normal-case">({count})</span>
        </button>
        <span className="ml-auto pr-1 normal-case">{action}</span>
      </div>
      <div className={cx(!open && 'hidden')}>{children}</div>
    </div>
  )
}

function ResumeUploadRow({ rec, onDone }: { rec: UploadRecord; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const pick = (files: FileList | null) => {
    const f = files?.[0]
    if (!f) return
    if (f.name !== rec.name || f.size !== rec.size || f.lastModified !== rec.lastModified) {
      toast.error('That is a different file', `Pick "${rec.name}" (${bytes(rec.size)}) again to resume.`)
      return
    }
    void transferManager.upload(f, { token: rec.token, destDir: rec.destDir }).then(onDone)
  }
  return (
    <div className="flex items-center gap-2 py-1 text-[12.5px]">
      <ArrowUpFromLine size={13} className="text-[#9aa3b2]" />
      <span className="min-w-0 flex-1 truncate" title={rec.destDir ?? undefined}>
        {rec.name}
      </span>
      <span className="mono text-[11px] text-[#6b7381]">{bytes(rec.size)}</span>
      <input ref={input} type="file" className="hidden" onChange={(e) => pick(e.target.files)} />
      <Button size="sm" onClick={() => input.current?.click()} title="Pick the same file again to resume">
        Resume…
      </Button>
      <button onClick={() => void resumeStore.deleteUpload(rec.key).then(onDone)} className="rounded p-1 text-[#9aa3b2] hover:text-white" title="Forget">
        <X size={12} />
      </button>
    </div>
  )
}

function ResumeDownloadRow({ rec, onDone }: { rec: DownloadRecord; onDone: () => void }) {
  const resume = async () => {
    if (!rec.handle) {
      toast.error('Cannot resume', 'The browser did not keep a handle to the partial file.')
      return
    }
    if (!(await FileSystemSink.ensurePermission(rec.handle))) {
      toast.error('Permission to write the file was not granted')
      return
    }
    const handle = rec.handle
    await transferManager.download(rec.remotePath, rec.name, rec.size, async () => FileSystemSink.open(handle, await FileSystemSink.existingSize(handle)))
    onDone()
  }
  return (
    <div className="flex items-center gap-2 py-1 text-[12.5px]">
      <ArrowDownToLine size={13} className="text-[#9aa3b2]" />
      <span className="min-w-0 flex-1 truncate" title={rec.remotePath}>
        {rec.name}
      </span>
      <span className="mono text-[11px] text-[#6b7381]">
        {bytes(rec.bytesWritten)} / {bytes(rec.size)}
      </span>
      <Button size="sm" onClick={() => void resume()}>
        Resume
      </Button>
      <button onClick={() => void resumeStore.deleteDownload(rec.key).then(onDone)} className="rounded p-1 text-[#9aa3b2] hover:text-white" title="Forget">
        <X size={12} />
      </button>
    </div>
  )
}

export type { Transfer }
