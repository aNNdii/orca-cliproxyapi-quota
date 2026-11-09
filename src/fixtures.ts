// Test data shaped like CLIProxyAPI's management answers and the providers' quota bodies, a sample
// panel state, and a stand-in server that answers the management API and relays api-calls to stub
// upstreams. The single source of these for the *.test.ts files and src/panel.check.ts; nothing
// here reaches the network.
import type { FetchLike } from './client'
import type { Clock } from './collector'
import type { QuotaState } from './protocol'

export const ORIGIN = 'https://cpa.example.com'
/** The management key the stand-in server accepts by default. */
export const KEY = 'good-key-123'
/** Monday 2026-11-09 12:00 local time; reset times below are relative to it. */
export const NOW = new Date(2026, 10, 9, 12, 0).getTime()
const HOUR = 3_600_000
const at = (hours: number) => new Date(NOW + hours * HOUR)

/** The management API's paths per layout. */
export const PATHS = {
  v8: { credentials: '/v8/management/credentials', apiCall: '/v8/management/requests/api-call' },
  v0: { credentials: '/v0/management/auth-files', apiCall: '/v0/management/api-call' }
} as const

/** The upstream quota URLs, as the providers' sources name them. */
export const UPSTREAM = {
  claudeUsage: 'https://api.anthropic.com/api/oauth/usage',
  claudeProfile: 'https://api.anthropic.com/api/oauth/profile',
  codexUsage: 'https://chatgpt.com/backend-api/wham/usage',
  /** In the order they are tried. */
  antigravity: [
    'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
    'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
    'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'
  ]
} as const

/**
 * A panel state with one account of each kind the panel shows: windows of every tone, a note, a
 * failed read with and without old windows, a missed read, a disabled and an unsupported account.
 */
export function sampleState(now: number, overrides: Partial<QuotaState> = {}): QuotaState {
  const quota = { kind: 'quota' as const, notes: [], error: null, missed: false }
  const greyed = { plan: null, windows: [], notes: [], error: null, updatedAt: null, missed: false }
  return {
    baseUrl: ORIGIN,
    hasKey: true,
    status: { kind: 'ok', message: null },
    lastPollAt: now - 30_000,
    polling: false,
    apiVersion: 'v8',
    pollSeconds: 300,
    omitted: 0,
    accounts: [
      {
        ...quota,
        id: 'a1',
        provider: 'Claude',
        title: 'me@example.com',
        plan: 'Max 5x',
        windows: [
          { label: '5h', usedPercent: 62, resetsAt: now + 2 * HOUR, limitReached: false },
          { label: '7d', usedPercent: 85, resetsAt: now + 50 * HOUR, limitReached: false },
          { label: '7d Sonnet', usedPercent: 12, resetsAt: now + 50 * HOUR, limitReached: false }
        ],
        notes: ['Extra usage: 5% of the monthly limit used.'],
        updatedAt: now - 30_000
      },
      {
        ...quota,
        id: 'b2',
        provider: 'Codex',
        title: 'work@example.com',
        plan: 'Plus',
        windows: [
          { label: '5h', usedPercent: 100, resetsAt: null, limitReached: true },
          { label: '7d', usedPercent: 41, resetsAt: now + 100 * HOUR, limitReached: false }
        ],
        error: "Codex rejected the account's token (upstream 401): it expired or was revoked.",
        updatedAt: now - 20 * 60_000
      },
      {
        ...quota,
        id: 'c3',
        provider: 'Antigravity',
        title: 'ag@example.com',
        plan: null,
        windows: [],
        error: 'Antigravity answered upstream HTTP 500.',
        updatedAt: null
      },
      {
        ...quota,
        id: 'f6',
        provider: 'Claude',
        title: 'team@example.com',
        plan: 'Team',
        windows: [{ label: '5h', usedPercent: 40, resetsAt: now + 4 * HOUR, limitReached: false }],
        updatedAt: now - 10 * 60_000,
        missed: true
      },
      { ...greyed, id: 'd4', kind: 'disabled', provider: 'Claude', title: 'old@example.com' },
      { ...greyed, id: 'e5', kind: 'unsupported', provider: 'Gemini CLI', title: 'g@example.com' }
    ],
    ...overrides
  }
}

