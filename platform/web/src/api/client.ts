import type { Problem } from './types'

/** `/exchange/api/v1` in production: the gateway strips `/exchange` and forwards the rest to core. */
export const API_BASE = `${import.meta.env.BASE_URL}api/v1`

const TOKEN_KEY = 'gie.session'

export interface StoredSession {
  token: string
  userId: number
  displayName: string
  expiresAt: string
}

/** The API answered with Problem Details (or at least with an error status). */
export class ApiError extends Error {
  readonly status: number
  readonly type: string
  readonly title: string
  readonly detail: string | undefined

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title)
    this.name = 'ApiError'
    this.status = problem.status
    this.type = problem.type
    this.title = problem.title
    this.detail = problem.detail
  }

  /** Worth retrying with the same request: the gateway or core was briefly unavailable. */
  get transient(): boolean {
    return this.status === 502 || this.status === 503 || this.status === 504
  }
}

/** The request never got an answer: offline, DNS, connection reset. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('Could not reach the exchange', { cause })
    this.name = 'NetworkError'
  }
}

/** Text for people: the Problem `detail` when there is one. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.detail ?? error.title
  if (error instanceof NetworkError) return 'Could not reach the exchange. Check your connection and try again.'
  return 'Something went wrong. Try again.'
}

// --- Session token ---------------------------------------------------------------------------------------------------

let session: StoredSession | null = readStoredSession()
const listeners = new Set<(session: StoredSession | null) => void>()

function readStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredSession
    if (typeof parsed.token !== 'string' || Date.parse(parsed.expiresAt) <= Date.now()) {
      localStorage.removeItem(TOKEN_KEY)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function getSession(): StoredSession | null {
  return session
}

export function setSession(next: StoredSession | null): void {
  session = next
  try {
    if (next) localStorage.setItem(TOKEN_KEY, JSON.stringify(next))
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Storage can be unavailable (private mode, blocked cookies): the session then lives until reload
  }
  listeners.forEach((listener) => listener(next))
}

export function subscribeSession(listener: (session: StoredSession | null) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Another tab signed in or out
window.addEventListener('storage', (event) => {
  if (event.key !== TOKEN_KEY) return
  session = readStoredSession()
  listeners.forEach((listener) => listener(session))
})

// --- Requests --------------------------------------------------------------------------------------------------------

interface RequestOptions {
  body?: unknown
  signal?: AbortSignal
  query?: Record<string, string | number | undefined>
}

export async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const url = new URL(`${API_BASE}${path}`, window.location.origin)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  const headers: Record<string, string> = { Accept: 'application/json' }
  const sentToken = session?.token
  if (sentToken) headers.Authorization = `Bearer ${sentToken}`
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? null : JSON.stringify(options.body),
      signal: options.signal ?? null,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new NetworkError(error)
  }

  if (response.status === 401 && sentToken && session?.token === sentToken) {
    // The token expired or the database was reset: back to the logged-out state
    setSession(null)
  }

  if (!response.ok) {
    throw new ApiError(await readProblem(response))
  }
  if (response.status === 204 || response.headers.get('Content-Length') === '0') {
    return undefined as T
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

async function readProblem(response: Response): Promise<Problem> {
  try {
    const body = (await response.json()) as Partial<Problem>
    return {
      type: body.type ?? 'about:blank',
      title: body.title ?? response.statusText,
      status: body.status ?? response.status,
      ...(body.detail ? { detail: body.detail } : {}),
    }
  } catch {
    const busy = response.status === 429
    return {
      type: busy ? '/problems/too-many-requests' : 'about:blank',
      title: busy ? 'Too many requests' : response.statusText || `HTTP ${response.status}`,
      status: response.status,
      ...(busy ? { detail: 'Too many requests. Wait a moment and try again.' } : {}),
    }
  }
}
