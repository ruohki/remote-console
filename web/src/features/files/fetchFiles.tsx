/**
 * Fetching files from the device: picks where the bytes go (open local folder, save/directory
 * picker, or a classic in-memory download) and queues the transfers.
 */
import { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/ui'
import { bytes } from '@/lib/format'
import { toast } from '@/lib/toast'
import { transferManager } from './store'
import { BlobSink, FileSystemSink, MEMORY_SINK_WARN_BYTES, directoryPickerAvailable, fileSystemAccessAvailable, guessMime, type Sink } from './sinks'
import { pickDirectory, pickSaveFile } from './sinks'
import { chooseFetchTarget } from './managerModel'

export interface FetchItem {
  name: string
  path: string
  size: number
}

/** A local folder that fetched files are written into without any prompt. */
export interface FetchInto {
  label: string
  sink: (name: string, resume: boolean) => Promise<Sink>
}

/* Promise-based confirmation for large in-memory downloads (replaces window.confirm). */
type LargeAsk = { label: string; size: number; resolve: (ok: boolean) => void }
let largeAskListener: ((a: LargeAsk | null) => void) | null = null
function askLargeDownload(label: string, size: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!largeAskListener) return resolve(true)
    largeAskListener({ label, size, resolve })
  })
}

export function LargeDownloadDialog() {
  const [ask, setAsk] = useState<LargeAsk | null>(null)
  useEffect(() => {
    largeAskListener = setAsk
    return () => {
      largeAskListener = null
    }
  }, [])
  const answer = (ok: boolean) => {
    ask?.resolve(ok)
    setAsk(null)
  }
  return (
    <ConfirmDialog
      open={!!ask}
      onClose={() => answer(false)}
      onConfirm={() => answer(true)}
      title="Large download"
      body={
        <>
          <b>{ask?.label}</b> is {ask ? bytes(ask.size) : ''}. This browser cannot stream to disk, so the whole content is held in memory before it is saved. Continue?
        </>
      }
      confirmLabel="Download anyway"
    />
  )
}

/** Queue downloads for `files`; returns whether anything was queued (pickers can be cancelled). */
export async function fetchFiles(files: FetchItem[], into: FetchInto | null = null): Promise<boolean> {
  if (!files.length) return false
  const total = files.reduce((a, f) => a + f.size, 0)
  const label = files.length === 1 ? files[0]!.name : `${files.length} files (${bytes(total)})`
  const target = chooseFetchTarget({ localFolderOpen: !!into, fileSystemAccess: fileSystemAccessAvailable(), directoryPicker: directoryPickerAvailable(), count: files.length })

  if (target === 'local-folder' && into) {
    for (const f of files) await transferManager.download(f.path, f.name, f.size, (resume) => into.sink(f.name, resume))
    toast.info(`Fetching ${label}`, `into ${into.label}`)
    return true
  }
  if (target === 'save-picker') {
    const f = files[0]!
    const handle = await pickSaveFile(f.name)
    if (!handle) return false
    await transferManager.download(f.path, f.name, f.size, async (resume) => FileSystemSink.open(handle, resume ? await FileSystemSink.existingSize(handle) : 0))
    toast.info(`Fetching ${label}`, 'Progress is in the transfer list.')
    return true
  }
  if (target === 'directory-picker') {
    const dir = await pickDirectory()
    if (!dir) return false
    for (const f of files) {
      await transferManager.download(f.path, f.name, f.size, async (resume) => {
        const handle = await dir.getFileHandle(f.name, { create: true })
        return FileSystemSink.open(handle, resume ? await FileSystemSink.existingSize(handle) : 0)
      })
    }
    toast.info(`Fetching ${label}`, `into ${dir.name}`)
    return true
  }
  if (total > MEMORY_SINK_WARN_BYTES && !(await askLargeDownload(label, total))) return false
  for (const f of files) await transferManager.download(f.path, f.name, f.size, async () => new BlobSink(f.name, guessMime(f.name), true))
  toast.info(`Fetching ${label}`, 'Progress is in the transfer list.')
  return true
}
