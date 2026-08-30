import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { chatSoundEnabled, decideChatNotification, ensureNotificationPermission, notificationPermission, playChatSound, previewText, setChatSoundEnabled, showSystemNotification, titleWithUnread } from '@/lib/notify'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  ArrowLeft,
  Bell,
  BellOff,
  ChevronDown,
  ClipboardCopy,
  ClipboardPaste,
  Eye,
  EyeOff,
  FolderOpen,
  Hand,
  Keyboard,
  KeyboardOff,
  LayoutGrid,
  Maximize2,
  MessageSquare,
  Minimize2,
  MonitorSmartphone,
  MousePointer2,
  PenLine,
  RefreshCw,
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
import { Button, Select, cx } from '@/components/ui'
import { CODEC_LABEL, END_REASON_LABEL, bytes, kbps } from '@/lib/format'
import { toast } from '@/lib/toast'
import { effectiveControl } from '@/lib/controlPause'
import { privacyScreenDisabledReason } from '@/lib/privacyScreen'
import type { ControlMessage, DisplayInfo, InputEvent } from '@/protocol'
import type { DeviceDetail } from '@/lib/types'
import { FileManager, readDestDir } from '@/features/files/FileManager'
import { describeDrop, flattenDrop, isFileDrag, snapshotDrop } from '@/features/files/dnd'
import { ChatDrawer } from '@/features/chat/ChatDrawer'
import { activeTransferCount, transferManager, useFiles } from '@/features/files/store'
import type { FilesChannel } from '@/features/files/channel'
import { classifyPasteItems, clipboardImageName, toPngBlob, writeImageToClipboard } from '@/features/files/clipboard'
import { BlobSink, FileSystemSink, directoryPickerAvailable, guessMime, pickDirectory } from '@/features/files/sinks'
import { AnnotateCanvas } from '@/features/annotate/AnnotateCanvas'
import { AnnotateToolbar } from '@/features/annotate/AnnotateToolbar'
import { colorValue, useAnnotate } from '@/features/annotate/store'
import { PointerThrottle, StrokeBatcher, strokeWidthPx } from '@/features/annotate/model'
import { RemoteCursorLayer, type CursorStore } from '@/components/RemoteCursor'
import { cursorPredictionAllowed, sameHint, tileCursorClass, viewportHint, type ViewportHint } from '@/lib/perf'
import { LatencyProbe, rvfcSupported } from '@/lib/latencyProbe'

