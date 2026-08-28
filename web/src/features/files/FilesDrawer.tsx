import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronRight, Eye, EyeOff, File as FileIcon, Folder, FolderInput, FolderPlus, HardDrive, Home, Pencil, RefreshCw, RotateCcw, Trash2, Upload, X } from 'lucide-react'
import type { FileEntry } from '@/protocol'
import { Button, ConfirmDialog, Input, cx } from '@/components/ui'
import { bytes, dateTime, eta, throughput } from '@/lib/format'
import { toast } from '@/lib/toast'
import { transferManager, useFiles } from './store'
import { isTerminal, type Transfer, type TransferStatus } from './manager'
import { BlobSink, FileSystemSink, MEMORY_SINK_WARN_BYTES, fileSystemAccessAvailable, guessMime, pickSaveFile } from './sinks'
import { resumeStore, type DownloadRecord, type UploadRecord } from './resume'

type Tab = 'transfers' | 'browse'

const destKey = (deviceId: string) => `remote.destDir.${deviceId}`

export function FilesDrawer({ deviceId, enabled, onClose, defaultTab = 'transfers' }: { deviceId: string; enabled: boolean; onClose: () => void; defaultTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(defaultTab)
  // Destination folder for uploads (null = the device's default folder), remembered per device.
  const [destDir, setDestDirState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(destKey(deviceId))
    } catch {
      return null
    }
  })
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    transferManager.setDefaultDestDir(destDir ?? undefined)
  }, [destDir])

  const setDestDir = (dir: string | null) => {
    setDestDirState(dir)
    try {
      if (dir) localStorage.setItem(destKey(deviceId), dir)
      else localStorage.removeItem(destKey(deviceId))
    } catch {
      /* storage disabled */
    }
  }

  return (
    <aside className="flex h-full w-[380px] shrink-0 flex-col border-l border-white/10 bg-[#0e1116] text-[13px] text-[#e6e9ef]">
      <div className="flex h-10 items-center gap-1 border-b border-white/10 px-2">
        <TabButton active={tab === 'transfers'} onClick={() => setTab('transfers')}>
          Transfers
        </TabButton>
        <TabButton active={tab === 'browse'} onClick={() => setTab('browse')}>
          Browse device
        </TabButton>
        <button onClick={onClose} className="ml-auto rounded-md p-1.5 text-[#9aa3b2] hover:bg-white/10 hover:text-white" aria-label="Close files">
          <X size={14} />
        </button>
      </div>
      {!enabled ? (
        <div className="p-4 text-[#9aa3b2]">File transfer is disabled for this device. An admin can enable it in the device settings.</div>
      ) : tab === 'transfers' ? (
        <TransfersTab
          deviceId={deviceId}
          destDir={destDir}
          onChangeDest={() => {
            setPicking(true)
            setTab('browse')
          }}
          onResetDest={() => setDestDir(null)}
        />
      ) : (
        <BrowseTab
          pickMode={
            picking
              ? {
                  onPick: (path) => {
                    setDestDir(path)
                    setPicking(false)
                    setTab('transfers')
                  },
                  onCancel: () => {
                    setPicking(false)
                    setTab('transfers')
                  },
                }
              : undefined
          }
          onSetUploadDest={setDestDir}
        />
      )}
    </aside>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cx('rounded-md px-2.5 py-1 text-[12.5px] font-medium', active ? 'bg-white/10 text-white' : 'text-[#9aa3b2] hover:text-white')}>
      {children}
    </button>
  )
}

/* ───────────── transfers ───────────── */

