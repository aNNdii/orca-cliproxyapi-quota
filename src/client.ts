// CLIProxyAPI management API client for one server and one management key. It hides which API
// version the server speaks (v8, or v0 before the v8 layout), whether the server publishes usage,
// timeouts and HTTP status codes; callers pop records and get a `ClientError` that says how long to
// stay away.

export type ApiVersion = 'v8' | 'v0'

/**
 * What a caller does after a failure:
 * - `until-key-changes`: the server refused the key. CLIProxyAPI bans a client IP for about 30
 *   minutes after five failed attempts, so the same key must not be sent again.
 * - `until-time`: the server banned this IP; wait until `retryAt`.
 * - `none`: try again on the next poll.
 */
export type Pause = 'until-key-changes' | 'until-time' | 'none'

export class ClientError extends Error {
  constructor(
    message: string,
    readonly pause: Pause = 'none',
    /** Epoch ms after which `until-time` ends; null otherwise. */
    readonly retryAt: number | null = null
  ) {
    super(message)
    this.name = 'ClientError'
  }
}

export type FetchLike = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal; redirect: 'error' }
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>

/** How long one request may take, in milliseconds, unless `ClientOptions.timeoutMs` says otherwise. */
export const REQUEST_TIMEOUT_MS = 20_000
/** Answers longer than this many characters are refused rather than parsed. */
export const MAX_BODY_CHARS = 8 * 1024 * 1024
/** How long CLIProxyAPI bans an IP after repeated failed management logins, in milliseconds. */
export const BAN_MS = 30 * 60 * 1000

export type ClientOptions = {
  /** Clock for `ClientError.retryAt`, epoch ms. Default `Date.now`. */
  now?: () => number
  /** Per request, in milliseconds. Default `REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number
}

const QUEUE_PATH: Record<ApiVersion, string> = {
  v8: '/v8/management/observability/usage/queue',
  v0: '/v0/management/usage-queue'
}
const STATISTICS_PATH: Record<ApiVersion, string> = {
  v8: '/v8/management/config/observability/usage/usage-statistics-enabled',
  v0: '/v0/management/usage-statistics-enabled'
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i

/**
 * Accepts what people paste: trailing slashes, `/v1` (the OpenAI-compatible endpoint) or a
 * management path are dropped. Plain `http:` is accepted only for this computer, because the
 * management key would otherwise cross the network unencrypted. Throws a `ClientError` that says
 * what to fix.
 */
export function normalizeBaseUrl(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new ClientError('Set the CLIProxyAPI URL in the plugin settings.')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.test(url.hostname))) {
    throw new ClientError(
      'The CLIProxyAPI URL must use https://. Plain http:// is allowed only for localhost; use an SSH tunnel for a remote server without TLS.'
    )
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/(v1|v0\/management|v8\/management)$/, '')
  return `${url.origin}${path}`
}

type Answer = { found: true; body: unknown } | { found: false }

export class CpaClient {
  private versionInUse: ApiVersion | null = null
  private statistics: boolean | null = null
  private readonly now: () => number
  private readonly timeoutMs: number

  /** `baseUrl` as `normalizeBaseUrl` returns it; `key` is the management key, sent as a bearer token. */
  constructor(
    readonly baseUrl: string,
    private readonly key: string,
    private readonly fetch: FetchLike,
    options: ClientOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  }

  /** Whether this client talks to `baseUrl` with `key`, so it and its cached version can be reused. */
  matches(baseUrl: string, key: string): boolean {
    return this.baseUrl === baseUrl && this.key === key
  }

  /** The version the last successful pop used; null before one succeeded. */
  get version(): ApiVersion | null {
    return this.versionInUse
  }

  /**
   * false: the server does not publish usage records; null: not known. Read from the server's config
   * each time a pop finds the API version; any record received since sets it to true.
   */
  get statisticsEnabled(): boolean | null {
    return this.statistics
  }