const FPS_PRESETS = [15, 30, 60]
const REMOTE_CURSOR_KEY = 'viewer.remoteCursor'
const perfProbeRequested = () => new URLSearchParams(window.location.search).get('perf') === '1'
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
  const allowAnnotations = (cfg?.allow_annotations ?? true)
  // Off by default: it hides the operator's actions from the person at the device.
  const allowPrivacyScreen = cfg?.allow_privacy_screen ?? false

  const deviceName = device?.name ?? 'Device'
  const knownDisplays = useMemo(() => device?.displays ?? [], [device?.displays])
  const [drawer, setDrawer] = useState<Drawer>(null)

  const [chatPulse, setChatPulse] = useState(0)
  const [chatBubble, setChatBubble] = useState<{ id: number; text: string } | null>(null)
  const chatBubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [chatSound, setChatSound] = useState(chatSoundEnabled)
  const { state, start, end, sendInput, sendControl, selectDisplay, setActiveDisplays, setAudio, setPrivacyScreen, setViewport, sendChat, setChatOpen, seedChat, clearRichClipboard, cursorStore, readRawStats, debugPushDeviceChat, debugPushControl, debugFakeStream } = useViewerSession(deviceId, {
    knownDisplays,
    wantAudio: allowAudio,
    onChatNotify: (line: ChatLine, drawerOpen: boolean) => {
      const d = decideChatNotification({ from: line.from, drawerOpen, tabVisible: document.visibilityState === 'visible', tabFocused: document.hasFocus(), permission: notificationPermission() })
      const body = previewText(line.text)
      if (d.toast) {
        // One in-surface bubble next to the Chat button (no corner toast): visible in
        // fullscreen and over any overlay, and it points at where to reply.
        setChatPulse((n) => n + 1)
        setChatBubble({ id: Date.now(), text: body })
        if (chatBubbleTimer.current) clearTimeout(chatBubbleTimer.current)
        chatBubbleTimer.current = setTimeout(() => setChatBubble(null), 8000)
      }
      if (d.system) showSystemNotification({ title: `${deviceName}: new message`, body, tag: `chat-${deviceId}`, onClick: () => setDrawer('chat') })
      if (d.sound) playChatSound()
    },
  })

  const rootRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [inputEnabled, setInputEnabled] = useState(true)
  const [showStats, setShowStats] = useState(false)
  const [showRemoteCursor, setShowRemoteCursor] = useState(() => localStorage.getItem(REMOTE_CURSOR_KEY) !== '0')
  const probeRef = useRef<LatencyProbe | null>(null)
  const perfEnabled = useMemo(() => perfProbeRequested() || import.meta.env.DEV || new URLSearchParams(window.location.search).get('debug') === '1', [])
  const [fullscreen, setFullscreen] = useState(false)
  const [toolbar, setToolbar] = useState(true)
  const [layout, setLayout] = useState<'single' | 'grid'>('single')
  const [volume, setVolume] = useState(1)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const [destDir, setDestDir] = useState<string | null>(() => readDestDir(deviceId))
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
  const control = effectiveControl({ connected, inputEnabled, controlPaused: state.controlPaused })
  const annotating = useAnnotate((s) => s.enabled)
  const annotateDisabledByDevice = useAnnotate((s) => s.disabledByDevice)
  const setAnnotating = useAnnotate((s) => s.setEnabled)
  // While annotating, pointer events draw instead of controlling; the keyboard is not forwarded either.
  const controlling = control.controlling && !annotating
  const annotateAvailable = connected && allowAnnotations && !annotateDisabledByDevice

  /* ───── privacy screen: gated by device support, device config and manage permission ───── */
  const privacyActive = state.privacyScreen.active
  const privacyDisabledReason = privacyScreenDisabledReason({
    support: device?.privacy_screen ?? 'unsupported',
    allowed: allowPrivacyScreen,
    permission: device?.permission,
  })
  const privacyAvailable = connected && privacyDisabledReason === null

  /* ───── annotations: agent refusal, session lifecycle, keyboard ───── */
  useEffect(() => {
    if (!state.annotationsDisabled) return
    useAnnotate.getState().setDisabledByDevice(true)
    toast.error('Annotations are not allowed on this device', 'Blocked by the console policy or a device-side setting.')
  }, [state.annotationsDisabled])
  useEffect(() => {
    // New session (or session end): forget the drawings; a fresh session starts clean on the device too.
    useAnnotate.getState().reset()
  }, [state.sessionId])
  useEffect(() => {
    if (!connected) useAnnotate.getState().setEnabled(false)
  }, [connected])
  const toggleAnnotate = useCallback(() => {
    if (!annotateAvailable) return
    if (annotating) {
      setAnnotating(false)
      return
    }
    sendInput({ t: 'rel' })
    setAnnotating(true)
  }, [annotateAvailable, annotating, setAnnotating, sendInput])
  const annotateUndo = useCallback(() => {
    for (const m of useAnnotate.getState().undo()) sendControl(m)
  }, [sendControl])
  const annotateClear = useCallback(() => {
    useAnnotate.getState().clear()
    sendControl({ t: 'annotate_clear' })
  }, [sendControl])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.key === 'Escape' && annotating) {
        e.preventDefault()
        setAnnotating(false)
        return
      }
      if (e.key.toLowerCase() !== 'a' || e.metaKey || e.ctrlKey || e.altKey) return
      if (controlling && document.activeElement === surfaceRef.current) return
      e.preventDefault()
      toggleAnnotate()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [annotating, controlling, toggleAnnotate, setAnnotating])

  // Tell the operator when the person at the device pauses / resumes remote control.
  const prevPausedRef = useRef(false)
  useEffect(() => {
    if (state.controlPaused === prevPausedRef.current) return
    prevPausedRef.current = state.controlPaused
    if (state.controlPaused) toast.info('Remote control paused by the person at the device', 'Screen sharing continues; only they can resume control.')
    else toast.success('Remote control resumed')
  }, [state.controlPaused])

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

  // Unread chat lines prefix the tab title until the drawer is opened.
  useEffect(() => {
    document.title = titleWithUnread(document.title, state.unreadChat)
    return () => {
      document.title = titleWithUnread(document.title, 0)
    }
  }, [state.unreadChat])

  // Ask for system notifications once per viewer, the first time a session connects.
  const askedNotifyRef = useRef(false)
  useEffect(() => {
    if (state.phase !== 'connected' || askedNotifyRef.current) return
    askedNotifyRef.current = true
    void ensureNotificationPermission()
  }, [state.phase])

  // Dev/test hook: inject a device chat line (`?debug=1` or dev builds).
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })
  useEffect(() => {
    const enabled = import.meta.env.DEV || new URLSearchParams(window.location.search).get('debug') === '1'
    if (!enabled) return
    const w = window as unknown as {
      __viewerDebug?: {
        pushChat: (text: string) => void
        pushControl: (msg: ControlMessage) => void
        fakeStream: (display?: number, width?: number, height?: number) => void
        latencyReset: () => void
        latencySnapshot: () => ReturnType<LatencyProbe['snapshot']> | null
        rtcBytes: () => Promise<{ bytes: number; framesDecoded: number } | null>
        agentStats: () => Record<number, AgentStats>
        /** Drive the files feature from a scripted channel (UI tests without a capturing agent). */
        filesChannel: (ch: FilesChannel) => void
      }
    }
    w.__viewerDebug = {
      pushChat: debugPushDeviceChat,
      pushControl: debugPushControl,
      fakeStream: (d = 0, w2 = 1920, h = 1080) => debugFakeStream(d, w2, h),
      latencyReset: () => probeRef.current?.reset(),
      latencySnapshot: () => probeRef.current?.snapshot() ?? null,
      rtcBytes: () => readRawStats(),
      agentStats: () => stateRef.current.agentStats,
      filesChannel: (ch) => {
        transferManager.deviceId = deviceId
        transferManager.attach(ch)
      },
    }
    return () => {
      delete w.__viewerDebug
    }
  }, [debugPushDeviceChat, debugPushControl, debugFakeStream, readRawStats, deviceId])

  // The remembered destination applies to drops and pastes even before the file manager was opened
  // (the manager itself keeps the transfer manager in sync while it is open).
  useEffect(() => {
    transferManager.setDefaultDestDir(destDir ?? undefined)
  }, [destDir])
  const refreshDestDir = () => setDestDir(readDestDir(deviceId))

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

  /* ───── S toggles the statistics while the keyboard is not forwarded ───── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 's' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (controlling && document.activeElement === surfaceRef.current) return
      e.preventDefault()
      setShowStats((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [controlling])

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

  /* ───── drag & drop uploads ─────
     dragenter/dragover must call preventDefault (with dropEffect=copy) or the browser refuses the
     drop; a depth counter keeps the overlay stable while the pointer crosses child elements. */
  const canDrop = connected && allowFiles
  const onDragEnter = (e: React.DragEvent) => {
    if (!isFileDrag(e.dataTransfer)) return
    e.preventDefault()
    if (dragDepth.current === 0) refreshDestDir()
    dragDepth.current += 1
    setDragging(true)
  }
  const onDragOver = (e: React.DragEvent) => {
    if (!isFileDrag(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = canDrop ? 'copy' : 'none'
  }
  const onDragLeave = (e: React.DragEvent) => {
    if (!isFileDrag(e.dataTransfer)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = (e: React.DragEvent) => {
    if (!isFileDrag(e.dataTransfer)) return
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (!canDrop) {
      toast.error(connected ? 'File transfer is disabled for this device' : 'Connect to the device first')
      return
    }
    // Snapshot synchronously: the item list is only readable during the event.
    const snap = snapshotDrop(e.dataTransfer)
    void flattenDrop(snap).then((files) => {
      if (!files.length) return
      for (const f of files) void transferManager.upload(f.file, { destDir: destDir ?? undefined })
      setDrawer('files')
      toast.info(`Sending ${describeDrop(files)} to ${deviceName}`, destDir ?? 'Device default folder')
    })
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
        {connected && privacyActive && (
          <span className="flex items-center gap-1.5 rounded-md border border-[#6cb6ff]/30 bg-[#6cb6ff]/10 px-2 py-0.5 text-[11px] whitespace-nowrap text-[#6cb6ff]" role="status" data-testid="privacy-screen-chip">
            <EyeOff size={12} />
            Screen hidden at device
          </span>
        )}
        <div className="ml-1 hidden items-center gap-1 md:flex">
          {displays.length > 1 && (
            <div className="flex items-center gap-0.5 rounded-md border border-white/10 px-1 py-0.5" title="Displays">
              <MonitorSmartphone size={13} className="mx-1 text-[#9aa3b2]" />
              {displays.map((d) => (
                <span key={d.index} className={cx('flex items-center rounded', active.includes(d.index) ? 'bg-[#6cb6ff]/20 text-[#6cb6ff]' : 'text-[#9aa3b2]')}>
                  <button onClick={() => focusDisplay(d.index)} className={cx('px-1.5 py-0.5 text-[11.5px] hover:text-white', state.currentDisplay === d.index && 'font-semibold')} title={`${d.name} · ${d.width}×${d.height}`}>
                    {d.index + 1}
                  </button>
                  <button onClick={() => toggleDisplay(d.index)} className="pr-1 hover:text-white" title={active.includes(d.index) ? 'Stop streaming' : 'Also stream'} disabled={!connected}>
                    <Square size={10} className={active.includes(d.index) ? 'fill-current' : ''} />
                  </button>
                </span>
              ))}
              {active.length > 1 && (
                <HudButton active={layout === 'grid'} onClick={() => setLayout((l) => (l === 'grid' ? 'single' : 'grid'))} title={layout === 'grid' ? 'Single display' : 'All displays'}>
                  <LayoutGrid size={13} />
                </HudButton>
              )}
            </div>
          )}
          <QualityMenu key={`${cfg?.max_fps ?? 60}-${cfg?.max_bitrate_kbps ?? 8000}`} sendControl={sendControl} disabled={!connected} defaults={{ fps: cfg?.max_fps ?? 60, bitrate: cfg?.max_bitrate_kbps ?? 8000 }} />
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          <HudButton
            active={annotating}
            disabled={!annotateAvailable}
            onClick={toggleAnnotate}
            title={
              !connected
                ? 'Annotate'
                : !allowAnnotations
                  ? 'Annotations are disabled for this device'
                  : annotateDisabledByDevice
                    ? 'Annotations are not allowed on this device (policy or device setting)'
                    : annotating
                      ? 'Leave annotate mode (Esc)'
                      : 'Annotate: draw on the remote screen to guide the person at the device (A)'
            }
          >
            <PenLine size={14} />
          </HudButton>
          <HudButton
            active={inputEnabled && !control.toggleLocked}
            disabled={control.toggleLocked}
            onClick={() => {
              if (control.toggleLocked) return
              setInputEnabled((v) => !v)
              if (inputEnabled) sendInput({ t: 'rel' })
            }}
            title={control.toggleTitle}
          >
            {inputEnabled && !control.toggleLocked ? <Keyboard size={14} /> : <KeyboardOff size={14} />}
          </HudButton>
          <HudButton
            active={showRemoteCursor}
            onClick={() => {
              setShowRemoteCursor((v) => {
                localStorage.setItem(REMOTE_CURSOR_KEY, v ? '0' : '1')
                return !v
              })
            }}
            title={showRemoteCursor ? 'Hide remote cursor' : 'Show remote cursor'}
          >
            <MousePointer2 size={14} />
          </HudButton>
          <span className="relative">
            <HudButton
              active={state.audioEnabled}
              onClick={toggleAudio}
              disabled={!connected || !allowAudio || !state.audioAvailable}
              title={!allowAudio ? 'Audio disabled' : !state.audioAvailable ? 'Audio unavailable' : state.audioEnabled ? 'Mute device audio' : 'Listen to device audio'}
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
          <HudButton
            active={privacyActive}
            disabled={!privacyAvailable}
            onClick={() => {
              if (privacyAvailable) setPrivacyScreen(!privacyActive)
            }}
            title={!connected ? 'Privacy screen' : (privacyDisabledReason ?? (privacyActive ? 'Show screen at device' : 'Privacy screen'))}
          >
            <EyeOff size={14} />
          </HudButton>
          {device?.os === 'windows' && (
            <HudButton onClick={() => sendControl({ t: 'secure_attention' })} disabled={!connected} title="Ctrl+Alt+Del">
              <CadIcon />
            </HudButton>
          )}
          <HudButton onClick={pasteToRemote} disabled={!connected || !allowClipboard} title="Paste clipboard to device">
            <ClipboardPaste size={14} />
          </HudButton>
          {state.remoteClipboard !== null && (
            <HudButton onClick={() => navigator.clipboard.writeText(state.remoteClipboard ?? '').then(() => toast.success('Copied the device clipboard'))} title="Copy device clipboard">
              <ClipboardCopy size={14} />
            </HudButton>
          )}
          <HudButton
            active={drawer === 'files'}
            onClick={() => {
              refreshDestDir()
              setDrawer((d) => (d === 'files' ? null : 'files'))
            }}
            title="Files"
            badge={activeTransfers || undefined}
          >
            <FolderOpen size={14} />
          </HudButton>
          <HudButton
            active={drawer === 'chat'}
            onClick={() => {
              setChatBubble(null)
              setDrawer((d) => (d === 'chat' ? null : 'chat'))
            }}
            title="Chat"
            badge={state.unreadChat || undefined}
            pulseKey={chatPulse}
          >
            <MessageSquare size={14} />
          </HudButton>
          <HudButton
            onClick={() => {
              const next = !chatSound
              setChatSoundEnabled(next)
              setChatSound(next)
            }}
            title={chatSound ? 'Mute chat sound' : 'Unmute chat sound'}
          >
            {chatSound ? <Bell size={14} /> : <BellOff size={14} />}
          </HudButton>
          <HudButton onClick={() => sendControl({ t: 'request_keyframe' })} disabled={!connected} title="Refresh picture">
            <RefreshCw size={14} />
          </HudButton>
          <HudButton active={showStats} onClick={() => setShowStats((v) => !v)} title="Statistics (S)">
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

      <div className="relative flex min-h-0 flex-1">
        {/* surface: all tiles share one focus target for the keyboard */}
        <div
          ref={surfaceRef}
          tabIndex={0}
          className={cx('relative min-h-0 min-w-0 flex-1 outline-none', dragging && 'ring-2 ring-[#6cb6ff] ring-inset')}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
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
                controlling={controlling && !dragging}
                annotating={annotating && !dragging}
                sendControl={sendControl}
                isCurrent={state.currentDisplay === index}
                multi={visible.length > 1}
                showStats={showStats}
                stats={state.agentStats[index] ?? null}
                rtc={index === state.currentDisplay ? state : null}
                onEnter={() => {
                  if (state.currentDisplay !== index) selectDisplay(index)
                }}
                onFocusRequest={() => focusDisplay(index)}
                onPointerDownFocus={() => surfaceRef.current?.focus()}
                sendInput={sendInput}
                setViewport={setViewport}
                cursorStore={cursorStore}
                showRemoteCursor={showRemoteCursor}
                fullscreen={fullscreen}
                probeRef={index === state.currentDisplay && perfEnabled ? probeRef : null}
              />
            ))}
          </div>

          {annotating && (
            <div className={cx('pointer-events-none absolute inset-x-0 z-20 flex justify-center', state.controlPaused ? 'top-12' : 'top-2')}>
              <AnnotateToolbar onUndo={annotateUndo} onClear={annotateClear} onExit={() => setAnnotating(false)} />
            </div>
          )}

          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[#0e1116]/75 p-6 backdrop-blur-[2px]">
              <div className={cx('flex flex-col items-center gap-2 rounded-lg border-2 border-dashed px-10 py-8 text-center', canDrop ? 'border-[#6cb6ff] text-white' : 'border-[#f87171] text-[#f87171]')}>
                <FolderOpen size={28} />
                <div className="text-lg font-semibold">{canDrop ? `Drop to send to ${deviceName}` : connected ? 'File transfer is disabled for this device' : 'Connect first to send files'}</div>
                {canDrop && (
                  <div className="mono text-[12px] text-[#9aa3b2]">
                    → {destDir ?? 'Device default folder'}
                  </div>
                )}
              </div>
            </div>
          )}

          {state.controlPaused && connected && (
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center" role="status" aria-live="assertive">
              <div className="flex items-center gap-2 rounded-b-lg border border-t-0 border-amber-400/40 bg-[#3a2a08] px-4 py-2 text-[13px] font-medium text-amber-200 shadow-pop">
                <Hand size={15} />
                Remote control paused by the person at the device — screen sharing continues
              </div>
            </div>
          )}

          {state.observers.length > 0 && (
            <div className={cx('pointer-events-none absolute inset-x-0 z-10 flex justify-center', state.controlPaused ? 'top-12' : 'top-2')}>
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
              <div className="rounded-md bg-[#3a2c10] px-3 py-1 text-[12px] text-[#f5b942]">Displays changed — reconnect.</div>
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

        {chatBubble && drawer !== 'chat' && (
          <div className="animate-fade-up absolute top-2 right-3 z-40 flex w-[300px] max-w-[calc(100%-1.5rem)] items-start gap-2 rounded-lg border border-white/10 bg-[#161a21]/95 px-3 py-2 text-[12.5px] text-[#e6e9ef] shadow-xl backdrop-blur" role="status" data-testid="chat-bubble">
            <MessageSquare size={14} className="mt-0.5 shrink-0 text-[#6cb6ff]" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-[#9aa3b2]">{deviceName} says</div>
              <div className="break-words">{chatBubble.text}</div>
              <button
                onClick={() => {
                  setChatBubble(null)
                  setDrawer('chat')
                }}
                className="mt-1.5 rounded-md bg-[#6cb6ff] px-2 py-0.5 text-[11.5px] font-medium text-[#0e1116] hover:opacity-90"
              >
                Open chat
              </button>
            </div>
            <button onClick={() => setChatBubble(null)} className="-mr-1 rounded p-0.5 text-[#6b7381] hover:text-white" aria-label="Dismiss message preview">
              <X size={13} />
            </button>
          </div>
        )}
        {drawer === 'files' && (
          <FileManager
            deviceId={deviceId}
            deviceName={deviceName}
            enabled={allowFiles}
            connected={connected}
            onClose={() => {
              refreshDestDir()
              setDrawer(null)
            }}
          />
        )}
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
  annotating,
  sendControl,
  isCurrent,
  multi,
  showStats,
  stats,
  rtc,
  onEnter,
  onFocusRequest,
  onPointerDownFocus,
  sendInput,
  setViewport,
  cursorStore,
  showRemoteCursor,
  fullscreen,
  probeRef,
}: {
  display: DisplayInfo
  stream: MediaStream | null
  controlling: boolean
  annotating: boolean
  sendControl: (m: ControlMessage) => boolean
  isCurrent: boolean
  multi: boolean
  showStats: boolean
  stats: AgentStats | null
  rtc: ViewerState | null
  onEnter: () => void
  onFocusRequest: () => void
  onPointerDownFocus: () => void
  sendInput: (ev: InputEvent) => boolean
  setViewport: (display: number, width: number | null, height: number | null) => boolean
  cursorStore: CursorStore
  showRemoteCursor: boolean
  fullscreen: boolean
  /** set when this tile should run the glass-to-glass latency probe (rig / stats overlay) */
  probeRef: React.MutableRefObject<LatencyProbe | null> | null
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [needsGesture, setNeedsGesture] = useState(false)
  /** A mouse button is held: the device is dragging, and our cursor overlay steps aside. */
  const [buttonHeld, setButtonHeld] = useState(false)
  const [latency, setLatency] = useState<{ medianMs: number | null; p95Ms: number | null } | null>(null)

  /* ───── viewport hint: ask the agent to encode no more pixels than we show ─────
     Sent on mount, resize, layout/fullscreen change and whenever the stream (re)attaches;
     debounced so a window drag produces one message. A failed send (channel not open yet)
     leaves the last hint unset so the next trigger retries. */
  const lastHint = useRef<ViewportHint | null>(null)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sendHint = useCallback(() => {
    hintTimer.current = null
    const v = videoRef.current
    if (!v || display.width === 0) return
    const r = v.getBoundingClientRect()
    const hint = viewportHint({ width: r.width, height: r.height }, { width: display.width, height: display.height }, window.devicePixelRatio || 1, fullscreen)
    if (probeRef) {
      // Debug/rig aid: expose the latest computed hint even when no channel is open yet.
      ;(window as unknown as { __viewerViewportHint?: unknown }).__viewerViewportHint = { display: display.index, ...hint, tile: { width: r.width, height: r.height } }
    }
    if (sameHint(lastHint.current, hint)) return
    if (setViewport(display.index, hint.width, hint.height)) lastHint.current = hint
  }, [display.width, display.height, display.index, fullscreen, setViewport, probeRef])
  const scheduleHint = useCallback(() => {
    if (hintTimer.current !== null) clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(sendHint, 250)
  }, [sendHint])
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const ro = new ResizeObserver(scheduleHint)
    ro.observe(v)
    scheduleHint()
    return () => {
      ro.disconnect()
      if (hintTimer.current !== null) clearTimeout(hintTimer.current)
    }
  }, [scheduleHint, stream, fullscreen])
  useEffect(() => {
    // A new session must re-announce the viewport.
    if (!stream) lastHint.current = null
  }, [stream])

  /* ───── latency probe (synthetic source strip) ───── */
  useEffect(() => {
    const v = videoRef.current
    if (!probeRef || !v || !stream || !rvfcSupported()) return
    const probe = new LatencyProbe(v)
    probe.start()
    probeRef.current = probe
    const t = setInterval(() => {
      const s = probe.snapshot()
      setLatency(s.samples.length ? { medianMs: s.medianMs, p95Ms: s.p95Ms } : null)
    }, 1000)
    return () => {
      clearInterval(t)
      probe.stop()
      if (probeRef.current === probe) probeRef.current = null
    }
  }, [probeRef, stream])

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

  const tileGeometry = useCallback(() => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return null
    const r = v.getBoundingClientRect()
    return { box: { width: r.width, height: r.height }, video: { width: v.videoWidth, height: v.videoHeight } }
  }, [])
  // Cursor positions are physical pixels of the display, not of the (possibly downscaled)
  // encoded picture, so the cursor layer maps against the display size.
  const cursorGeometry = useCallback(() => {
    const geo = tileGeometry()
    if (!geo) return null
    if (display.width > 0 && display.height > 0) return { box: geo.box, video: { width: display.width, height: display.height } }
    return geo
  }, [tileGeometry, display.width, display.height])

  /** The pointer in physical pixels of the remote *display* — the cursor overlay's space. */
  const displayPoint = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const geo = cursorGeometry()
      const v = videoRef.current
      if (!geo || !v) return null
      const r = v.getBoundingClientRect()
      return toRemotePixels({ x: e.clientX - r.left, y: e.clientY - r.top }, geo.box, geo.video)
    },
    [cursorGeometry],
  )

  const flushMove = useCallback(() => {
    moveRaf.current = null
    const p = pendingMove.current
    pendingMove.current = null
    if (p) sendInput({ t: 'mm', x: p.x, y: p.y })
  }, [sendInput])

  /* ───── annotations (pen / laser) ─────
     In annotate mode the pointer draws: strokes are batched per animation frame and streamed to
     the device; the local canvas mirrors them from the same messages. */
  const strokeRef = useRef<StrokeBatcher | null>(null)
  const strokeRaf = useRef<number | null>(null)
  const laserThrottle = useRef(new PointerThrottle(30))
  const emitLocal = useCallback(
    (m: ControlMessage) => {
      useAnnotate.getState().applyLocal(m)
      sendControl(m)
    },
    [sendControl],
  )
  const flushStroke = useCallback(() => {
    strokeRaf.current = null
    const m = strokeRef.current?.flush()
    if (m) emitLocal(m)
  }, [emitLocal])
  const endStroke = useCallback(() => {
    const s = strokeRef.current
    strokeRef.current = null
    if (strokeRaf.current !== null) {
      cancelAnimationFrame(strokeRaf.current)
      strokeRaf.current = null
    }
    if (!s) return
    for (const m of s.end()) emitLocal(m)
  }, [emitLocal])
  const laserAt = useCallback(
    (p: { x: number; y: number } | null, force = false) => {
      const now = Date.now()
      if (!force && !laserThrottle.current.allow(now)) return
      const { color } = useAnnotate.getState()
      emitLocal({ t: 'annotate_pointer', display: display.index, point: p ? [p.x, p.y] : undefined, color: colorValue(color) })
    },
    [display.index, emitLocal],
  )
  useEffect(() => {
    if (!annotating) {
      endStroke()
      laserAt(null, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotating])

  const onPointerMove = (e: React.PointerEvent) => {
    if (annotating) {
      const p = remotePoint(e)
      const { tool } = useAnnotate.getState()
      if (tool === 'laser') {
        laserAt(p)
        return
      }
      if (!p || !strokeRef.current) return
      if (strokeRef.current.push([p.x, p.y]) && strokeRaf.current === null) strokeRaf.current = requestAnimationFrame(flushStroke)
      return
    }
    if (!controlling) return
    const p = remotePoint(e)
    if (!p) return
    // Draw the cursor where the operator's hand is, not where the device last said it was —
    // except while dragging, when it must stay with the window it is moving.
    const local = cursorPredictionAllowed({ controlling, buttons: e.buttons }) ? displayPoint(e) : null
    cursorStore.setLocal(local ? { display: display.index, x: local.x, y: local.y, at: performance.now() } : null)
    pendingMove.current = p
    if (moveRaf.current === null) moveRaf.current = requestAnimationFrame(flushMove)
  }
  const onPointerDown = (e: React.PointerEvent) => {
    // The device carries the drag from here: its own cursor moves the window, so the overlay
    // hides and the prediction stops.
    cursorStore.setLocal(null)
    if (controlling && !annotating && mouseButton(e.button)) setButtonHeld(true)
    onPointerDownFocus()
    if (annotating) {
      const { tool, color, width } = useAnnotate.getState()
      if (tool !== 'pen' || e.button !== 0) return
      const p = remotePoint(e)
      if (!p) return
      e.preventDefault()
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      endStroke()
      const s = new StrokeBatcher(display.index, colorValue(color), strokeWidthPx(width, display.scale))
      s.push([p.x, p.y])
      strokeRef.current = s
      flushStroke()
      return
    }
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
    setButtonHeld(false)
    if (annotating) {
      if (e.button === 0) endStroke()
      return
    }
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
      className={cx('group relative min-h-0 min-w-0 overflow-hidden', tileCursorClass({ annotating, controlling }), multi && isCurrent && 'ring-1 ring-[#6cb6ff]/60 ring-inset')}
      onPointerEnter={onEnter}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setButtonHeld(false)}
      onPointerLeave={() => {
        cursorStore.setLocal(null)
        if (annotating) laserAt(null, true)
      }}
    >
      <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" />
      <RemoteCursorLayer store={cursorStore} display={display.index} getGeometry={cursorGeometry} controlling={controlling} dragging={buttonHeld} enabled={showRemoteCursor} />
      <AnnotateCanvas display={display.index} getGeometry={tileGeometry} />
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
          <span className="text-sm opacity-80">Autoplay blocked by the browser.</span>
        </button>
      )}
      {showStats && <StatsOverlay display={display} stats={stats} rtc={rtc} latency={latency} />}
    </div>
  )
}