/** `GET /api/oauth/usage`: utilization is percent used (0..100), resets_at an ISO time. */
export const claudeUsage = (fiveHour = 62) => ({
  five_hour: { utilization: fiveHour, resets_at: at(2.34).toISOString() },
  seven_day: { utilization: 30.5, resets_at: at(50).toISOString() },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 12, resets_at: at(50).toISOString() },
  extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 250, utilization: 5, currency: 'USD' },
  // Never shown: the plugin must not pass upstream bodies on.
  unknown_field: 'UPSTREAM-BODY-MARKER'
})

/** `GET /api/oauth/profile`. */
export const claudeProfile = {
  account: { has_claude_max: true, has_claude_pro: false, email: 'me@example.com' },
  organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_5x', subscription_status: 'active' }
}

/** `GET /backend-api/wham/usage`: reset_at in unix seconds, used_percent 0..100. */
export const codexUsage = () => ({
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 58,
      limit_window_seconds: 18_000,
      reset_after_seconds: 3_600,
      reset_at: Math.round((NOW + 3_600_000) / 1000)
    },
    secondary_window: { used_percent: 20, limit_window_seconds: 604_800, reset_after_seconds: 400_000 }
  },
  code_review_rate_limit: null,
  additional_rate_limits: [],
  credits: { has_credits: false, unlimited: false, balance: '0' }
})

/** `POST v1internal:retrieveUserQuotaSummary`: remainingFraction 0..1 (or a percent string). */
export const antigravitySummary = () => ({
  groups: [
    {
      displayName: 'Gemini',
      buckets: [
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.75, resetTime: at(3).toISOString() },
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: '40%', resetTime: at(100).toISOString() }
      ]
    },
    { displayName: 'Claude', buckets: [{ bucketId: 'claude-5h', window: '5h', remainingFraction: 1 }] }
  ]
})

/** `GET /v8/management/credentials`, as the v8 docs and `ListAuthFiles` describe it. */
export const credentialsV8 = () => ({
  observed_at: new Date(NOW).toISOString(),
  files: [
    {
      id: 'claude-me.json',
      auth_index: 'a1',
      name: 'claude-me.json',
      type: 'claude',
      provider: 'claude',
      email: 'me@example.com',
      status: 'ready',
      disabled: false,
      unavailable: false,
      source: 'file',
      // One data source only: these observed headers are ignored.
      quota: { observed_at: new Date(NOW).toISOString(), signals: { 'Anthropic-Ratelimit-Unified-5h-Utilization': '0.99' } }
    },
    {
      id: 'codex-work.json',
      auth_index: 'b2',
      name: 'codex-work.json',
      type: 'codex',
      provider: 'codex',
      email: 'work@example.com',
      disabled: false,
      id_token: { chatgpt_account_id: 'acct-123', plan_type: 'plus' }
    },
    {
      id: 'antigravity.json',
      auth_index: 'c3',
      name: 'antigravity.json',
      type: 'antigravity',
      provider: 'antigravity',
      email: 'ag@example.com',
      project_id: 'proj-42',
      disabled: false
    },
    { id: 'claude-old.json', auth_index: 'd4', name: 'claude-old.json', provider: 'claude', email: 'old@example.com', disabled: true },
    { id: 'gemini.json', auth_index: 'e5', name: 'gemini.json', provider: 'gemini_cli', email: 'g@example.com', disabled: false }
  ]
})

/** `GET /v0/management/auth-files` on a server before v8: `type` only, no `provider`. */
export const credentialsV0 = () => ({
  files: [{ auth_index: 'a1', name: 'claude-me.json', type: 'claude', email: 'me@example.com', disabled: false }]
})

export type ApiCall = {
  auth_index: string
  method: string
  url: string
  header: Record<string, string>
  data?: string
}
export type Sent = { origin: string; path: string; method: string; key: string; body: string | undefined }
/** The upstream's answer to one api-call; `raw` is the body text as is. */
export type UpstreamAnswer = { status: number; body?: unknown; raw?: string }

export type FakeServer = {
  /** Keys the server accepts. */
  keys: Set<string>
  /** Which management layout it serves. */
  layout: 'v8' | 'v0'
  credentials: unknown
  /** Answers each api-call; by default the fixtures above. */
  upstream: (call: ApiCall) => UpstreamAnswer
  /** Answers api-call itself with this management error instead, when set (by auth index). */
  apiCallErrors: Map<string, { status: number; body: unknown }>
  requests: Sent[]
  apiCalls: ApiCall[]
  /** Answers every request with this instead, when set. */
  override?: { status: number; body: unknown }
  /** Holds each request until it resolves, when set. */
  gate?: Promise<void>
  /** Each api-call takes this long, when set, so concurrency shows. */
  delayMs?: number
  /** Most api-calls waiting at the same time. */
  maxInFlight: number
  fetch: FetchLike
}

