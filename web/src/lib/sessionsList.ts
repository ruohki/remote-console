/**
 * Embedded "recent sessions" blocks show only a handful of rows; the full list lives on the
 * sessions page (`/sessions?device_id=…`).
 */

export const RECENT_SESSIONS = 5

export interface Truncated<T> {
  rows: T[]
  /** true when the source had more rows than were kept */
  hasMore: boolean
}

/** Keep the first `max` rows (the API already orders newest first). */
export function truncateRecent<T>(rows: readonly T[], max = RECENT_SESSIONS): Truncated<T> {
  return { rows: rows.slice(0, max), hasMore: rows.length > max }
}

/** Link target for "Show all" — scoped to a device when one is given. */
export function allSessionsHref(deviceId?: string | null): string {
  return deviceId ? `/sessions?device_id=${encodeURIComponent(deviceId)}` : '/sessions'
}
