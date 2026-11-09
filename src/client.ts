// CLIProxyAPI management API client for one server and one management key. It hides which API
// version the server speaks (v8, or v0 before the v8 layout), timeouts, size caps, HTTP status codes
// and the shape of the credential list. Callers get validated accounts and, per account, a
// `Delivery`; a `ClientError` is thrown only for failures that concern every account, and says how
// long to stay away.
import { type Account, readCredentialList } from './accounts'
import { type Delivery, entryFieldsOf, isAllowedUpstream, type UpstreamRequest } from './providers'
import { cleanText, get, json, printable } from './untrusted'

export type ApiVersion = 'v8' | 'v0'

/**
 * CLIProxyAPI bans a client IP for `BAN_MS` after `BAN_ATTEMPTS` failed management logins in a
 * row, localhost included. That is why a refused key is never sent twice.
 */
export const BAN_ATTEMPTS = 5
export const BAN_MS = 30 * 60 * 1000

/**
 * What a caller does after a `ClientError`:
 * - `key-refused`: the server refused the key; do not send it again (see `BAN_ATTEMPTS`).
 * - `banned`: the server banned this computer's IP; send nothing for `retryAfterMs`.
 * - `none`: try again on the next poll.
 */
export type Pause = { kind: 'none' } | { kind: 'key-refused' } | { kind: 'banned'; retryAfterMs: number }

export class ClientError extends Error {
  constructor(
    message: string,
    readonly pause: Pause = { kind: 'none' }
  ) {
    super(message)
    this.name = 'ClientError'
  }
}

/** `fetch` as far as this client uses it; the body is read as a stream so its size can be capped. */
export type FetchLike = (
  url: string,
  init: {
    method: 'GET' | 'POST'
    headers: Record<string, string>
    body?: string
    signal: AbortSignal
    redirect: 'error'
  }
) => Promise<{
  status: number
  headers: { get(name: string): string | null }
  body: ReadableStream<Uint8Array> | null
}>

/** How long a management request (the credential list) may take, in milliseconds. */
export const MANAGEMENT_TIMEOUT_MS = 20_000
/**
 * How long an api-call may take, in milliseconds: CLIProxyAPI gives the upstream request up to
 * 60 s, so this leaves it time to answer with its own error first.
 */
export const API_CALL_TIMEOUT_MS = 70_000
/** Answers longer than this many bytes are refused; reading stops there. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024
/** Upstream bodies relayed by api-call longer than this many characters are refused. */
export const MAX_UPSTREAM_BODY_CHARS = 256 * 1024
/** At most this many characters of the server's own words go into a message. */
const DETAIL_CHARS = 200

export type ClientOptions = {
  /** Default `MANAGEMENT_TIMEOUT_MS`. */
  managementTimeoutMs?: number
  /** Default `API_CALL_TIMEOUT_MS`. */
  apiCallTimeoutMs?: number
}

const PATHS = {
  credentials: { v8: '/v8/management/credentials', v0: '/v0/management/auth-files' },
  apiCall: { v8: '/v8/management/requests/api-call', v0: '/v0/management/api-call' }
} as const satisfies Record<string, Record<ApiVersion, string>>

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

/** A management answer: its HTTP status and body text, or that the time ran out first. */
type Answer = { status: number; text: string } | 'timeout'

export class CpaClient {
  private versionInUse: ApiVersion | null = null
  private readonly managementTimeoutMs: number
  private readonly apiCallTimeoutMs: number

  /** `baseUrl` as `normalizeBaseUrl` returns it; `key` is the management key, sent as a bearer token. */
  constructor(
    readonly baseUrl: string,
    private readonly key: string,
    private readonly fetch: FetchLike,
    options: ClientOptions = {}
  ) {
    this.managementTimeoutMs = options.managementTimeoutMs ?? MANAGEMENT_TIMEOUT_MS
    this.apiCallTimeoutMs = options.apiCallTimeoutMs ?? API_CALL_TIMEOUT_MS
  }

  /** Whether this client talks to `baseUrl` with `key`, so it and its cached version can be reused. */
  matches(baseUrl: string, key: string): boolean {
    return this.baseUrl === baseUrl && this.key === key
  }

  /** The version the last successful request used; null before one succeeded. */
  get version(): ApiVersion | null {
    return this.versionInUse
  }

