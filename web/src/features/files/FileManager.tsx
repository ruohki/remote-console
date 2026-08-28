import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, FolderOpen, Laptop, MonitorSmartphone, X } from 'lucide-react'
import type { FileEntry } from '@/protocol'
import { Button, cx } from '@/components/ui'
import { toast } from '@/lib/toast'
import { transferManager, useFiles } from './store'
import { BrowseTab, type Reveal } from './BrowseTab'
import { LocalPane, LocalPickPane } from './LocalPane'
import { TransferQueue } from './TransferQueue'
import { useLocalFolder } from './useLocalFolder'
import { fetchFiles, type FetchInto, type FetchItem } from './fetchFiles'
import { FileSystemSink } from './sinks'
import { walkLocalDir } from './localFs'
import { joinPath } from './paths'
import { localPathLabel, takeDragPayload } from './managerModel'
import { readCompression, readDestDir, readQueueOpen, writeCompression, writeDestDir, writeQueueOpen, type CompressionPref } from './prefs'

export { readDestDir } from './prefs'

/** Join a `/`-separated relative path onto a device folder using that folder's separator. */
function joinRelative(dir: string, rel: string): string {
  return rel.split('/').filter(Boolean).reduce((acc, seg) => joinPath(acc, seg), dir)
}

/** A local folder handle as a fetch destination: files land next to each other, resumable. */
function intoFolder(dir: FileSystemDirectoryHandle, label: string): FetchInto {
  return {
    label,
    sink: async (name, resume) => {
      const handle = await dir.getFileHandle(name, { create: true })
      return FileSystemSink.open(handle, resume ? await FileSystemSink.existingSize(handle) : 0)
    },
  }
}

export interface FileManagerProps {
  deviceId: string
  deviceName: string
  /** File transfer is allowed for this device. */
  enabled: boolean
  /** The session's data channel is up. */
  connected: boolean
  onClose: () => void
}

/**
 * Side-by-side file manager over the viewer: a folder on this computer on the left, the
 * device on the right, drag and drop (and Send / Fetch buttons) between them, and the transfer
 * queue along the bottom. The device folder being viewed is where sends land.
 */
