import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Activity, ArrowLeft, ChevronDown, ClipboardCopy, ClipboardPaste, Keyboard, KeyboardOff, Maximize2, Minimize2, MonitorSmartphone, RefreshCw, Shield, X } from 'lucide-react'
import { useViewerSession, type ViewerState } from '@/hooks/useViewerSession'
import { useLive } from '@/store/live'
import { toRemotePixels } from '@/lib/geometry'
import { keyboardToInput, mouseButton, RESERVED_SHORTCUTS, shortcutKey, wheelToInput } from '@/lib/input'
import { Button, cx } from '@/components/ui'
import { CODEC_LABEL, END_REASON_LABEL, kbps } from '@/lib/format'
import { toast } from '@/lib/toast'
import type { ControlMessage } from '@/protocol'

const FPS_PRESETS = [15, 30, 60]
const BITRATE_PRESETS = [2000, 4000, 8000, 15000, 30000]

export function Viewer() {
  const { deviceId = '' } = useParams()
  const navigate = useNavigate()
  const device = useLive((s) => s.devices[deviceId])
  const wsStatus = useLive((s) => s.wsStatus)
  const { state, start, end, sendInput, sendControl, selectDisplay } = useViewerSession(deviceId)

  const rootRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [inputEnabled, setInputEnabled] = useState(true)
  const [showStats, setShowStats] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [toolbar, setToolbar] = useState(true)
  const startedRef = useRef(false)

  // Kick off once the live socket is up (the device state is needed for a good error).
  useEffect(() => {
    if (startedRef.current || wsStatus !== 'open') return
    startedRef.current = true
    void start()
  }, [wsStatus, start])

  // Attach the stream.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (v.srcObject !== state.stream) v.srcObject = state.stream
    if (state.stream) v.play().catch(() => undefined)
  }, [state.stream])

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  const connected = state.phase === 'connected'
  const controlling = connected && inputEnabled

  /* ───── pointer & wheel ───── */
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
    surfaceRef.current?.focus()
    if (!controlling) return
    const b = mouseButton(e.button)
    const p = remotePoint(e)
    if (!b || !p) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    // make sure the cursor is where the click lands
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
  useEffect(() => {
    const el = surfaceRef.current
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

  /* ───── keyboard ───── */
  const lastHint = useRef(0)
  useEffect(() => {
    if (!controlling) return
    const target = surfaceRef.current
    const onKey = (e: KeyboardEvent) => {
      if (document.activeElement !== target) return
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
      if (!text) return toast.info('Your clipboard is empty')
      sendControl({ t: 'clipboard_set', text })
      toast.success('Clipboard sent to the device')
    } catch {
      toast.error('Clipboard access was blocked', 'Allow clipboard access for this site in the browser.')
    }
  }

  const deviceName = device?.name ?? 'Device'

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
          {state.displays.length > 1 && (
            <HudSelect
              icon={<MonitorSmartphone size={13} />}
              value={String(state.currentDisplay)}
              onChange={(v) => selectDisplay(Number(v))}
              options={state.displays.map((d) => ({ value: String(d.index), label: `${d.name} · ${d.width}×${d.height}` }))}
            />
          )}
          <QualityMenu sendControl={sendControl} disabled={!connected} />
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
          <HudButton onClick={() => sendControl({ t: 'secure_attention' })} disabled={!connected} title="Send Ctrl+Alt+Del">
            <Shield size={14} />
          </HudButton>
          <HudButton onClick={pasteToRemote} disabled={!connected} title="Send my clipboard to the device">
            <ClipboardPaste size={14} />
          </HudButton>
          {state.remoteClipboard !== null && (
            <HudButton
              onClick={() => navigator.clipboard.writeText(state.remoteClipboard ?? '').then(() => toast.success('Copied the device clipboard'))}
              title="Copy the device clipboard"
            >
              <ClipboardCopy size={14} />
            </HudButton>
          )}
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

      {/* surface */}
      <div
        ref={surfaceRef}
        tabIndex={0}
        className={cx('relative min-h-0 flex-1 outline-none', controlling ? 'cursor-none' : 'cursor-default')}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        onDragStart={(e) => e.preventDefault()}
      >
        <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" />
        {showStats && connected && <StatsOverlay state={state} />}
        <StateOverlay state={state} deviceName={deviceName} onRetry={() => void start()} onLeave={leave} onCancel={() => end()} deviceId={deviceId} />
      </div>
    </div>
  )
}

/* ───────────── HUD parts ───────────── */

function HudButton({ children, onClick, title, active, disabled, danger }: { children: React.ReactNode; onClick: () => void; title: string; active?: boolean; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={cx(
        'rounded-md p-1.5 transition-colors disabled:opacity-40',
        active ? 'bg-[#6cb6ff]/20 text-[#6cb6ff]' : danger ? 'text-[#f87171] hover:bg-[#f87171]/15' : 'text-[#c8ced8] hover:bg-white/10 hover:text-white',
      )}
    >
      {children}
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

function QualityMenu({ sendControl, disabled }: { sendControl: (m: ControlMessage) => boolean; disabled: boolean }) {
  const [fps, setFps] = useState(60)
  const [bitrate, setBitrate] = useState(8000)
  return (
    <div className={cx('flex items-center gap-1', disabled && 'opacity-40')}>
      <HudSelect
        icon={<span className="mono text-[10px]">FPS</span>}
        value={String(fps)}
        onChange={(v) => {
          setFps(Number(v))
          sendControl({ t: 'set_quality', max_fps: Number(v) })
        }}
        options={FPS_PRESETS.map((f) => ({ value: String(f), label: `${f}` }))}
      />
      <HudSelect
        icon={<span className="mono text-[10px]">BR</span>}
        value={String(bitrate)}
        onChange={(v) => {
          setBitrate(Number(v))
          sendControl({ t: 'set_quality', max_bitrate_kbps: Number(v) })
        }}
        options={BITRATE_PRESETS.map((b) => ({ value: String(b), label: kbps(b) }))}
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

function StatsOverlay({ state }: { state: ViewerState }) {
  const a = state.agentStats
  const r = state.rtcStats
  const rows: [string, string][] = [
    ['codec', a ? `${CODEC_LABEL[a.codec]} ${a.hardware ? 'hw' : 'sw'}` : (r?.codec ?? '—')],
    ['size', a ? `${a.width}×${a.height}` : r?.width ? `${r.width}×${r.height}` : '—'],
    ['encoder fps', a ? a.fps.toFixed(0) : '—'],
    ['decoder fps', r?.fps !== undefined ? r.fps.toFixed(0) : '—'],
    ['bitrate', r?.bitrateKbps !== undefined ? kbps(r.bitrateKbps) : a ? kbps(a.bitrate_kbps) : '—'],
    ['pipeline', a ? `${a.pipeline_ms.toFixed(1)} ms` : '—'],
    ['rtt', r?.rttMs !== undefined ? `${r.rttMs.toFixed(0)} ms` : '—'],
    ['jitter', r?.jitterMs !== undefined ? `${r.jitterMs.toFixed(1)} ms` : '—'],
    ['lost', r?.packetsLost !== undefined ? String(r.packetsLost) : '—'],
    ['path', r?.candidateType === 'relay' ? 'TURN relay' : (r?.candidateType ?? '—')],
    ['asked for', state.requestedCodec === 'unknown' ? 'browser default' : state.requestedCodec.toUpperCase()],
  ]
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