  /**
   * Every account the server lists (see `readCredentialList`). Throws only `ClientError`, or the
   * abort reason after `signal` aborted.
   */
  async listAccounts(signal?: AbortSignal): Promise<{ accounts: Account[]; omitted: number }> {
    const answer = await this.request(PATHS.credentials, 'GET', undefined, signal, this.managementTimeoutMs)
    if (answer === 'timeout') {
      throw new ClientError(`No answer from ${this.baseUrl} within ${this.managementTimeoutMs / 1000} s.`)
    }
    const listing = readCredentialList(this.success(answer), entryFieldsOf)
    if (!listing) throw new ClientError('The credential list did not answer with a files list.')
    return listing
  }

  /**
   * Has the server send `request` upstream with the token of the account `authIndex`; the server
   * puts the token where the request says `$TOKEN$`, so it never reaches this plugin. Only
   * requests on the providers' allowlist (`isAllowedUpstream`) are sent; anything else throws
   * before a byte leaves. Resolves with the upstream reply whatever its status, or with why it
   * failed for this account alone (CLIProxyAPI could not use its token or reach the provider, the
   * provider was too slow, its answer too large). Throws `ClientError` only for failures that
   * concern every account (the key, a ban, no management API, a server that answers nonsense),
   * or the abort reason after `signal` aborted.
   */
  async apiCall(authIndex: string, request: UpstreamRequest, signal?: AbortSignal): Promise<Delivery> {
    if (!isAllowedUpstream(request.method, request.url)) {
      throw new ClientError(`Refused to send ${request.method} ${request.url.slice(0, 100)}: not a quota request.`)
    }
    const payload = JSON.stringify({
      auth_index: authIndex,
      method: request.method,
      url: request.url,
      header: request.header,
      ...(request.data === undefined ? {} : { data: request.data })
    })
    const answer = await this.request(PATHS.apiCall, 'POST', payload, signal, this.apiCallTimeoutMs)
    if (answer === 'timeout') {
      return { failed: `No answer within ${this.apiCallTimeoutMs / 1000} s: the provider was too slow.` }
    }
    // api-call's own errors for one credential: 400 (token not found, refresh failed, ...) and
    // 502 (the upstream request failed).
    if (answer.status === 400 || answer.status === 502) {
      const detail = this.detail(answer.text)
      return { failed: `CLIProxyAPI answered HTTP ${answer.status} for this account${detail ? `: ${detail}` : '.'}` }
    }
    const body = this.success(answer)
    const status = get(body, 'status_code')
    const text = get(body, 'body')
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
      throw new ClientError('CLIProxyAPI answered the api-call without an upstream status.')
    }
    if (text !== undefined && text !== null && typeof text !== 'string') {
      throw new ClientError('CLIProxyAPI answered the api-call with a body that is not text.')
    }
    if (typeof text === 'string' && text.length > MAX_UPSTREAM_BODY_CHARS) {
      return { failed: `The provider's answer is larger than ${MAX_UPSTREAM_BODY_CHARS} characters.` }
    }
    return { status, body: text ?? '' }
  }

  /** The JSON body of a 2xx answer; throws a `ClientError` for any other. */
  private success(answer: { status: number; text: string }): unknown {
    const detail = () => this.detail(answer.text)
    if (answer.status < 200 || answer.status >= 300) {
      throw new ClientError(`CLIProxyAPI answered HTTP ${answer.status}${detail() ? `: ${detail()}` : ''}`)
    }
    const body = json(answer.text)
    if (body === undefined) throw new ClientError(`The server's answer is not JSON${detail() ? `: ${detail()}` : ''}`)
    return body
  }

  /**
   * Tries the version that worked last first and the other one when that answers 404, so a server
   * upgrade needs no restart. Throws for the answers that concern every request: a refused key
   * (never retried on the other version), a ban, refused management access, no management API.
   */
  private async request(
    paths: Record<ApiVersion, string>,
    method: 'GET' | 'POST',
    payload: string | undefined,
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<Answer> {
    const order: ApiVersion[] = this.versionInUse === 'v0' ? ['v0', 'v8'] : ['v8', 'v0']
    for (const version of order) {
      const answer = await this.exchange(paths[version], method, payload, signal, timeoutMs)
      if (answer === 'timeout') return answer
      if (answer.status === 404) continue
      this.refuseAccess(answer)
      this.versionInUse = version
      return answer
    }
    this.versionInUse = null
    throw new ClientError(
      `No management API at ${this.baseUrl}. Check the URL, and that the server sets management.secret-key and runs CLIProxyAPI 6.6.63 or later.`
    )
  }

  /** Throws for 401 and 403, choosing the advice from the server's own words. */
  private refuseAccess({ status, text }: { status: number; text: string }): void {
    if (status === 401) throw new ClientError('The server refused the management key.', { kind: 'key-refused' })
    if (status !== 403) return
    // Matched before the key is taken out, so a key that happens to be part of a word changes no advice.
    const words = serverWords(text)
    const detail = this.detail(text)
    if (/\bban/i.test(words)) {
      throw new ClientError('CLIProxyAPI banned this IP after too many failed logins.', {
        kind: 'banned',
        retryAfterMs: banLeftMs(words) ?? BAN_MS
      })
    }
    if (/key not set/i.test(words)) {
      throw new ClientError(
        `CLIProxyAPI has no management key (${detail}). Set management.secret-key on the server and enter that key here.`
      )
    }
    if (/remote management disabled/i.test(words)) {
      throw new ClientError(
        `CLIProxyAPI refuses management from other computers (${detail}). Set management.allow-remote: true on the server, or reach it through an SSH tunnel.`
      )
    }
    throw new ClientError(`CLIProxyAPI refused management access (HTTP 403${detail ? `: ${detail}` : ''}).`)
  }

  private async exchange(
    path: string,
    method: 'GET' | 'POST',
    payload: string | undefined,
    outer: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<Answer> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = outer ? AbortSignal.any([outer, timeout]) : timeout
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.key}`,
          Accept: 'application/json',
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(payload === undefined ? {} : { body: payload }),
        signal,
        // A redirect could carry the key to another host; the API never redirects.
        redirect: 'error'
      })
      return { status: response.status, text: await readCapped(response) }
    } catch (error) {
      if (outer?.aborted) throw outer.reason
      if (error instanceof ClientError) throw error
      if (timeout.aborted) return 'timeout'
      // The error's own text is not shown: it can quote request headers, the key among them.
      throw new ClientError(`Cannot reach ${this.baseUrl}. Check the URL, and that the server is running.`)
    }
  }

  /**
   * The server's own words about a failure: the `error` field of a JSON answer, or the start of a
   * text answer. Printable, at most `DETAIL_CHARS` characters, and without the key or any bearer
   * token: both are replaced by `***` in the whole printable text before it is cut, so neither a
   * control character inside the key nor the cut itself can let a part of it through.
   */
  private detail(text: string): string {
    const words = serverWords(text)
    const redacted = (this.key ? words.split(this.key).join('***') : words).replace(/\bBearer\s+\S+/gi, 'Bearer ***')
    return cleanText(redacted, DETAIL_CHARS) ?? ''
  }
}

/** The `error` field of a JSON answer, or else the whole text; printable, never cut. */
function serverWords(text: string): string {
  const error = get(json(text), 'error')
  return printable(typeof error === 'string' ? error : text) ?? ''
}

/**
 * The body as text, refused once it passes `MAX_BODY_BYTES`: early by its `Content-Length`,
 * otherwise while it streams in, so a hostile server cannot fill the worker's memory.
 */
async function readCapped(response: Awaited<ReturnType<FetchLike>>): Promise<string> {
  const tooLarge = () => new ClientError(`The server's answer is larger than ${MAX_BODY_BYTES} bytes.`)
  if (Number(response.headers.get('content-length')) > MAX_BODY_BYTES) {
    void response.body?.cancel().catch(() => undefined)
    throw tooLarge()
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    bytes += value.byteLength
    if (bytes > MAX_BODY_BYTES) {
      void reader.cancel().catch(() => undefined)
      throw tooLarge()
    }
    text += decoder.decode(value, { stream: true })
  }
}

/** The rest of a ban from CLIProxyAPI's `Try again in 29m59s`, in milliseconds; null when it does not say. */
function banLeftMs(detail: string): number | null {
  const match = /try again in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i.exec(detail)
  if (!match || !(match[1] || match[2] || match[3])) return null
  const ms = ((Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60 + Number(match[3] ?? 0)) * 1000
  return ms > 0 && ms <= 2 * BAN_MS ? Math.ceil(ms) : null
}