/* ───────────── HUD parts ───────────── */

/** Three tiny key caps (Ctrl · Alt · Del) in a HUD-sized 16×16 glyph. */
function CadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
      <rect x="1" y="2.5" width="6" height="5" rx="1.2" />
      <rect x="9" y="2.5" width="6" height="5" rx="1.2" />
      <rect x="5" y="8.5" width="6" height="5" rx="1.2" />
      <path d="M2.6 5h2.8M10.6 5h2.8M6.6 11h2.8" strokeWidth="1" />
    </svg>
  )
}

function HudButton({ children, onClick, title, active, disabled, danger, badge, pulseKey }: { children: React.ReactNode; onClick: () => void; title: string; active?: boolean; disabled?: boolean; danger?: boolean; badge?: number; pulseKey?: number }) {
  return (
    <button
      key={pulseKey}
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={cx(
        'relative rounded-md p-1.5 transition-colors disabled:opacity-40',
        pulseKey ? 'animate-hud-pulse' : undefined,
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

function HudSelect({ icon, value, onChange, options, ariaLabel }: { icon: React.ReactNode; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; ariaLabel?: string }) {
  return <Select variant="hud" menuTone="dark" icon={icon} value={value} onChange={onChange} options={options} aria-label={ariaLabel} className="text-[12px]" />
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
        ariaLabel="Frame rate"
        value={String(fps)}
        onChange={(v) => {
          setFps(Number(v))
          sendControl({ t: 'set_quality', max_fps: Number(v) })
        }}
        options={fpsOptions.map((f) => ({ value: String(f), label: `${f}` }))}
      />
      <HudSelect
        icon={<span className="mono text-[10px]">BR</span>}
        ariaLabel="Bitrate"
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

function StatsOverlay({ display, stats: a, rtc, latency }: { display: DisplayInfo; stats: AgentStats | null; rtc: ViewerState | null; latency: { medianMs: number | null; p95Ms: number | null } | null }) {
  const r = rtc?.rtcStats
  const rows: [string, string][] = [['display', `#${display.index + 1} ${display.name}`.trim()]]
  if (a) {
    rows.push(['codec', `${CODEC_LABEL[a.codec]} ${a.hardware ? 'hw' : 'sw'}`])
    const scaled = a.encodedWidth && (a.encodedWidth !== a.width || a.encodedHeight !== a.height)
    rows.push(['size', scaled ? `${a.width}×${a.height} → ${a.encodedWidth}×${a.encodedHeight}` : `${a.width}×${a.height}`])
    rows.push(['encoder fps', a.fps.toFixed(0)])
    rows.push(['bitrate', kbps(a.bitrate_kbps)])
    rows.push(['capture→encoded', `${(a.captureToEncodedMs || a.pipeline_ms).toFixed(1)} ms`])
    if (a.encodeMs) rows.push(['encode', `${a.encodeMs.toFixed(1)} ms`])
    rows.push(['keyframes', String(a.keyframes)])
    rows.push(['idle skipped', String(a.framesSkippedIdle)])
  } else {
    rows.push(['encoder', rtc?.phase === 'connected' ? 'waiting for agent stats…' : 'not connected'])
    if (rtc?.codec) rows.push(['codec', CODEC_LABEL[rtc.codec]])
    if (r?.width && r?.height) rows.push(['size', `${r.width}×${r.height}`])
    if (r?.bitrateKbps !== undefined) rows.push(['bitrate', kbps(r.bitrateKbps)])
  }
  if (r) {
    rows.push(['decoder fps', r.fps !== undefined ? r.fps.toFixed(0) : '—'])
    rows.push(['rtt', r.rttMs !== undefined ? `${r.rttMs.toFixed(0)} ms` : '—'])
    rows.push(['jitter', r.jitterMs !== undefined ? `${r.jitterMs.toFixed(1)} ms` : '—'])
    rows.push(['lost', r.packetsLost !== undefined ? String(r.packetsLost) : '—'])
    rows.push(['path', r.candidateType === 'relay' ? 'TURN relay' : (r.candidateType ?? '—')])
    rows.push(['asked for', rtc!.requestedCodec === 'unknown' ? 'browser default' : rtc!.requestedCodec.toUpperCase()])
    rows.push(['fast input', rtc!.fastInput === 'open' ? 'on' : rtc!.fastInput === 'connecting' ? 'negotiating' : 'off (reliable)'])
  }
  if (latency && latency.medianMs !== null) {
    rows.push(['glass-to-glass', `${latency.medianMs.toFixed(0)} ms (p95 ${latency.p95Ms?.toFixed(0) ?? '—'})`])
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
          <div className="rounded-md bg-[#3a2c10] px-3 py-1 text-[12px] text-[#f5b942]">Reconnecting…</div>
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
