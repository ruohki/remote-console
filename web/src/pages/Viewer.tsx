import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  ArrowLeft,
  ChevronDown,
  ClipboardCopy,
  ClipboardPaste,
  Eye,
  FolderOpen,
  Keyboard,
  KeyboardOff,
  LayoutGrid,
  Maximize2,
  MessageSquare,
  Minimize2,
  MonitorSmartphone,
  RefreshCw,
  Shield,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { useViewerSession, type AgentStats, type ChatLine, type ViewerState } from '@/hooks/useViewerSession'
import { useSessionEvents } from '@/hooks/useSessionEvents'
import { useLive } from '@/store/live'
import { toRemotePixels } from '@/lib/geometry'
import { keyboardToInput, mouseButton, RESERVED_SHORTCUTS, shortcutKey, wheelToInput } from '@/lib/input'
import { tileGrid } from '@/lib/displays'
import { api } from '@/lib/api'
import { Button, cx } from '@/components/ui'
import { CODEC_LABEL, END_REASON_LABEL, bytes, kbps } from '@/lib/format'
import { toast } from '@/lib/toast'
import type { ControlMessage, DisplayInfo, InputEvent } from '@/protocol'
import type { DeviceDetail } from '@/lib/types'
import { FilesDrawer } from '@/features/files/FilesDrawer'
import { ChatDrawer } from '@/features/chat/ChatDrawer'
import { activeTransferCount, transferManager, useFiles } from '@/features/files/store'
import { classifyPasteItems, clipboardImageName, toPngBlob, writeImageToClipboard } from '@/features/files/clipboard'
import { BlobSink, FileSystemSink, directoryPickerAvailable, guessMime, pickDirectory } from '@/features/files/sinks'

const FPS_PRESETS = [15, 30, 60]
const BITRATE_PRESETS = [2000, 4000, 8000, 15000, 30000]

type Drawer = 'files' | 'chat' | null