function TransfersTab({ deviceId, destDir, onChangeDest, onResetDest }: { deviceId: string; destDir: string | null; onChangeDest: () => void; onResetDest: () => void }) {
  const transfers = useFiles((s) => s.transfers)
  const fileInput = useRef<HTMLInputElement>(null)
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
  const finished = transfers.filter((t) => isTerminal(t.status))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <Button size="sm" variant="primary" icon={<Upload size={13} />} onClick={() => fileInput.current?.click()}>
          Send files…
        </Button>
        <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => onPick(e.target.files)} />
        <span className="text-[11.5px] text-[#6b7381]">or drop files onto the screen</span>
        {finished.length > 0 && (
          <button onClick={() => transferManager.clearFinished()} className="ml-auto text-[11.5px] text-[#9aa3b2] hover:text-white">
            Clear finished
          </button>
        )}
      </div>
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        {transfers.length === 0 && resumables.uploads.length === 0 && resumables.downloads.length === 0 && (
          <div className="p-4 text-[#6b7381]">No transfers yet. Send files to the device, or fetch some from the Browse tab.</div>
        )}
        {active.map((t) => (
          <TransferRow key={t.key} t={t} />
        ))}
        {finished.map((t) => (
          <TransferRow key={t.key} t={t} />
        ))}
        {(resumables.uploads.length > 0 || resumables.downloads.length > 0) && (
          <div className="border-t border-white/10 px-3 py-2">
            <div className="mb-1 text-[11px] font-medium tracking-wide text-[#6b7381] uppercase">Interrupted earlier</div>
            {resumables.uploads.map((u) => (
              <ResumeUploadRow key={u.key} rec={u} onDone={refreshResumables} />
            ))}
            {resumables.downloads.map((d) => (
              <ResumeDownloadRow key={d.key} rec={d} onDone={refreshResumables} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const STATUS_LABEL: Record<TransferStatus, string> = {
  queued: 'Queued',
  offered: 'Waiting for the device',
  transferring: 'Transferring',
  paused: 'Paused — reconnecting',
  verifying: 'Verifying',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

function TransferRow({ t }: { t: Transfer }) {
  const pct = t.size > 0 ? Math.min(100, (t.bytes / t.size) * 100) : t.status === 'done' ? 100 : 0
  const terminal = isTerminal(t.status)
  return (
    <div className="border-b border-white/5 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[#9aa3b2]">{t.direction === 'to_device' ? <ArrowUpFromLine size={14} /> : <ArrowDownToLine size={14} />}</span>
        <span className="min-w-0 flex-1 truncate font-medium" title={t.path ?? t.name}>
          {t.name}
          {t.kind !== 'file' && <span className="ml-1 text-[11px] font-normal text-[#6b7381]">clipboard</span>}
        </span>
        {!terminal && (
          <button onClick={() => transferManager.cancel(t.token)} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white" title="Cancel">
            <X size={13} />
          </button>
        )}
        {(t.status === 'failed' || t.status === 'cancelled') && t.resumable && (
          <button onClick={() => transferManager.retry(t.token)} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white" title="Retry (resumes where it stopped)">
            <RotateCcw size={13} />
          </button>
        )}
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded bg-white/10">
        <div className={cx('h-full transition-[width]', t.status === 'failed' ? 'bg-[#f87171]' : t.status === 'done' ? 'bg-[#34d399]' : 'bg-[#6cb6ff]')} style={{ width: `${pct}%` }} />
      </div>
      <div className="mono mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-[#9aa3b2]">
        <span className={cx(t.status === 'failed' && 'text-[#f87171]', t.status === 'done' && 'text-[#34d399]')}>{STATUS_LABEL[t.status]}</span>
        <span>
          {bytes(t.bytes)} / {bytes(t.size)}
        </span>
        {t.status === 'transferring' && t.speedBps > 0 && <span>{throughput(t.speedBps)}</span>}
        {t.status === 'transferring' && t.etaS !== null && <span>ETA {eta(t.etaS)}</span>}
        {t.startOffset > 0 && <span title="Resumed from a previous attempt">resumed at {bytes(t.startOffset)}</span>}
      </div>
      {t.error && <div className="mt-0.5 text-[11.5px] text-[#f87171]">{t.error}</div>}
      {t.direction === 'to_device' && t.kind === 'file' && (
        <div className="mono mt-0.5 flex items-center gap-1 truncate text-[11px] text-[#6b7381]" title={t.path ?? undefined}>
          <FolderInput size={11} className="shrink-0" />
          <span className="truncate">{t.path ?? 'Device default folder'}</span>
        </div>
      )}
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
      <span className="min-w-0 flex-1 truncate">{rec.name}</span>
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

/* ───────────── remote browser ───────────── */

type SortKey = 'name' | 'size' | 'modified'

function BrowseTab({ pickMode, onSetUploadDest }: { pickMode?: { onPick: (path: string) => void; onCancel: () => void }; onSetUploadDest?: (path: string) => void }) {
  const listing = useFiles((s) => s.listing)
  const loading = useFiles((s) => s.listingLoading)
  const path = useFiles((s) => s.listingPath)
  const requestListing = useFiles((s) => s.requestListing)
  const [showHidden, setShowHidden] = useState(false)
  const [sort, setSort] = useState<SortKey>('name')
  const [newDir, setNewDir] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ entry: FileEntry; value: string } | null>(null)
  const [deleting, setDeleting] = useState<FileEntry | null>(null)
  const uploadInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!listing && !loading) requestListing(null)
  }, [listing, loading, requestListing])

  const atRoots = listing?.path === '' || path === null
  const entries = useMemo(() => {
    const list = (listing?.entries ?? []).filter((e) => showHidden || !e.hidden)
    const dirFirst = (a: FileEntry, b: FileEntry) => Number(b.is_dir) - Number(a.is_dir)
    const cmp: Record<SortKey, (a: FileEntry, b: FileEntry) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      size: (a, b) => Number(b.size) - Number(a.size),
      modified: (a, b) => Number(b.modified_ms ?? 0) - Number(a.modified_ms ?? 0),
    }
    return list.sort((a, b) => dirFirst(a, b) || cmp[sort](a, b))
  }, [listing, showHidden, sort])

  const join = (dir: string, name: string) => {
    if (!dir) return name
    const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
    return dir.endsWith(sep) ? dir + name : dir + sep + name
  }

  const crumbs = useMemo(() => {
    const p = listing?.path ?? ''
    if (!p) return []
    const isWin = /^[A-Za-z]:/.test(p)
    const parts = p.split(/[\\/]/).filter(Boolean)
    const out: { label: string; path: string }[] = []
    let acc = isWin ? '' : '/'
    parts.forEach((part, i) => {
      acc = i === 0 && isWin ? `${part}\\` : join(acc, part)
      out.push({ label: part, path: acc })
    })
    return out
  }, [listing?.path])

  const open = (e: FileEntry) => {
    if (e.is_dir) requestListing(atRoots ? (e.path ?? e.name) : join(listing!.path, e.name))
    else void download(e)
  }

  const download = async (e: FileEntry) => {
    const size = Number(e.size)
    const remotePath = atRoots ? (e.path ?? e.name) : join(listing!.path, e.name)
    if (fileSystemAccessAvailable()) {
      const handle = await pickSaveFile(e.name)
      if (!handle) return
      await transferManager.download(remotePath, e.name, size, async (resume) => FileSystemSink.open(handle, resume ? await FileSystemSink.existingSize(handle) : 0))
    } else {
      if (size > MEMORY_SINK_WARN_BYTES && !window.confirm(`${e.name} is ${bytes(size)}. This browser has to hold it in memory before saving; continue?`)) return
      await transferManager.download(remotePath, e.name, size, async () => new BlobSink(e.name, guessMime(e.name), true))
    }
    toast.info(`Fetching ${e.name}`, 'Progress is in the Transfers tab.')
  }

  const uploadHere = (files: FileList | null) => {
    if (!files || atRoots || !listing) return
    // Uploading into a folder also makes it the remembered destination.
    onSetUploadDest?.(listing.path)
    for (const f of Array.from(files)) void transferManager.upload(f, { destDir: listing.path })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {pickMode && (
        <div className="flex items-center gap-2 border-b border-white/10 bg-[#6cb6ff]/10 px-3 py-2">
          <FolderInput size={14} className="shrink-0 text-[#6cb6ff]" />
          <span className="min-w-0 flex-1 text-[12px] text-[#c8ced8]">{atRoots ? 'Open a folder to use it for uploads' : <span className="mono truncate">{listing?.path}</span>}</span>
          <Button size="sm" variant="primary" icon={<Check size={13} />} disabled={atRoots || !listing} onClick={() => listing && pickMode.onPick(listing.path)}>
            Use this folder
          </Button>
          <button onClick={pickMode.onCancel} className="rounded px-1.5 py-0.5 text-[11.5px] text-[#9aa3b2] hover:bg-white/10 hover:text-white">
            Cancel
          </button>
        </div>
      )}
      <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1.5">
        <button onClick={() => requestListing(null)} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white" title="Roots">
          <HardDrive size={13} />
        </button>
        <div className="mono flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-[11.5px] text-[#9aa3b2] whitespace-nowrap">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-0.5">
              {i > 0 && <ChevronRight size={11} />}
              <button onClick={() => requestListing(c.path)} className={cx('rounded px-1 hover:bg-white/10', i === crumbs.length - 1 && 'text-white')}>
                {c.label}
              </button>
            </span>
          ))}
        </div>
        <button onClick={() => requestListing(path)} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white" title="Refresh">
          <RefreshCw size={13} className={cx(loading && 'animate-spin')} />
        </button>
        <button onClick={() => setShowHidden((v) => !v)} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white" title={showHidden ? 'Hide hidden files' : 'Show hidden files'}>
          {showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
        {!atRoots && (
          <>
            <button onClick={() => setNewDir('')} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white" title="New folder">
              <FolderPlus size={13} />
            </button>
            <button onClick={() => uploadInput.current?.click()} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white" title="Upload into this folder">
              <Upload size={13} />
            </button>
            <input ref={uploadInput} type="file" multiple className="hidden" onChange={(e) => uploadHere(e.target.files)} />
          </>
        )}
      </div>
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-1 text-[11px] text-[#6b7381]">
        <span>Sort</span>
        {(['name', 'size', 'modified'] as SortKey[]).map((k) => (
          <button key={k} onClick={() => setSort(k)} className={cx('rounded px-1 hover:text-white', sort === k && 'text-white')}>
            {k}
          </button>
        ))}
        <span className="ml-auto">{entries.length} items</span>
      </div>
      {newDir !== null && (
        <form
          className="flex items-center gap-2 border-b border-white/10 px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (newDir.trim() && listing) transferManager.mkdir(join(listing.path, newDir.trim()))
            setNewDir(null)
          }}
        >
          <Folder size={13} className="text-[#9aa3b2]" />
          <Input autoFocus value={newDir} onChange={(e) => setNewDir(e.target.value)} placeholder="New folder name" className="h-7 bg-black/30" />
          <Button size="sm" type="submit" variant="primary">
            Create
          </Button>
          <Button size="sm" type="button" onClick={() => setNewDir(null)}>
            Cancel
          </Button>
        </form>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {listing?.error && <div className="px-3 py-2 text-[#f87171]">{listing.error}</div>}
        {!listing && loading && <div className="px-3 py-2 text-[#6b7381]">Loading…</div>}
        {listing && entries.length === 0 && !listing.error && <div className="px-3 py-2 text-[#6b7381]">Empty folder</div>}
        {entries.map((e) => (
          <div
            key={e.name}
            className="group flex cursor-default items-center gap-2 px-3 py-1.5 hover:bg-white/5"
            onDoubleClick={() => open(e)}
            title={e.is_dir ? 'Double-click to open' : 'Double-click to download'}
          >
            <span className="text-[#9aa3b2]">{atRoots ? <Home size={14} /> : e.is_dir ? <Folder size={14} /> : <FileIcon size={14} />}</span>
            {renaming?.entry === e ? (
              <form
                className="flex flex-1 items-center gap-1"
                onSubmit={(ev) => {
                  ev.preventDefault()
                  if (renaming.value.trim() && renaming.value !== e.name && listing) transferManager.rename(join(listing.path, e.name), join(listing.path, renaming.value.trim()))
                  setRenaming(null)
                }}
              >
                <Input autoFocus value={renaming.value} onChange={(ev) => setRenaming({ entry: e, value: ev.target.value })} className="h-6 bg-black/30 text-[12px]" onBlur={() => setRenaming(null)} />
              </form>
            ) : (
              <span className={cx('min-w-0 flex-1 truncate', e.hidden && 'text-[#6b7381]')}>{e.name}</span>
            )}
            {!e.is_dir && <span className="mono text-[11px] text-[#6b7381]">{bytes(Number(e.size))}</span>}
            {e.modified_ms !== undefined && <span className="mono hidden text-[11px] text-[#6b7381] xl:inline">{dateTime(new Date(Number(e.modified_ms)).toISOString())}</span>}
            {!atRoots && (
              <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                {!e.is_dir && (
                  <button onClick={() => void download(e)} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white" title="Download">
                    <ArrowDownToLine size={12} />
                  </button>
                )}
                <button onClick={() => setRenaming({ entry: e, value: e.name })} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white" title="Rename">
                  <Pencil size={12} />
                </button>
                <button onClick={() => setDeleting(e)} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-[#f87171]" title="Delete">
                  <Trash2 size={12} />
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting && listing) transferManager.delete(join(listing.path, deleting.name))
          setDeleting(null)
        }}
        title={deleting?.is_dir ? 'Delete folder?' : 'Delete file?'}
        body={`"${deleting?.name}" will be deleted on the device. This cannot be undone.`}
        confirmLabel="Delete"
        danger
      />
    </div>
  )
}