  /**
   * Pops up to `count` records from the usage queue. The server removes what it returns, so the
   * caller must count every record it gets. Tries the version that worked last first and the other
   * one when that answers 404, so a server upgrade needs no restart. A refused key is never retried
   * on the other version. `signal` aborts the whole call (the worker stopping); each request also
   * has its own timeout. Throws only `ClientError`, or the abort reason after `signal` aborted.
   */
  async pop(count: number, signal?: AbortSignal): Promise<unknown[]> {
    const order: ApiVersion[] = this.versionInUse === 'v0' ? ['v0', 'v8'] : ['v8', 'v0']
    for (const version of order) {
      const answer = await this.get(`${QUEUE_PATH[version]}?count=${Math.max(1, Math.floor(count))}`, signal)
      if (!answer.found) continue
      if (!Array.isArray(answer.body)) throw new ClientError('The usage queue did not answer with a list.')
      if (this.versionInUse !== version) {
        this.versionInUse = version
        this.statistics = await this.readStatisticsEnabled(version, signal)
      }
      // A record proves the server publishes usage, whatever the switch read said.
      if (answer.body.length > 0) this.statistics = true
      return answer.body
    }
    this.versionInUse = null
    throw new ClientError(
      `No usage queue at ${this.baseUrl}. Check the URL, and that the server sets management.secret-key and runs CLIProxyAPI 6.10 or later.`
    )
  }

  /** Never throws: a failed read only means the answer is not known. */
  private async readStatisticsEnabled(version: ApiVersion, signal?: AbortSignal): Promise<boolean | null> {
    try {
      const answer = await this.get(STATISTICS_PATH[version], signal)
      // v8 answers 404 for a field the config file does not set; the default is off.
      if (!answer.found) return version === 'v8' ? false : null
      const body = answer.body
      if (typeof body === 'boolean') return body
      if (body && typeof body === 'object') {
        const value = (body as Record<string, unknown>)['usage-statistics-enabled']
        if (typeof value === 'boolean') return value
      }
      return null
    } catch {
      return null
    }
  }

  private async get(path: string, outer?: AbortSignal): Promise<Answer> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = outer ? AbortSignal.any([outer, timeout]) : timeout
    let response: Awaited<ReturnType<FetchLike>>
    let text: string
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.key}`, Accept: 'application/json' },
        signal,
        // A redirect could carry the key to another host; the API never redirects.
        redirect: 'error'
      })
      text = await response.text()
    } catch (error) {
      if (outer?.aborted) throw error
      if (timeout.aborted) throw new ClientError(`No answer from ${this.baseUrl} within ${this.timeoutMs / 1000} s.`)
      const reason = error instanceof Error ? error.message : String(error)
      throw new ClientError(`Cannot reach ${this.baseUrl}: ${reason}`)
    }
    if (text.length > MAX_BODY_CHARS) throw new ClientError(`The server's answer is larger than ${MAX_BODY_CHARS} characters.`)
    const detail = text.trim().slice(0, 200)
    if (response.status === 404) return { found: false }
    if (response.status === 401) throw new ClientError('The server refused the management key.', 'until-key-changes')
    if (response.status === 403 && /\bban/i.test(detail)) {
      const retryAt = this.now() + BAN_MS
      throw new ClientError(
        `CLIProxyAPI banned this IP after too many failed logins. Polling resumes at ${new Date(retryAt).toLocaleTimeString()}.`,
        'until-time',
        retryAt
      )
    }
    if (response.status === 403) {
      throw new ClientError(
        `Management access was refused (${detail || 'remote management disabled'}). Set management.allow-remote: true on the server.`
      )
    }
    if (!response.ok) throw new ClientError(`HTTP ${response.status} from ${this.baseUrl}: ${detail}`)
    try {
      return { found: true, body: JSON.parse(text) }
    } catch {
      throw new ClientError(`The server's answer is not JSON: ${detail}`)
    }
  }
}