export function Viewer() {
  const { deviceId = '' } = useParams()
  const navigate = useNavigate()
  const device = useLive((s) => s.devices[deviceId])
  const wsStatus = useLive((s) => s.wsStatus)
  const detail = useQuery({ queryKey: ['device', deviceId], queryFn: () => api.get<DeviceDetail>(`/api/devices/${deviceId}`), staleTime: 30_000 })
  const cfg = detail.data?.config
  const allowFiles = cfg?.allow_file_transfer ?? true
  const allowAudio = cfg?.allow_audio ?? true
  const allowClipboard = cfg?.allow_clipboard ?? true

  const deviceName = device?.name ?? 'Device'
  const knownDisplays = useMemo(() => device?.displays ?? [], [device?.displays])
  const [drawer, setDrawer] = useState<Drawer>(null)

  const { state, start, end, sendInput, sendControl, selectDisplay, setActiveDisplays, setAudio, sendChat, setChatOpen, seedChat, clearRichClipboard } = useViewerSession(deviceId, {
    knownDisplays,
    wantAudio: allowAudio,
    onChatNotify: (line: ChatLine) => toast.info(`${deviceName}: ${line.text}`, 'Open the chat to reply.'),
  })

  const rootRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [inputEnabled, setInputEnabled] = useState(true)
  const [showStats, setShowStats] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [toolbar, setToolbar] = useState(true)
  const [layout, setLayout] = useState<'single' | 'grid'>('single')
  const [volume, setVolume] = useState(1)
  const [dragging, setDragging] = useState(false)
  const startedRef = useRef(false)
  const transfers = useFiles((s) => s.transfers)
  const activeTransfers = activeTransferCount(transfers)

  // Users with view-only permission on this device never get a session (RBAC lands later;
  // the console refuses the offer anyway, this just avoids a confusing attempt).
  const viewOnly = device?.permission === 'view'

  // Kick off once the live socket is up (the device state is needed for a good error).
  useEffect(() => {
    if (startedRef.current || wsStatus !== 'open' || viewOnly) return
    startedRef.current = true
    void start()
  }, [wsStatus, start, viewOnly])

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  const connected = state.phase === 'connected'
  const controlling = connected && inputEnabled

  /* ───── chat transcript from persisted events (reconnects) ───── */
  const events = useSessionEvents(state.sessionId, { enabled: !!state.sessionId })
  useEffect(() => {
    const lines: ChatLine[] = events.rows
      .filter((r) => r.event.type === 'chat')
      .map((r) => {
        const e = r.event as Extract<typeof r.event, { type: 'chat' }>
        return { id: `ev-${r.id}`, from: e.from, text: e.text, tsMs: Date.parse(r.ts) }
      })
    if (lines.length) seedChat(lines)
  }, [events.rows, seedChat])

  useEffect(() => {
    setChatOpen(drawer === 'chat')
  }, [drawer, setChatOpen])

  /* ───── transfer notices ───── */
  useEffect(() => {
    transferManager.callbacks = {
      onListing: (l) => useFiles.getState().setListing({ path: l.path, entries: l.entries, error: l.error }),
      onOpResult: (r) => {
        if (r.ok) toast.success(`${r.op} done`, r.path)
        else toast.error(`${r.op} failed`, r.error ?? r.path)
        useFiles.getState().opResult(r)
      },
      onTransferFinished: (t) => {
        if (t.status === 'done') toast.success(t.direction === 'to_device' ? `Sent ${t.name}` : `Received ${t.name}`, t.path)
        else if (t.status === 'failed') toast.error(`${t.name}: ${t.error ?? 'failed'}`)
      },
      onNotice: (kind, title, detail) => (kind === 'error' ? toast.error(title, detail) : toast.info(title, detail)),
      onClipboardImage: async (png) => {
        try {
          await writeImageToClipboard(png)
          toast.success('Image copied from the device clipboard')
        } catch {
          // no gesture any more: hand it over as a download instead
          const { triggerDownload } = await import('@/features/files/sinks')
          triggerDownload(png, clipboardImageName())
          toast.info('Image saved as a file', 'The browser did not allow writing it to the clipboard.')
        }
      },
      onClipboardFilesDone: (names) => toast.success(`${names.length} file${names.length === 1 ? '' : 's'} received from the device clipboard`),
    }
    return () => {
      transferManager.callbacks = {}
    }
  }, [])

  /* ───── audio ───── */
  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    if (a.srcObject !== state.audioStream) a.srcObject = state.audioStream
    a.volume = volume
    if (state.audioEnabled && state.audioStream) a.play().catch(() => undefined)
  }, [state.audioStream, state.audioEnabled, volume])

  const toggleAudio = () => {
    const next = !state.audioEnabled
    setAudio(next)
    const a = audioRef.current
    if (a) {
      a.muted = !next
      if (next) a.play().catch(() => toast.error('Audio was blocked by the browser', 'Click the speaker again after interacting with the page.'))
    }
  }

  /* ───── keyboard (global while the surface is focused) ───── */
  const lastHint = useRef(0)
  useEffect(() => {
    if (!controlling) return
    const target = surfaceRef.current
    const onKey = (e: KeyboardEvent) => {
      if (!target?.contains(document.activeElement) || document.activeElement !== target) return
      if (e.type === 'keydown' && e.key === 'Escape' && e.shiftKey && e.ctrlKey) {
        target?.blur()
        return
      }
      const ev = keyboardToInput(e, e.type === 'keydown')
      if (!ev) return
      e.preventDefault()
      e.stopPropagation()
      if (e.type === 'keydown' && RESERVED_SHORTCUTS.has(shortcutKey(e)) && Date.now() - lastHint.current > 4000) {
        lastHint.current = Date.now()
        toast.info('That shortcut may be caught by your browser', 'Use the toolbar for Ctrl+Alt+Del and similar keys.')
      }
      sendInput(ev)
    }
    const release = () => sendInput({ t: 'rel' })
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', release)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', release)
      release()
    }
  }, [controlling, sendInput])

  /* ───── paste (images / files / text) ───── */
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      if (!connected || document.activeElement !== surfaceRef.current || !e.clipboardData) return
      const items = Array.from(e.clipboardData.items)
      const { images, files, hasText } = classifyPasteItems(items)
      if (images.length && allowClipboard) {
        e.preventDefault()
        try {
          const png = await toPngBlob(images[0]!)
          await transferManager.sendClipboardImage(png, clipboardImageName())
          toast.info('Sending the image to the device clipboard')
        } catch (err) {
          toast.error('Could not send the image', (err as Error).message)
        }
        return
      }
      if (files.length && allowFiles && allowClipboard) {
        e.preventDefault()
        await transferManager.sendClipboardFiles(files)
        toast.info(`Sending ${files.length} file${files.length === 1 ? '' : 's'} to the device clipboard`)
        return
      }
      if (hasText && allowClipboard) {
        e.preventDefault()
        const text = e.clipboardData.getData('text/plain')
        if (text) {
          sendControl({ t: 'clipboard_set', text })
          toast.success('Clipboard sent to the device')
        }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [connected, allowClipboard, allowFiles, sendControl])

  /* ───── drag & drop uploads ───── */
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (!connected || !allowFiles) return
    const files = Array.from(e.dataTransfer.files)
    if (!files.length) return
    for (const f of files) void transferManager.upload(f)
    setDrawer('files')
    toast.info(`Sending ${files.length} file${files.length === 1 ? '' : 's'} to ${deviceName}`)
  }

  /* ───── rich clipboard from the device ───── */
  const rich = state.remoteClipboardRich
  const pullClipboard = async () => {
    if (!rich) return
    if (rich.kind === 'image') {
      transferManager.requestClipboard('image', rich.names, async () => new BlobSink(rich.names[0] ?? 'clipboard.png', 'image/png', false), async (png) => {
        try {
          await writeImageToClipboard(png)
          toast.success('Image copied from the device clipboard')
        } catch {
          /* handled by the manager callback fallback */
        }
      })
    } else {
      let dir: FileSystemDirectoryHandle | null = null
      if (directoryPickerAvailable()) {
        dir = await pickDirectory()
        if (!dir) return
      }
      const folder = dir
      transferManager.requestClipboard('files', rich.names, async (name) => {
        if (folder) {
          const handle = await folder.getFileHandle(name, { create: true })
          return FileSystemSink.open(handle, 0)
        }
        return new BlobSink(name, guessMime(name), true)
      })
      setDrawer('files')
    }
    clearRichClipboard()
  }

  const leave = () => {
    end()
    navigate(`/devices/${deviceId}`)
  }

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined)
    else rootRef.current?.requestFullscreen().catch(() => undefined)
  }

  const pasteToRemote = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return toast.info('Your clipboard is empty', 'Tip: press Ctrl/Cmd+V on the screen to paste images and files too.')
      sendControl({ t: 'clipboard_set', text })
      toast.success('Clipboard sent to the device')
    } catch {
      toast.error('Clipboard access was blocked', 'Allow clipboard access for this site in the browser.')
    }
  }

  /* ───── displays ───── */
  const displays = state.displays.length ? state.displays : knownDisplays
  const active = state.activeDisplays.length ? state.activeDisplays : [state.currentDisplay]
  const visible = layout === 'grid' ? active : [active.includes(state.currentDisplay) ? state.currentDisplay : (active[0] ?? 0)]
  const grid = tileGrid(visible.length)

  const toggleDisplay = (index: number) => {
    const next = active.includes(index) ? active.filter((i) => i !== index) : [...active, index]
    if (next.length === 0) return
    setActiveDisplays(next)
    if (!next.includes(state.currentDisplay)) selectDisplay(next[0]!)
    if (next.length > 1) setLayout('grid')
  }
  const focusDisplay = (index: number) => {
    selectDisplay(index)
    if (!active.includes(index)) setActiveDisplays([...active, index])
    setLayout('single')
  }

  const knownIndices = new Set(knownDisplays.map((d) => d.index))
  const displaysChanged = state.displays.length > 0 && (state.displays.length !== knownDisplays.length || state.displays.some((d) => !knownIndices.has(d.index)))

  return (
    <div ref={rootRef} className="relative flex h-full flex-col bg-black text-ink select-none">
      {/* HUD */}
      <div
        className={cx(
          'z-20 flex h-10 shrink-0 items-center gap-1 border-b border-white/10 bg-[#0e1116]/95 px-2 text-[12.5px] text-[#e6e9ef] backdrop-blur transition-[margin] duration-200',
          !toolbar && '-mt-10',
        )}
      >
        <button onClick={leave} className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-white/10" title="Leave session">
          <ArrowLeft size={14} />
          <span className="hidden sm:inline">{deviceName}</span>
        </button>
        <PhasePill state={state} />
        <div className="ml-1 hidden items-center gap-1 md:flex">
          {displays.length > 1 && (
            <div className="flex items-center gap-0.5 rounded-md border border-white/10 px-1 py-0.5" title="Displays: click to focus, toggle the box to stream several at once">
              <MonitorSmartphone size={13} className="mx-1 text-[#9aa3b2]" />
              {displays.map((d) => (
                <span key={d.index} className={cx('flex items-center rounded', active.includes(d.index) ? 'bg-[#6cb6ff]/20 text-[#6cb6ff]' : 'text-[#9aa3b2]')}>
                  <button onClick={() => focusDisplay(d.index)} className={cx('px-1.5 py-0.5 text-[11.5px] hover:text-white', state.currentDisplay === d.index && 'font-semibold')} title={`${d.name} · ${d.width}×${d.height}`}>
                    {d.index + 1}
                  </button>
                  <button onClick={() => toggleDisplay(d.index)} className="pr-1 hover:text-white" title={active.includes(d.index) ? 'Stop streaming this display' : 'Also stream this display'} disabled={!connected}>
                    <Square size={10} className={active.includes(d.index) ? 'fill-current' : ''} />
                  </button>
                </span>
              ))}
              {active.length > 1 && (
                <HudButton active={layout === 'grid'} onClick={() => setLayout((l) => (l === 'grid' ? 'single' : 'grid'))} title={layout === 'grid' ? 'Show one display' : 'Show all streaming displays'}>
                  <LayoutGrid size={13} />
                </HudButton>
              )}
            </div>
          )}
          <QualityMenu key={`${cfg?.max_fps ?? 60}-${cfg?.max_bitrate_kbps ?? 8000}`} sendControl={sendControl} disabled={!connected} defaults={{ fps: cfg?.max_fps ?? 60, bitrate: cfg?.max_bitrate_kbps ?? 8000 }} />
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          <HudButton
            active={inputEnabled}
            onClick={() => {
              setInputEnabled((v) => !v)
              if (inputEnabled) sendInput({ t: 'rel' })
            }}
            title={inputEnabled ? 'Input on — click to view only' : 'Input off — click to control'}
          >
            {inputEnabled ? <Keyboard size={14} /> : <KeyboardOff size={14} />}
          </HudButton>
          <span className="relative">
            <HudButton
              active={state.audioEnabled}
              onClick={toggleAudio}
              disabled={!connected || !allowAudio || !state.audioAvailable}
              title={!allowAudio ? 'Audio is disabled for this device' : !state.audioAvailable ? 'Audio unavailable on this session' : state.audioEnabled ? 'Mute device audio' : 'Listen to device audio'}
            >
              {state.audioEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
            </HudButton>
            {state.audioEnabled && (
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                className="absolute top-full left-1/2 z-30 mt-1 h-1 w-20 -translate-x-1/2 accent-[#6cb6ff]"
                title="Volume"
              />
            )}
          </span>
          <HudButton onClick={() => sendControl({ t: 'secure_attention' })} disabled={!connected} title="Send Ctrl+Alt+Del">
            <Shield size={14} />
          </HudButton>
          <HudButton onClick={pasteToRemote} disabled={!connected || !allowClipboard} title="Send my clipboard text to the device (Ctrl/Cmd+V on the screen also sends images and files)">
            <ClipboardPaste size={14} />
          </HudButton>
          {state.remoteClipboard !== null && (
            <HudButton onClick={() => navigator.clipboard.writeText(state.remoteClipboard ?? '').then(() => toast.success('Copied the device clipboard'))} title="Copy the device clipboard text">
              <ClipboardCopy size={14} />
            </HudButton>
          )}
          <HudButton active={drawer === 'files'} onClick={() => setDrawer((d) => (d === 'files' ? null : 'files'))} title="Files: send, fetch and browse" badge={activeTransfers || undefined}>
            <FolderOpen size={14} />
          </HudButton>
          <HudButton active={drawer === 'chat'} onClick={() => setDrawer((d) => (d === 'chat' ? null : 'chat'))} title="Chat with the person at the device" badge={state.unreadChat || undefined}>
            <MessageSquare size={14} />
          </HudButton>
          <HudButton onClick={() => sendControl({ t: 'request_keyframe' })} disabled={!connected} title="Refresh the picture">
            <RefreshCw size={14} />
          </HudButton>
          <HudButton active={showStats} onClick={() => setShowStats((v) => !v)} title="Statistics">
            <Activity size={14} />
          </HudButton>
          <HudButton onClick={toggleFullscreen} title={fullscreen ? 'Exit full screen' : 'Full screen'}>
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </HudButton>
          <HudButton onClick={leave} title="Disconnect" danger>
            <X size={14} />
          </HudButton>
        </div>
      </div>
      {/* toolbar handle */}
      <button
        onClick={() => setToolbar((v) => !v)}
        className="absolute top-0 left-1/2 z-30 -translate-x-1/2 rounded-b-md bg-[#0e1116]/80 px-3 py-0.5 text-[#9aa3b2] hover:text-white"
        style={{ top: toolbar ? 40 : 0 }}
        title={toolbar ? 'Hide toolbar' : 'Show toolbar'}
      >
        <ChevronDown size={12} className={cx('transition-transform', toolbar && 'rotate-180')} />
      </button>

      <div className="flex min-h-0 flex-1">
        {/* surface: all tiles share one focus target for the keyboard */}
        <div
          ref={surfaceRef}
          tabIndex={0}
          className={cx('relative min-h-0 min-w-0 flex-1 outline-none', dragging && 'ring-2 ring-[#6cb6ff] ring-inset')}
          onDragOver={(e) => {
            if (!allowFiles) return
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onContextMenu={(e) => e.preventDefault()}
          onDragStart={(e) => e.preventDefault()}
        >
          <div
            className="grid h-full w-full gap-px bg-black"
            style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))` }}
          >
            {visible.map((index) => (
              <DisplayTile
                key={index}
                display={displays.find((d) => d.index === index) ?? { index, name: `Display ${index + 1}`, x: 0, y: 0, width: 0, height: 0, scale: 1, primary: index === 0 }}
                stream={state.streams[index] ?? null}
                controlling={controlling}
                isCurrent={state.currentDisplay === index}
                multi={visible.length > 1}
                stats={showStats ? (state.agentStats[index] ?? null) : null}
                rtc={showStats && index === state.currentDisplay ? state : null}
                onEnter={() => {
                  if (state.currentDisplay !== index) selectDisplay(index)
                }}
                onFocusRequest={() => focusDisplay(index)}
                onPointerDownFocus={() => surfaceRef.current?.focus()}
                sendInput={sendInput}
              />
            ))}
          </div>

          {dragging && connected && allowFiles && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[#0e1116]/70 text-lg font-semibold text-white">Drop to send to {deviceName}</div>
          )}

          {state.observers.length > 0 && (
            <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
              <div className="flex items-center gap-1.5 rounded-md bg-[#17283d] px-3 py-1 text-[12px] text-[#6cb6ff]">
                <Eye size={13} /> {state.observers.join(', ')} {state.observers.length === 1 ? 'is' : 'are'} watching this session
              </div>
            </div>
          )}

          {rich && connected && (
            <div className="absolute right-3 bottom-3 z-20 flex items-center gap-2 rounded-md border border-white/10 bg-[#161a21] px-3 py-2 text-[12.5px] text-[#e6e9ef] shadow-pop">
              <ClipboardCopy size={14} className="text-[#9aa3b2]" />
              <span>
                Device clipboard: {rich.kind === 'image' ? 'image' : `${rich.names.length} file${rich.names.length === 1 ? '' : 's'}`} ({bytes(rich.totalBytes)})
              </span>
              <Button size="sm" variant="primary" onClick={() => void pullClipboard()}>
                {rich.kind === 'image' ? 'Copy' : 'Download'}
              </Button>
              <button onClick={clearRichClipboard} className="rounded p-1 text-[#9aa3b2] hover:text-white" aria-label="Dismiss">
                <X size={13} />
              </button>
            </div>
          )}

          {displaysChanged && connected && (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
              <div className="rounded-md bg-[#3a2c10] px-3 py-1 text-[12px] text-[#f5b942]">The device's displays changed — reconnect to pick up the new layout.</div>
            </div>
          )}

          {viewOnly ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0e1116]/85 p-6 text-[#e6e9ef]">
              <div className="flex max-w-md flex-col items-center gap-3 text-center">
                <h2 className="text-[18px] font-semibold tracking-tight">View-only access</h2>
                <p className="text-[#9aa3b2]">You can see {deviceName} in the device list but are not allowed to connect to it.</p>
                <Link to={`/devices/${deviceId}`}>
                  <Button>Back to device</Button>
                </Link>
              </div>
            </div>
          ) : (
            <StateOverlay state={state} deviceName={deviceName} onRetry={() => void start()} onLeave={leave} onCancel={() => end()} deviceId={deviceId} />
          )}
        </div>

        {drawer === 'files' && <FilesDrawer deviceId={deviceId} enabled={allowFiles} onClose={() => setDrawer(null)} />}
        {drawer === 'chat' && <ChatDrawer lines={state.chat} deviceName={deviceName} connected={connected} onSend={sendChat} onClose={() => setDrawer(null)} />}
      </div>
      <audio ref={audioRef} autoPlay className="hidden" />
    </div>
  )
}

/* ───────────── display tile ───────────── */

function DisplayTile({
  display,
  stream,
  controlling,
  isCurrent,
  multi,
  stats,
  rtc,
  onEnter,
  onFocusRequest,
  onPointerDownFocus,
  sendInput,
}: {
  display: DisplayInfo
  stream: MediaStream | null
  controlling: boolean
  isCurrent: boolean
  multi: boolean
  stats: AgentStats | null
  rtc: ViewerState | null
  onEnter: () => void
  onFocusRequest: () => void
  onPointerDownFocus: () => void
  sendInput: (ev: InputEvent) => boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [needsGesture, setNeedsGesture] = useState(false)

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (v.srcObject !== stream) v.srcObject = stream
    if (stream) {
      v.play()
        .then(() => setNeedsGesture(false))
        .catch(() => setNeedsGesture(true))
    }
  }, [stream])

  const playAfterGesture = () => {
    const v = videoRef.current
    if (!v) return
    v.play()
      .then(() => setNeedsGesture(false))
      .catch(() => setNeedsGesture(true))
  }

  const pendingMove = useRef<{ x: number; y: number } | null>(null)
  const moveRaf = useRef<number | null>(null)

  const remotePoint = useCallback((e: { clientX: number; clientY: number }) => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return null
    const r = v.getBoundingClientRect()
    return toRemotePixels({ x: e.clientX - r.left, y: e.clientY - r.top }, { width: r.width, height: r.height }, { width: v.videoWidth, height: v.videoHeight })
  }, [])

  const flushMove = useCallback(() => {
    moveRaf.current = null
    const p = pendingMove.current
    pendingMove.current = null
    if (p) sendInput({ t: 'mm', x: p.x, y: p.y })
  }, [sendInput])

  const onPointerMove = (e: React.PointerEvent) => {
    if (!controlling) return
    const p = remotePoint(e)
    if (!p) return
    pendingMove.current = p
    if (moveRaf.current === null) moveRaf.current = requestAnimationFrame(flushMove)
  }
  const onPointerDown = (e: React.PointerEvent) => {
    onPointerDownFocus()
    if (!controlling) return
    const b = mouseButton(e.button)
    const p = remotePoint(e)
    if (!b || !p) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    sendInput({ t: 'mm', x: p.x, y: p.y })
    sendInput({ t: 'md', button: b })
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (!controlling) return
    const b = mouseButton(e.button)
    if (!b) return
    e.preventDefault()
    sendInput({ t: 'mu', button: b })
  }
  const tileRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = tileRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!controlling) return
      e.preventDefault()
      const ev = wheelToInput(e)
      if (ev) sendInput(ev)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [controlling, sendInput])

  return (
    <div
      ref={tileRef}
      className={cx('group relative min-h-0 min-w-0 overflow-hidden', controlling ? 'cursor-none' : 'cursor-default', multi && isCurrent && 'ring-1 ring-[#6cb6ff]/60 ring-inset')}
      onPointerEnter={onEnter}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" />
      {!stream && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12.5px] text-[#6b7381]">
          Waiting for {display.name}…
        </div>
      )}
      {multi && (
        <div className="absolute top-2 left-2 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="mono rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-[#c8ced8]">
            {display.index + 1} · {display.name}
          </span>
          <button onClick={onFocusRequest} className="rounded bg-black/60 p-1 text-[#c8ced8] hover:text-white" title="Show only this display">
            <Maximize2 size={12} />
          </button>
        </div>
      )}
      {needsGesture && stream && (
        <button type="button" onClick={playAfterGesture} className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/70 text-white">
          <span className="text-lg font-semibold">Click to start the video</span>
          <span className="text-sm opacity-80">Your browser blocked autoplay for this site (check the autoplay / Shields settings to avoid this).</span>
        </button>
      )}
      {stats && <StatsOverlay stats={stats} rtc={rtc} />}
    </div>
  )
}

/* ───────────── HUD parts ───────────── */

function HudButton({ children, onClick, title, active, disabled, danger, badge }: { children: React.ReactNode; onClick: () => void; title: string; active?: boolean; disabled?: boolean; danger?: boolean; badge?: number }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={cx(
        'relative rounded-md p-1.5 transition-colors disabled:opacity-40',
        active ? 'bg-[#6cb6ff]/20 text-[#6cb6ff]' : danger ? 'text-[#f87171] hover:bg-[#f87171]/15' : 'text-[#c8ced8] hover:bg-white/10 hover:text-white',
      )}
    >
      {children}
      {badge !== undefined && badge > 0 && (
        <span className="mono absolute -top-1 -right-1 min-w-[16px] rounded-full bg-[#6cb6ff] px-1 text-center text-[10px] leading-4 font-semibold text-[#0b1220]">{badge > 99 ? '99+' : badge}</span>
      )}
    </button>
  )
}

function HudSelect({ icon, value, onChange, options }: { icon: React.ReactNode; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[#c8ced8] hover:bg-white/10">
      {icon}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="bg-transparent text-[12px] text-inherit outline-none">
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-[#161a21] text-[#e6e9ef]">
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function QualityMenu({ sendControl, disabled, defaults }: { sendControl: (m: ControlMessage) => boolean; disabled: boolean; defaults: { fps: number; bitrate: number } }) {
  // The parent keys this component on the device defaults, so state resets with them.
  const [fps, setFps] = useState(defaults.fps)
  const [bitrate, setBitrate] = useState(defaults.bitrate)
  const fpsOptions = Array.from(new Set([...FPS_PRESETS, fps])).sort((a, b) => a - b)
  const brOptions = Array.from(new Set([...BITRATE_PRESETS, bitrate])).sort((a, b) => a - b)
  return (
    <div className={cx('flex items-center gap-1', disabled && 'opacity-40')}>
      <HudSelect
        icon={<span className="mono text-[10px]">FPS</span>}
        value={String(fps)}
        onChange={(v) => {
          setFps(Number(v))
          sendControl({ t: 'set_quality', max_fps: Number(v) })
        }}
        options={fpsOptions.map((f) => ({ value: String(f), label: `${f}` }))}
      />
      <HudSelect
        icon={<span className="mono text-[10px]">BR</span>}
        value={String(bitrate)}
        onChange={(v) => {
          setBitrate(Number(v))
          sendControl({ t: 'set_quality', max_bitrate_kbps: Number(v) })
        }}
        options={brOptions.map((b) => ({ value: String(b), label: kbps(b) }))}
      />
    </div>
  )
}

function PhasePill({ state }: { state: ViewerState }) {
  const map: Record<ViewerState['phase'], { cls: string; text: string }> = {
    idle: { cls: 'led-off', text: 'Idle' },
    connecting: { cls: 'led-warn', text: 'Connecting' },
    awaiting_approval: { cls: 'led-warn', text: 'Waiting for approval' },
    connected: { cls: state.iceState === 'disconnected' ? 'led-warn' : 'led-live', text: state.iceState === 'disconnected' ? 'Reconnecting' : 'Live' },
    ended: { cls: 'led-off', text: 'Ended' },
    error: { cls: 'led-off', text: 'Failed' },
  }
  const m = map[state.phase]
  return (
    <span className="mono flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-[#c8ced8]">
      <span className={cx('led', m.cls)} />
      {m.text}
      {state.codec && <span className="text-[#6b7381]">· {CODEC_LABEL[state.codec]}</span>}
    </span>
  )
}

function StatsOverlay({ stats: a, rtc }: { stats: AgentStats; rtc: ViewerState | null }) {
  const r = rtc?.rtcStats
  const rows: [string, string][] = [
    ['display', `#${a.display + 1}`],
    ['codec', `${CODEC_LABEL[a.codec]} ${a.hardware ? 'hw' : 'sw'}`],
    ['size', `${a.width}×${a.height}`],
    ['encoder fps', a.fps.toFixed(0)],
    ['bitrate', kbps(a.bitrate_kbps)],
    ['pipeline', `${a.pipeline_ms.toFixed(1)} ms`],
  ]
  if (r) {
    rows.push(['decoder fps', r.fps !== undefined ? r.fps.toFixed(0) : '—'])
    rows.push(['rtt', r.rttMs !== undefined ? `${r.rttMs.toFixed(0)} ms` : '—'])
    rows.push(['jitter', r.jitterMs !== undefined ? `${r.jitterMs.toFixed(1)} ms` : '—'])
    rows.push(['lost', r.packetsLost !== undefined ? String(r.packetsLost) : '—'])
    rows.push(['path', r.candidateType === 'relay' ? 'TURN relay' : (r.candidateType ?? '—')])
    rows.push(['asked for', rtc!.requestedCodec === 'unknown' ? 'browser default' : rtc!.requestedCodec.toUpperCase()])
  }
  return (
    <div className="mono pointer-events-none absolute top-2 right-2 z-10 rounded-md border border-white/10 bg-black/70 px-2.5 py-2 text-[11px] leading-[1.6] text-[#c8ced8] backdrop-blur">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4">
          <span className="text-[#6b7381]">{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  )
}

function StateOverlay({ state, deviceName, deviceId, onRetry, onLeave, onCancel }: { state: ViewerState; deviceName: string; deviceId: string; onRetry: () => void; onLeave: () => void; onCancel: () => void }) {
  const content = useMemo(() => {
    switch (state.phase) {
      case 'idle':
      case 'connecting':
        return { title: `Connecting to ${deviceName}`, detail: state.sessionId ? 'Negotiating the video path…' : 'Asking the console to reach the device…', spinner: true }
      case 'awaiting_approval':
        return {
          title: 'Waiting for approval',
          detail: `${deviceName} is in help-me mode. The person at the device has to click Allow.`,
          spinner: true,
          actions: <Button onClick={onCancel}>Cancel request</Button>,
        }
      case 'ended':
        return {
          title: 'Session ended',
          detail: state.endReason ? END_REASON_LABEL[state.endReason] : undefined,
          actions: (
            <>
              <Button variant="primary" onClick={onRetry}>
                Connect again
              </Button>
              <Button onClick={onLeave}>Back to device</Button>
            </>
          ),
        }
      case 'error':
        return {
          title: state.error?.code === 'denied' ? 'Request declined' : state.error?.code === 'approval_timeout' ? 'No answer' : 'Could not connect',
          detail: state.error?.message,
          actions: (
            <>
              <Button variant="primary" onClick={onRetry}>
                Try again
              </Button>
              <Link to={`/devices/${deviceId}`}>
                <Button>Back to device</Button>
              </Link>
            </>
          ),
        }
      default:
        return null
    }
  }, [state, deviceName, deviceId, onRetry, onLeave, onCancel])

  if (!content) {
    if (state.phase === 'connected' && state.iceState === 'disconnected') {
      return (
        <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
          <div className="rounded-md bg-[#3a2c10] px-3 py-1 text-[12px] text-[#f5b942]">Connection interrupted — trying to recover…</div>
        </div>
      )
    }
    return null
  }
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0e1116]/85 p-6 text-[#e6e9ef]">
      <div className="animate-fade-up flex max-w-md flex-col items-center gap-3 text-center">
        {content.spinner && <span className="led led-warn size-3" />}
        <h2 className="text-[18px] font-semibold tracking-tight">{content.title}</h2>
        {content.detail && <p className="text-[#9aa3b2]">{content.detail}</p>}
        {content.actions && <div className="mt-2 flex gap-2">{content.actions}</div>}
        {state.phase !== 'ended' && state.phase !== 'error' && (
          <p className="mt-4 text-[11.5px] text-[#6b7381]">
            While connected, press <span className="kbd">Ctrl</span>+<span className="kbd">Shift</span>+<span className="kbd">Esc</span> to release the keyboard.
          </p>
        )}
      </div>
    </div>
  )
}
