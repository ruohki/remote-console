import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button, cx } from './ui'

/**
 * Footer for paged tables: page indicator plus previous/next. `hasNext` is derived by the
 * caller from the page size (a short page is the last one); `total` is optional for
 * client-side paged lists.
 */
export function Pager({
  page,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  loading,
  rows,
  pageSize,
  total,
  className,
}: {
  page: number
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
  loading?: boolean
  /** rows on the current page */
  rows: number
  pageSize: number
  total?: number
  className?: string
}) {
  if (!hasPrev && !hasNext && total === undefined) return null
  const from = rows === 0 ? 0 : (page - 1) * pageSize + 1
  const to = (page - 1) * pageSize + rows
  return (
    <nav className={cx('mt-3 flex items-center justify-between gap-3 text-[12.5px] text-ink-muted', className)} aria-label="Pagination">
      <span>
        {rows === 0 ? 'No rows' : total !== undefined ? `${from}–${to} of ${total}` : `${from}–${to}`}
        <span className="mx-1.5 text-ink-faint">·</span>
        Page {page}
        {total !== undefined && ` of ${Math.max(1, Math.ceil(total / pageSize))}`}
      </span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" icon={<ChevronLeft size={13} />} onClick={onPrev} disabled={!hasPrev || loading} aria-label="Previous page">
          Previous
        </Button>
        <Button size="sm" variant="ghost" onClick={onNext} disabled={!hasNext || loading} loading={loading} aria-label="Next page">
          Next <ChevronRight size={13} className="ml-1" />
        </Button>
      </div>
    </nav>
  )
}

/** "Load more" footer for accumulating lists (session history inside a panel). */
export function LoadMore({ hasMore, loading, onClick, shown, label = 'Load older' }: { hasMore: boolean; loading?: boolean; onClick: () => void; shown: number; label?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2 text-[12.5px] text-ink-muted">
      <span>{shown} shown{hasMore ? '' : ' · end of list'}</span>
      {hasMore && (
        <Button size="sm" variant="ghost" onClick={onClick} loading={loading}>
          {label}
        </Button>
      )}
    </div>
  )
}
