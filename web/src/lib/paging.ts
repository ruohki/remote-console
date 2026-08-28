/**
 * Cursor paging helpers shared by the audit log, session lists and other growing tables.
 *
 * Every paged endpoint returns a plain array ordered newest-first; the client passes a
 * `before` cursor derived from the last row of the previous page. A page shorter than the
 * requested size is the last one (API.md "List pagination").
 */

export interface PageState<C> {
  /** Cursors of the pages that came before the current one (stack, oldest first). */
  stack: C[]
  /** Cursor used to fetch the current page (`undefined` = first page). */
  current: C | undefined
}

export const FIRST_PAGE: PageState<never> = { stack: [], current: undefined }

export function firstPage<C>(): PageState<C> {
  return { stack: [], current: undefined }
}

/** Page number shown to the user (1-based). */
export function pageNumber<C>(s: PageState<C>): number {
  return s.stack.length + 1
}

/** True when the page that was just fetched is the last one. */
export function isLastPage(rowsOnPage: number, pageSize: number): boolean {
  return rowsOnPage < pageSize
}

/** Move forward: `next` is the cursor derived from the last row of the current page. */
export function goNext<C>(s: PageState<C>, next: C): PageState<C> {
  return { stack: [...s.stack, s.current as C], current: next }
}

/** Move back one page. */
export function goPrev<C>(s: PageState<C>): PageState<C> {
  if (s.stack.length === 0) return s
  const stack = s.stack.slice(0, -1)
  return { stack, current: s.stack[s.stack.length - 1] }
}

/** Jump to the first page (used when filters change). */
export function reset<C>(): PageState<C> {
  return firstPage<C>()
}

/**
 * Cursor for a list ordered by an ISO timestamp column (sessions): the last row's timestamp,
 * strict `<` on the server so the boundary row is not repeated.
 */
export function timeCursor<T extends { started_at: string }>(rows: T[]): string | undefined {
  const last = rows[rows.length - 1]
  return last?.started_at
}

/** Cursor for a list ordered by id (audit): the last row's id. */
export function idCursor<T extends { id: string | number }>(rows: T[]): string | undefined {
  const last = rows[rows.length - 1]
  return last === undefined ? undefined : String(last.id)
}

/**
 * "Load more" accumulation: append a page to what is already shown, dropping rows that were
 * already present (a live row may also arrive through the socket).
 */
export function appendPage<T extends { id: string | number }>(shown: T[], page: T[]): T[] {
  const seen = new Set(shown.map((r) => String(r.id)))
  const fresh = page.filter((r) => !seen.has(String(r.id)))
  return fresh.length ? [...shown, ...fresh] : shown
}

/** Client-side slice for lists that arrive whole (devices): page `n` of `size`. */
export function slicePage<T>(rows: T[], page: number, size: number): { rows: T[]; pages: number; page: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size))
  const p = Math.min(Math.max(1, page), pages)
  return { rows: rows.slice((p - 1) * size, p * size), pages, page: p }
}
