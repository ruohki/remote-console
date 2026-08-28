import type { ApiErrorBody } from './types'

/** Error thrown for non-2xx responses; `code` mirrors API.md error codes. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }

  get isUnauthorized() {
    return this.status === 401
  }
}

type Query = Record<string, string | number | boolean | undefined | null>

function withQuery(path: string, query?: Query) {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue
    params.set(k, String(v))
  }
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

/** Result of a request when the caller needs the status code (e.g. 200 vs 202 on login). */
export interface StatusResponse<T> {
  status: number
  data: T
}

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const { data } = await requestWithStatus<T>(method, path, body, query)
  return data
}

async function requestWithStatus<T>(method: string, path: string, body?: unknown, query?: Query): Promise<StatusResponse<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  // Every mutating request is JSON — this is part of the CSRF guard (server answers 415 otherwise).
  if (method !== 'GET') headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(withQuery(path, query), {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'network', 'The console could not be reached. Check your connection and try again.')
  }

  if (res.status === 204) return { status: 204, data: undefined as T }

  const text = await res.text()
  let json: unknown = undefined
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      /* non-JSON body, handled below */
    }
  }

  if (!res.ok) {
    const err = (json as Partial<ApiErrorBody> | undefined)?.error
    const code = err?.code ?? `http_${res.status}`
    // The 2FA policy gate: the auth store listens and routes to /security/setup.
    if (res.status === 403 && code === 'two_factor_required' && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('console:two-factor-required'))
    }
    throw new ApiError(res.status, code, err?.message ?? res.statusText ?? 'Request failed')
  }
  return { status: res.status, data: json as T }
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, query),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T = void>(path: string, body: unknown) => request<T>('PUT', path, body),
  delete: <T = void>(path: string) => request<T>('DELETE', path, {}),
  /** POST that also reports the HTTP status (login returns 200 or 202). */
  postWithStatus: <T>(path: string, body?: unknown) => requestWithStatus<T>('POST', path, body ?? {}),
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
