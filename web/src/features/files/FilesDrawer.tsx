import { useCallback, useEffect, useRef, useState } from 'react'
import { Upload, X } from 'lucide-react'
import { cx } from '@/components/ui'
import { transferManager } from './store'
import { flattenDrop, isFileDrag, snapshotDrop } from './dnd'
import { TransfersTab } from './TransfersTab'
import { BrowseTab, type Reveal } from './BrowseTab'
import { clampDrawerWidth, readCompression, readDestDir, readDrawerWidth, writeCompression, writeDestDir, writeDrawerWidth, type CompressionPref } from './prefs'

export { readDestDir } from './prefs'

type Tab = 'transfers' | 'browse'

/**
 * Side drawer of the viewer: transfers (queue, progress, resume, compression) and the remote
 * file browser. Resizable by dragging its left edge; accepts file drops anywhere.
 */
export function FilesDrawer({ deviceId, enabled, onClose, defaultTab = 'transfers' }: { deviceId: string; enabled: boolean; onClose: () => void; defaultTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(defaultTab)
  const [destDir, setDestDirState] = useState<string | null>(() => readDestDir(deviceId))
  const [compression, setCompressionState] = useState<CompressionPref>(() => readCompression())
  const [picking, setPicking] = useState(false)
  const [reveal, setReveal] = useState<Reveal | null>(null)
  const [width, setWidth] = useState(() => readDrawerWidth())
  const [dragDepth, setDragDepth] = useState(0)
  const resizing = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    transferManager.setDefaultDestDir(destDir ?? undefined)
  }, [destDir])

  useEffect(() => {
    transferManager.setCompression(compression !== 'off')
  }, [compression])

  const setDestDir = (dir: string | null) => {
    setDestDirState(dir)
    writeDestDir(deviceId, dir)
  }

  const setCompression = (p: CompressionPref) => {
    setCompressionState(p)
    writeCompression(p)
  }

  const revealFolder = (dir: string) => {
    setReveal({ path: dir, nonce: Date.now() })
    setTab('browse')
  }

  /* ── resize handle ── */
  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      resizing.current = { startX: e.clientX, startWidth: width }
      const onMove = (ev: PointerEvent) => {
        const r = resizing.current
        if (!r) return
        setWidth(clampDrawerWidth(r.startWidth + (r.startX - ev.clientX)))
      }
      const onUp = () => {
        resizing.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        setWidth((w) => {
          writeDrawerWidth(w)
          return w
        })
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [width],
  )

  const dragging = dragDepth > 0

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-l border-white/10 bg-[#0e1116] text-[13px] text-[#e6e9ef]"
      style={{ width }}
      onDragEnter={(e) => {
        if (!enabled || !isFileDrag(e.dataTransfer)) return
        e.preventDefault()
        setDragDepth((d) => d + 1)
      }}
      onDragOver={(e) => {
        if (!enabled || !isFileDrag(e.dataTransfer)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!isFileDrag(e.dataTransfer)) return
        setDragDepth((d) => Math.max(0, d - 1))
      }}
      onDrop={(e) => {
        if (!enabled || !isFileDrag(e.dataTransfer)) return
        e.preventDefault()
        setDragDepth(0)
        const snap = snapshotDrop(e.dataTransfer)
        void flattenDrop(snap).then((files) => {
          for (const f of files) void transferManager.upload(f.file)
          if (files.length) setTab('transfers')
        })
      }}
    >
      <div
        onPointerDown={onResizeStart}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-[#6cb6ff]/30 active:bg-[#6cb6ff]/40"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize files drawer"
        title="Drag to resize"
      />
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
          compression={compression}
          onChangeDest={() => {
            setPicking(true)
            setTab('browse')
          }}
          onResetDest={() => setDestDir(null)}
          onChangeCompression={setCompression}
          onReveal={revealFolder}
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
          reveal={reveal}
        />
      )}
      {dragging && enabled && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[#0e1116]/80 p-4 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-[#6cb6ff] px-6 py-6 text-center text-white">
            <Upload size={22} />
            <div className="font-medium">Drop to send</div>
            <div className="mono max-w-full truncate text-[11px] text-[#9aa3b2]">{destDir ?? 'Device default folder'}</div>
          </div>
        </div>
      )}
    </aside>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cx('rounded-md px-2.5 py-1 text-[12.5px] font-medium', active ? 'bg-white/10 text-white' : 'text-[#9aa3b2] hover:text-white')} role="tab" aria-selected={active}>
      {children}
    </button>
  )
}