export function FileManager({ deviceId, deviceName, enabled, connected, onClose }: FileManagerProps) {
  const listing = useFiles((s) => s.listing)
  const listingPath = useFiles((s) => s.listingPath)
  const transfers = useFiles((s) => s.transfers)
  const remoteDir = listing && listing.path !== '' && listingPath !== null && !listing.error ? listing.path : null

  // Sends go to the device folder on screen; the remembered folder only applies while none is
  // open (roots view) and keeps drops on the video surface working after the manager closes.
  const [manualDest, setManualDest] = useState<string | null>(() => readDestDir(deviceId))
  const destDir = remoteDir ?? manualDest
  const [compression, setCompressionState] = useState<CompressionPref>(() => readCompression())
  const [queueOpen, setQueueOpenState] = useState(() => readQueueOpen())
  const [reveal, setReveal] = useState<Reveal | null>(() => {
    const remembered = readDestDir(deviceId)
    return remembered && !useFiles.getState().listing ? { path: remembered, nonce: 1 } : null
  })
  const [remoteSel, setRemoteSel] = useState<FileEntry[]>([])
  const local = useLocalFolder(deviceId)

  const setDestDir = useCallback((dir: string | null) => setManualDest(dir), [])
  const setCompression = (p: CompressionPref) => {
    setCompressionState(p)
    writeCompression(p)
  }
  const setQueueOpen = (open: boolean) => {
    setQueueOpenState(open)
    writeQueueOpen(open)
  }

  useEffect(() => {
    writeDestDir(deviceId, destDir)
    transferManager.setDefaultDestDir(destDir ?? undefined)
  }, [deviceId, destDir])
  useEffect(() => {
    transferManager.setCompression(compression !== 'off')
  }, [compression])

  // A finished fetch shows up in the local folder.
  const doneFetches = transfers.filter((t) => t.direction === 'to_operator' && t.status === 'done').length
  const seenDone = useRef(doneFetches)
  const refreshLocal = local.refresh
  useEffect(() => {
    if (doneFetches !== seenDone.current) {
      seenDone.current = doneFetches
      refreshLocal()
    }
  }, [doneFetches, refreshLocal])

  const localReady = local.supported && local.state.access === 'granted'
  const localLabel = localPathLabel(local.state)
  const localDir = localReady ? local.currentDir() : null
  const fetchInto = localDir ? intoFolder(localDir, localLabel) : null
  const canSend = enabled && connected && remoteDir !== null

  /* ── this computer → device ── */
  const sendLocal = async (names: string[], dir: string) => {
    const cur = local.currentDir()
    if (!cur || !names.length) return
    const entries = local.state.entries.filter((e) => names.includes(e.name))
    let count = 0
    try {
      for (const e of entries) {
        if (e.isDir) {
          const tree = await walkLocalDir(await cur.getDirectoryHandle(e.name), e.name)
          for (const d of tree.dirs) transferManager.mkdir(joinRelative(dir, d))
          for (const f of tree.files) {
            void transferManager.upload(f.file, { destDir: joinRelative(dir, f.relDir) })
            count++
          }
        } else {
          void transferManager.upload(await (await cur.getFileHandle(e.name)).getFile(), { destDir: dir })
          count++
        }
      }
    } catch (err) {
      toast.error('Could not read the local files', err instanceof Error ? err.message : String(err))
      return
    }
    setDestDir(dir)
    toast.info(`Uploading ${count} file${count === 1 ? '' : 's'} to ${dir}`)
  }
  const sendFiles = (files: File[]) => {
    if (!remoteDir || !files.length) return
    for (const f of files) void transferManager.upload(f, { destDir: remoteDir })
    toast.info(`Uploading ${files.length} file${files.length === 1 ? '' : 's'} to ${remoteDir}`)
  }

  /* ── device → this computer ── */
  const fetchRemote = async (items: { name: string; path: string; size: number; isDir: boolean }[], subdir: string | null) => {
    const files: FetchItem[] = items.filter((i) => !i.isDir).map((i) => ({ name: i.name, path: i.path, size: i.size }))
    if (items.some((i) => i.isDir)) toast.info('Folders are skipped', 'Only files can be fetched from the device for now.')
    if (!files.length) return
    let into: FetchInto | null = null
    if (localReady) {
      const dir = subdir ? await local.subDir(subdir) : local.currentDir()
      if (dir) into = intoFolder(dir, subdir ? `${localLabel}/${subdir}` : localLabel)
    }
    await fetchFiles(files, into)
  }
  const remotePathOf = (e: FileEntry) => (remoteDir ? joinPath(remoteDir, e.name) : (e.path ?? e.name))

  const onInternalDrop = useCallback(
    (dir: string) => {
      const p = takeDragPayload()
      if (p?.kind === 'local') void sendLocal(p.names, dir)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sendLocal reads the latest pane state through refs/state at call time
    [local.state.entries, setDestDir],
  )
  const onDropRemote = (subdir: string | null) => {
    const p = takeDragPayload()
    if (p?.kind === 'remote') void fetchRemote(p.items, subdir)
  }

  const revealFolder = (dir: string) => setReveal({ path: dir, nonce: Date.now() })
  const onSelectionChange = useCallback((entries: FileEntry[]) => setRemoteSel(entries), [])

  const localSelection = [...local.state.selected]
  const remoteFiles = remoteSel.filter((e) => !e.is_dir)

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-[#0e1116] text-[13px] text-[#e6e9ef]" role="dialog" aria-label="File manager" data-testid="file-manager">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 px-3">
        <FolderOpen size={15} className="text-[#6cb6ff]" />
        <span className="font-medium">Files</span>
        <span className="hidden items-center gap-1.5 text-[12px] text-[#9aa3b2] sm:flex">
          <Laptop size={12} /> This computer
          <span className="mx-1 text-[#6b7381]">⇄</span>
          <MonitorSmartphone size={12} /> {deviceName}
        </span>
        {!connected && enabled && <span className="ml-2 rounded bg-[#fbbf24]/15 px-1.5 py-0.5 text-[11px] text-[#fbbf24]">Not connected</span>}
        <button onClick={onClose} className="ml-auto rounded-md p-1.5 text-[#9aa3b2] hover:bg-white/10 hover:text-white" aria-label="Close file manager" title="Close (the session keeps running)">
          <X size={15} />
        </button>
      </div>

      {!enabled ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-[#9aa3b2]">File transfer is disabled for this device. An admin can enable it in the device settings.</div>
      ) : (
        <div className="@container min-h-0 flex-1">
          <div className="flex h-full min-h-0 flex-col @min-[1100px]:flex-row">
            {/* this computer */}
            <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="This computer" data-testid="local-pane">
              <PaneTitle icon={<Laptop size={13} />} title="This computer" detail={localReady ? localLabel : local.supported ? undefined : 'pick list'} />
              {local.supported ? (
                <LocalPane folder={local} deviceName={deviceName} canSend={canSend} onSend={(names) => remoteDir && void sendLocal(names, remoteDir)} onDropRemote={onDropRemote} />
              ) : (
                <LocalPickPane deviceName={deviceName} canSend={canSend} onSendFiles={sendFiles} />
              )}
            </section>

            {/* actions */}
            <div className="flex shrink-0 items-center justify-center gap-2 border-y border-white/10 bg-white/[0.02] px-2 py-1.5 @min-[1100px]:w-[104px] @min-[1100px]:flex-col @min-[1100px]:border-x @min-[1100px]:border-y-0" data-testid="pane-actions">
              <Button
                size="sm"
                variant="primary"
                icon={<ArrowRight size={13} />}
                disabled={!canSend || !localReady || localSelection.length === 0}
                onClick={() => remoteDir && void sendLocal(localSelection, remoteDir)}
                title={remoteDir ? `Send the selected local items to ${remoteDir}` : 'Open a folder on the device first'}
                data-testid="send-button"
              >
                Send
              </Button>
              <Button
                size="sm"
                icon={<ArrowLeft size={13} />}
                disabled={!connected || remoteFiles.length === 0}
                onClick={() => void fetchRemote(remoteFiles.map((e) => ({ name: e.name, path: remotePathOf(e), size: Number(e.size), isDir: false })), null)}
                title={localReady ? `Fetch the selected device files into ${localLabel}` : 'Fetch the selected device files'}
                data-testid="fetch-button"
              >
                Fetch
              </Button>
              <span className="hidden max-w-[88px] text-center text-[10.5px] leading-tight text-[#6b7381] @min-[1100px]:block">Drag between the panes or use the buttons</span>
            </div>

            {/* device */}
            <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={deviceName} data-testid="remote-pane">
              <PaneTitle icon={<MonitorSmartphone size={13} />} title={deviceName} detail={remoteDir ?? undefined} />
              <div className={cx('relative flex min-h-0 flex-1 flex-col', !connected && 'opacity-60')}>
                <BrowseTab reveal={reveal} dragSource onInternalDrop={onInternalDrop} fetchInto={fetchInto} onSelectionChange={onSelectionChange} fetchLabel="Fetch" onSetUploadDest={setDestDir} />
              </div>
            </section>
          </div>
        </div>
      )}

      {enabled && (
        <TransferQueue
          open={queueOpen}
          onToggle={() => setQueueOpen(!queueOpen)}
          deviceId={deviceId}
          destDir={destDir}
          compression={compression}
          onChangeDest={() => toast.info('Sends go to the device folder you are viewing', 'Open a folder in the device pane to change it.')}
          onResetDest={() => {
            setManualDest(null)
            if (remoteDir) toast.info('Sends go to the device folder you are viewing', 'Go to the roots view to use the device default folder.')
          }}
          onChangeCompression={setCompression}
          onReveal={revealFolder}
        />
      )}
    </div>
  )
}

function PaneTitle({ icon, title, detail }: { icon: React.ReactNode; title: string; detail?: string }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-white/10 bg-white/[0.03] px-3 text-[12px]">
      <span className="text-[#9aa3b2]">{icon}</span>
      <span className="font-medium text-white">{title}</span>
      {detail && (
        <span className="mono min-w-0 truncate text-[11px] text-[#6b7381]" title={detail}>
          {detail}
        </span>
      )}
    </div>
  )
}