export function defaultUpstream(call: ApiCall): UpstreamAnswer {
  if (call.url === UPSTREAM.claudeUsage) return { status: 200, body: claudeUsage() }
  if (call.url === UPSTREAM.claudeProfile) return { status: 200, body: claudeProfile }
  if (call.url === UPSTREAM.codexUsage) return { status: 200, body: codexUsage() }
  if ((UPSTREAM.antigravity as readonly string[]).includes(call.url)) return { status: 200, body: antigravitySummary() }
  return { status: 404, body: { error: 'not found' } }
}

export function fakeServer(options: { keys?: string[]; layout?: 'v8' | 'v0'; credentials?: unknown } = {}): FakeServer {
  let inFlight = 0
  const server: FakeServer = {
    keys: new Set(options.keys ?? [KEY]),
    layout: options.layout ?? 'v8',
    credentials: options.credentials ?? (options.layout === 'v0' ? credentialsV0() : credentialsV8()),
    upstream: defaultUpstream,
    apiCallErrors: new Map(),
    requests: [],
    apiCalls: [],
    maxInFlight: 0,
    fetch: async (url, init) => {
      const parsed = new URL(url)
      const key = (init.headers.Authorization ?? '').replace(/^Bearer /, '')
      server.requests.push({ origin: parsed.origin, path: parsed.pathname, method: init.method, key, body: init.body })
      const paths = PATHS[server.layout]
      const isApiCall = parsed.pathname === paths.apiCall
      if (isApiCall) server.maxInFlight = Math.max(server.maxInFlight, ++inFlight)
      try {
        if (server.gate) await untilAborted(server.gate, init.signal)
        if (isApiCall && server.delayMs) await new Promise((resolve) => setTimeout(resolve, server.delayMs))
        if (init.signal.aborted) throw init.signal.reason
        const json = (status: number, body: unknown) => answer(status, JSON.stringify(body))
        if (server.override) return json(server.override.status, server.override.body)
        if (!server.keys.has(key)) return json(401, { error: 'invalid management key' })
        if (parsed.pathname === paths.credentials && init.method === 'GET') return json(200, server.credentials)
        if (isApiCall && init.method === 'POST') {
          const call = JSON.parse(init.body ?? '{}') as ApiCall
          server.apiCalls.push(call)
          const error = server.apiCallErrors.get(call.auth_index)
          if (error) return json(error.status, error.body)
          const reply = server.upstream(call)
          return json(200, {
            status_code: reply.status,
            header: { 'Content-Type': ['application/json'] },
            body: reply.raw ?? JSON.stringify(reply.body ?? '')
          })
        }
        return json(404, { error: 'not_found' })
      } finally {
        if (isApiCall) inFlight -= 1
      }
    }
  }
  return server
}

/** `gate`, or earlier when `signal` aborts. */
function untilAborted(gate: Promise<void>, signal: AbortSignal): Promise<void> {
  return Promise.race([gate, new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))])
}

/** A fetch answer with `text` as its body. */
export function answer(status: number, text: string, headers: Record<string, string> = {}) {
  return new Response(text, { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

/** A clock that moves only when told to; `advance` runs the tasks that fall due, in order. */
export type FakeClock = Clock & {
  /** Milliseconds until each waiting task, soonest first. */
  pending(): number[]
  advance(ms: number): void
}

export function fakeClock(start = NOW): FakeClock {
  let now = start
  let tasks: { at: number; task: () => void }[] = []
  return {
    now: () => now,
    after(ms, task) {
      const entry = { at: now + ms, task }
      tasks.push(entry)
      return () => {
        tasks = tasks.filter((other) => other !== entry)
      }
    },
    pending: () => tasks.map((entry) => entry.at - now).sort((a, b) => a - b),
    advance(ms) {
      const end = now + ms
      for (;;) {
        const due = tasks.filter((entry) => entry.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        tasks = tasks.filter((other) => other !== due)
        now = Math.max(now, due.at)
        due.task()
      }
      now = end
    }
  }
}
