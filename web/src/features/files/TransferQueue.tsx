import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronUp } from 'lucide-react'
import { cx } from '@/components/ui'
import { bytes, eta, throughput } from '@/lib/format'
import { useFiles } from './store'
import { summarize } from './summary'
import { TransfersTab } from './TransfersTab'
import type { CompressionPref } from './prefs'

export interface TransferQueueProps {
  open: boolean
  onToggle: () => void
  deviceId: string
  compression: CompressionPref
  onChangeCompression: (p: CompressionPref) => void
  onReveal: (dir: string) => void
}

/**
 * Bottom strip of the file manager: a one-line summary that stays visible, and the full
 * transfer list (progress, resume rows, compression) when expanded.
 */
export function TransferQueue({ open, onToggle, ...tab }: TransferQueueProps) {
  const transfers = useFiles((s) => s.transfers)
  const summary = summarize(transfers)
  const done = transfers.filter((t) => t.status === 'done').length
  const failed = transfers.filter((t) => t.status === 'failed' || t.status === 'cancelled').length
  return (
    <div className="flex shrink-0 flex-col border-t border-white/10 bg-[#0e1116]" data-testid="transfer-queue">
      <button onClick={onToggle} className="flex h-8 w-full items-center gap-2 px-3 text-left text-[12px] hover:bg-white/5" aria-expanded={open} aria-controls="transfer-queue-body">
        {open ? <ChevronDown size={13} className="text-[#9aa3b2]" /> : <ChevronUp size={13} className="text-[#9aa3b2]" />}
        <span className="font-medium text-[#e6e9ef]">Transfers</span>
        <span className="mono flex min-w-0 items-center gap-2.5 truncate text-[11.5px] text-[#9aa3b2]">
          {summary.active > 0 ? (
            <>
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
              <span>
                {bytes(summary.bytesDone)} / {bytes(summary.bytesTotal)}
              </span>
              {summary.speedBps > 0 && <span>{throughput(summary.speedBps)}</span>}
              {summary.etaS !== null && <span>ETA {eta(summary.etaS)}</span>}
            </>
          ) : transfers.length ? (
            <>
              {done > 0 && <span>{done} done</span>}
              {failed > 0 && <span className="text-[#f87171]">{failed} failed</span>}
            </>
          ) : (
            <span>idle</span>
          )}
        </span>
        {summary.active > 0 && (
          <span className="ml-auto h-1 w-32 shrink-0 overflow-hidden rounded bg-white/10">
            <span className="block h-full bg-[#6cb6ff] transition-[width] duration-150" style={{ width: `${summary.bytesTotal > 0 ? (summary.bytesDone / summary.bytesTotal) * 100 : 0}%` }} />
          </span>
        )}
      </button>
      <div id="transfer-queue-body" className={cx('flex flex-col border-t border-white/10', open ? 'h-[260px]' : 'hidden')}>
        <TransfersTab {...tab} />
      </div>
    </div>
  )
}
