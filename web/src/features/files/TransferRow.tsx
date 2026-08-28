import { ArrowDownToLine, ArrowUpFromLine, Check, CircleAlert, Clipboard, Copy, FolderOpen, Loader2, RotateCcw, X, Zap } from 'lucide-react'
import { cx } from '@/components/cx'
import { bytes, duration, eta, throughput, timeOfDay } from '@/lib/format'
import { toast } from '@/lib/toast'
import { FileTypeIcon } from './fileIcons'
import { isTerminal, type Transfer, type TransferStatus } from './manager'
import { parentPath } from './paths'
import { compressionRatio } from './summary'
import { transferManager } from './store'

export const STATUS_LABEL: Record<TransferStatus, string> = {
  queued: 'Queued',
  offered: 'Waiting for the device',
  transferring: 'Transferring',
  paused: 'Paused — reconnecting',
  verifying: 'Verifying checksum',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

function copyText(text: string, what: string) {
  navigator.clipboard
    ?.writeText(text)
    .then(() => toast.success(`${what} copied`))
    .catch(() => toast.error(`Could not copy the ${what.toLowerCase()}`))
}

function IconButton({ onClick, title, danger, children }: { onClick: () => void; title: string; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cx('rounded p-1 text-[#9aa3b2] hover:bg-white/10', danger ? 'hover:text-[#f87171]' : 'hover:text-white')}
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  )
}

/**
 * One transfer: type icon, name, live progress with speed/ETA, compression ratio, resume
 * marker, destination/source path and the actions that make sense in its current state.
 */
export function TransferRow({ t, now, onReveal }: { t: Transfer; now: number; onReveal?: (dir: string) => void }) {
  const terminal = isTerminal(t.status)
  const pct = t.size > 0 ? Math.min(100, (t.bytes / t.size) * 100) : t.status === 'done' ? 100 : 0
  const resumedPct = t.size > 0 && t.startOffset > 0 ? Math.min(100, (t.startOffset / t.size) * 100) : 0
  const ratio = compressionRatio(t)
  const upload = t.direction === 'to_device'
  const folder = t.path ? (upload && t.status !== 'done' ? t.path : parentPath(t.path)) : null
  const canRetry = (t.status === 'failed' || t.status === 'cancelled') && t.resumable
  const tone = t.status === 'failed' ? 'bg-[#f87171]' : t.status === 'cancelled' ? 'bg-[#6b7381]' : t.status === 'done' ? 'bg-[#34d399]' : t.status === 'paused' ? 'bg-[#f5b942]' : 'bg-[#6cb6ff]'

  return (
    <div className={cx('group border-b border-white/5 px-3 py-2', terminal && 'opacity-90')} data-testid="transfer-row">
      <div className="flex items-center gap-2">
        <span className="relative shrink-0" title={upload ? 'To the device' : 'From the device'}>
          <FileTypeIcon name={t.name} isDir={false} size={16} />
          <span className={cx('absolute -right-1.5 -bottom-1 rounded-full bg-[#0e1116] p-px', upload ? 'text-[#6cb6ff]' : 'text-[#34d399]')}>
            {upload ? <ArrowUpFromLine size={9} /> : <ArrowDownToLine size={9} />}
          </span>
        </span>
        <span className="min-w-0 flex-1 truncate font-medium" title={t.path ?? t.name}>
          {t.name}
        </span>
        {t.kind !== 'file' && (
          <span className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-px text-[10.5px] text-[#9aa3b2]" title="Clipboard content">
            <Clipboard size={10} /> clipboard
          </span>
        )}
        <span className="flex shrink-0 items-center gap-0.5 opacity-70 group-hover:opacity-100">
          {t.status === 'done' && folder && onReveal && (
            <IconButton onClick={() => onReveal(folder)} title="Show in folder">
              <FolderOpen size={13} />
            </IconButton>
          )}
          {t.path && (
            <IconButton onClick={() => copyText(t.path!, 'Path')} title="Copy device path">
              <Copy size={12} />
            </IconButton>
          )}
          {canRetry && (
            <IconButton onClick={() => transferManager.retry(t.token)} title="Retry (resumes where it stopped)">
              <RotateCcw size={13} />
            </IconButton>
          )}
          {!terminal ? (
            <IconButton onClick={() => transferManager.cancel(t.token)} title="Cancel" danger>
              <X size={13} />
            </IconButton>
          ) : (
            <IconButton onClick={() => transferManager.remove(t.token)} title="Remove from list">
              <X size={13} />
            </IconButton>
          )}
        </span>
      </div>

      <div className="relative mt-1.5 h-1 overflow-hidden rounded bg-white/10" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        {resumedPct > 0 && <div className="absolute inset-y-0 left-0 bg-white/20" style={{ width: `${resumedPct}%` }} title="Already on the other side from a previous attempt" />}
        <div className={cx('relative h-full transition-[width] duration-150', tone, t.status === 'offered' && 'animate-pulse')} style={{ width: `${pct}%` }} />
      </div>

      <div className="mono mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-[#9aa3b2]">
        <span className={cx('inline-flex items-center gap-1', t.status === 'failed' && 'text-[#f87171]', t.status === 'done' && 'text-[#34d399]', t.status === 'paused' && 'text-[#f5b942]')}>
          {t.status === 'done' && <Check size={11} />}
          {t.status === 'failed' && <CircleAlert size={11} />}
          {(t.status === 'verifying' || t.status === 'offered') && <Loader2 size={11} className="animate-spin" />}
          {STATUS_LABEL[t.status]}
        </span>
        <span>
          {t.status === 'done' ? bytes(t.size) : `${bytes(t.bytes)} / ${bytes(t.size)}`}
          {!terminal && t.size > 0 && ` · ${Math.floor(pct)}%`}
        </span>
        {t.status === 'transferring' && t.speedBps > 0 && <span>{throughput(t.speedBps)}</span>}
        {t.status === 'transferring' && t.etaS !== null && <span>ETA {eta(t.etaS)}</span>}
        {ratio !== null && (
          <span className="inline-flex items-center gap-0.5 text-[#a5b4fc]" title={`Compressed on the fly: ${bytes(t.payloadBytes)} sent as ${bytes(t.wireBytes)}`}>
            <Zap size={10} />
            {ratio.toFixed(ratio >= 10 ? 0 : 1)}×
          </span>
        )}
        {t.startOffset > 0 && <span title="Resumed from a previous attempt">resumed at {bytes(t.startOffset)}</span>}
        <span className="ml-auto text-[#6b7381]">{terminal ? (t.finishedAt ? timeOfDay(t.finishedAt) : '') : duration(new Date(t.startedAt).toISOString(), null, now)}</span>
      </div>
      {t.error && <div className="mt-0.5 text-[11.5px] text-[#f87171]">{t.error}</div>}
      {t.path && (
        <div className="mono mt-0.5 flex items-center gap-1 truncate text-[11px] text-[#6b7381]" title={t.path}>
          {upload ? <ArrowUpFromLine size={10} className="shrink-0" /> : <ArrowDownToLine size={10} className="shrink-0" />}
          <span className="truncate">{t.path}</span>
        </div>
      )}
      {!t.path && upload && t.kind === 'file' && <div className="mono mt-0.5 text-[11px] text-[#6b7381]">Device default folder</div>}
    </div>
  )
}
