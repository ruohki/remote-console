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

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
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

  if (res.status === 204) return undefined as T

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
    throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? res.statusText ?? 'Request failed')
  }
  return json as T
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, query),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T = void>(path: string) => request<T>('DELETE', path, {}),
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
