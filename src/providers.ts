// What each provider's subscription quota looks like, and the only upstream requests this plugin
// ever asks CLIProxyAPI to send. One table entry per provider says which credentials it covers,
// which fields of their credential entries it needs, which fixed requests read their quota, and how
// to turn the upstream answer into windows that all read the same way: percent used (0 to 100) and
// when the window resets. A second table says what each upstream HTTP status means.
//
// Sources: CLIProxyAPI's api-call handler and the Management Center's quota page
// (router-for-me/Cli-Proxy-API-Management-Center, src/utils/quota/constants.ts, builders.ts and
// src/features/quota/providers/*), as of November 2026.
import type { Account, EntryFields } from './accounts'
import { cleanText, get, isRecord, json, list, number } from './untrusted'
import { PLUGIN_VERSION } from './version'

/** The User-Agent of every upstream quota request. Honest on purpose: it names this plugin. */
export const USER_AGENT = `orca-cliproxyapi-usage/${PLUGIN_VERSION}`

/** One rate-limit window of one account. */
export type Window = {
  /** Short and unique within its account, e.g. `5h`, `7d`, `7d Opus`, `Code review 7d`. */
  label: string
  /** Percent of the window used, 0 to 100, as precise as the provider said it. */
  usedPercent: number
  /** When the window resets, epoch ms; null when the provider did not say. */
  resetsAt: number | null
  /** The provider said this limit is reached, or the window is fully used. */
  limitReached: boolean
}

/** A request for CLIProxyAPI's api-call: `$TOKEN$` in a header is the account's token. */
export type UpstreamRequest = {
  method: 'GET' | 'POST'
  url: string
  header: Record<string, string>
  data?: string
}

/** An upstream reply that the server relayed: the upstream HTTP status and its body as text. */
export type UpstreamReply = { status: number; body: string }

/**
 * What sending one upstream request for one account comes to: the relayed reply (whatever its
 * status), or why the request failed for this account alone (its token could not be resolved, the
 * provider could not be reached or was too slow, ...), as a message fit to show.
 */
export type Delivery = UpstreamReply | { failed: string }

/**
 * Sends one upstream request for the account being read. Rejects only for failures that concern
 * every account (the management key, a ban, the poll stopping), which `readQuota` passes on.
 */
export type Send = (request: UpstreamRequest) => Promise<Delivery>

/**
 * A plan name such as `Max 5x`; null when it was looked up and the provider names none; undefined
 * when it is not known yet (never looked up, or the lookup failed and is worth trying again).
 */
export type Plan = string | null | undefined

/**
 * Why an account should not be asked again for a while: its provider rate-limited it (429), or
 * refused its token or the request (401, 403). How long is the caller's decision.
 */
export type Rest = 'rate-limited' | 'refused'

export type QuotaResult =
  | { ok: true; plan: Plan; windows: Window[]; notes: string[]; rest?: Rest }
  | { ok: false; error: string; rest?: Rest }

/** At most this many windows and notes are kept per account. */
export const MAX_WINDOWS = 12
const MAX_NOTES = 4
/**
 * At most this many entries of any list in an upstream answer are looked at (limits, groups,
 * buckets, additional rate limits); more could not become windows anyway.
 */
const MAX_LIST_ENTRIES = 32
/**
 * `readQuota` sends at most this many requests for one account (Antigravity's three hosts; Claude's
 * usage and plan), so one read takes at most this many api-call timeouts.
 */
export const MAX_REQUESTS_PER_READ = 3

const ENDPOINT = {
  claudeUsage: { method: 'GET', url: 'https://api.anthropic.com/api/oauth/usage' },
  claudeProfile: { method: 'GET', url: 'https://api.anthropic.com/api/oauth/profile' },
  codexUsage: { method: 'GET', url: 'https://chatgpt.com/backend-api/wham/usage' },
  antigravityDaily: {
    method: 'POST',
    url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'
  },
  antigravitySandbox: {
    method: 'POST',
    url: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary'
  },
  antigravityProd: { method: 'POST', url: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary' }
} as const satisfies Record<string, { method: UpstreamRequest['method']; url: string }>

const ALLOWED: ReadonlySet<string> = new Set(Object.values(ENDPOINT).map((endpoint) => `${endpoint.method} ${endpoint.url}`))

/**
 * Whether `method url` is one of the fixed quota requests above. Nothing else may go through
 * api-call: it can send any request with an account's token, including ones that spend reset
 * credits or download credentials.
 */
export function isAllowedUpstream(method: string, url: string): boolean {
  return ALLOWED.has(`${method} ${url}`)
}

/** What one quota answer says; `plan` undefined when this answer does not name one. */
type Parsed = { windows: Window[]; plan: string | undefined; notes: string[] }

/** A provider's table entry; `F` is the credential entry fields it declares and reads. */
type ProviderSpec<F extends EntryFields> = {
  /** Shown in the panel and the status bar. */
  name: string
  /** Credential `provider` values (normalized as `Account.provider`) this entry covers. */
  matches: readonly string[]
  /** The credential entry fields `requests` and `parse` read from `Account.details`. */
  entry: F
  /**
   * The quota requests for `account`, tried in order until one answers with windows; a string says
   * why this account cannot be read.
   */
  requests(account: Account<F>): UpstreamRequest[] | string
  /** Windows, plan and notes from a parsed JSON body; null when the body has no known shape. */
  parse(body: unknown, account: Account<F>, now: number): Parsed | null
  /** Asked after a successful quota read while the plan is not known (`Plan` undefined). */
  plan?: { request: UpstreamRequest; parse(body: unknown): string | null }
}

type Provider = ProviderSpec<EntryFields>

/**
 * Checks an entry against its own field declarations, then files it in the table. The accounts it
 * gets carry exactly these fields, because the credential list is read with `entryFieldsOf`.
 */
const provider = <F extends EntryFields>(spec: ProviderSpec<F>): Provider => spec as unknown as Provider

const request = (
  endpoint: (typeof ENDPOINT)[keyof typeof ENDPOINT],
  header: Record<string, string>,
  data?: string
): UpstreamRequest => ({
  method: endpoint.method,
  url: endpoint.url,
  header: { Authorization: 'Bearer $TOKEN$', Accept: 'application/json', 'User-Agent': USER_AGENT, ...header },
  ...(data === undefined ? {} : { data })
})

// --- Shared parsing -------------------------------------------------------------------------

/** The first of `keys` that `value` has, e.g. a camelCase field and its snake_case twin. */
const either = (value: unknown, ...keys: string[]): unknown => {
  for (const key of keys) {
    const found = get(value, key)
    if (found !== undefined && found !== null) return found
  }
  return undefined
}

const clampPercent = (value: number) => Math.min(100, Math.max(0, value))

/** Epoch ms from an ISO date, or from unix seconds (or ms, when the number is that large). */
function instant(value: unknown): number | null {
  if (typeof value === 'string' && !/^\s*\d+(\.\d+)?\s*$/.test(value)) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const seconds = number(value)
  if (seconds === null || seconds <= 0) return null
  const ms = seconds > 1e12 ? seconds : seconds * 1000
  return ms < 8.64e15 ? Math.round(ms) : null
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** `5h`, `7d`, `30d`, or the closest whole hours or days. */
function durationLabel(seconds: number): string {
  if (seconds === 18_000) return '5h'
  if (seconds === 604_800) return '7d'
  if (seconds >= 28 * 86_400 && seconds <= 31 * 86_400) return '30d'
  return seconds < 2 * 86_400 ? `${Math.max(1, Math.round(seconds / 3600))}h` : `${Math.round(seconds / 86_400)}d`
}

function window(label: string, usedPercent: number, resetsAt: number | null, limitReached = false): Window {
  const used = clampPercent(usedPercent)
  return { label, usedPercent: used, resetsAt, limitReached: limitReached || used >= 100 }
}

/** Keeps the first `MAX_WINDOWS` windows and makes their labels unique. */
function finish(windows: Window[]): Window[] {
  const seen = new Map<string, number>()
  return windows.slice(0, MAX_WINDOWS).map((entry) => {
    const count = (seen.get(entry.label) ?? 0) + 1
    seen.set(entry.label, count)
    return count === 1 ? entry : { ...entry, label: `${entry.label} (${count})` }
  })
}

// --- Claude ---------------------------------------------------------------------------------

/** Keys of `/api/oauth/usage` holding `{ utilization (0..100), resets_at (ISO) }`. */
const CLAUDE_WINDOWS: readonly (readonly [key: string, label: string])[] = [
  ['five_hour', '5h'],
  ['seven_day', '7d'],
  ['seven_day_opus', '7d Opus'],
  ['seven_day_sonnet', '7d Sonnet'],
  ['seven_day_oauth_apps', '7d OAuth apps'],
  ['seven_day_cowork', '7d Cowork']
]
/** Claude's code name for the weekly Fable window; with dollar fields it is a credit pool instead. */
const CLAUDE_FABLE_KEY = 'iguana_necktie'
const DOLLAR_FIELDS = ['limit_dollars', 'used_dollars', 'remaining_dollars']

/** Per-model weekly limits: `{ kind: 'weekly_scoped', percent, resets_at, scope: { model: { display_name } } }`. */
function claudeModelLimits(body: unknown): { model: string; used: number; resetsAt: number | null }[] {
  const limits: { model: string; used: number; resetsAt: number | null }[] = []
  for (const limit of list(get(body, 'limits'), MAX_LIST_ENTRIES)) {
    if (get(limit, 'kind') !== 'weekly_scoped') continue
    const used = number(get(limit, 'percent'))
    const model = cleanText(get(get(get(limit, 'scope'), 'model'), 'display_name'), 40)
    if (used !== null && model) limits.push({ model, used, resetsAt: instant(get(limit, 'resets_at')) })
  }
  return limits
}

function parseClaude(body: unknown): Parsed | null {
  if (!isRecord(body)) return null
  const windows: Window[] = []
  const readWindow = (key: string, label: string) => {
    const entry = get(body, key)
    const used = number(get(entry, 'utilization'))
    if (used !== null) windows.push(window(label, used, instant(get(entry, 'resets_at'))))
  }
  for (const [key, label] of CLAUDE_WINDOWS) readWindow(key, label)
  const limits = claudeModelLimits(body)
  // As the Management Center does: the `limits[]` entry for Fable wins; a credit pool is no window.
  const fable = get(body, CLAUDE_FABLE_KEY)
  const hasFableLimit = limits.some(({ model }) => /^fable( 5)?$/i.test(model))
  const isCreditPool = DOLLAR_FIELDS.some((key) => number(get(fable, key)) !== null)
  if (!hasFableLimit && !isCreditPool) readWindow(CLAUDE_FABLE_KEY, '7d Fable')
  for (const { model, used, resetsAt } of limits) {
    const label = `7d ${model}`
    if (!windows.some((entry) => entry.label === label)) windows.push(window(label, used, resetsAt))
  }
  const notes: string[] = []
  const extra = get(body, 'extra_usage')
  if (get(extra, 'is_enabled') === true) {
    const used = number(get(extra, 'utilization'))
    notes.push(used === null ? 'Extra usage is on.' : `Extra usage: ${Math.round(clampPercent(used))}% of the monthly limit used.`)
  }
  return { windows, plan: undefined, notes }
}

function parseClaudePlan(body: unknown): string | null {
  const organization = get(body, 'organization')
  if (get(organization, 'organization_type') === 'claude_team' && get(organization, 'subscription_status') === 'active') {
    return 'Team'
  }
  const tier = get(organization, 'rate_limit_tier')
  if (typeof tier === 'string' && tier.endsWith('claude_max_20x')) return 'Max 20x'
  if (typeof tier === 'string' && tier.endsWith('claude_max_5x')) return 'Max 5x'
  const account = get(body, 'account')
  if (get(account, 'has_claude_max') === true) return 'Max'
  if (get(account, 'has_claude_pro') === true) return 'Pro'
  if (get(account, 'has_claude_max') === false && get(account, 'has_claude_pro') === false) return 'Free'
  return null
}

// --- Codex ----------------------------------------------------------------------------------

const CODEX_ENTRY = {
  // Goes into a header: letters, digits and `-` only, so no `$TOKEN$` or line break gets in.
  chatgptAccountId: {
    paths: [['id_token', 'chatgpt_account_id'], ['chatgpt_account_id']],
    pattern: /^[A-Za-z0-9-]{1,128}$/
  },
  planType: { paths: [['id_token', 'plan_type']], pattern: /^[A-Za-z0-9 ._-]{1,40}$/ }
} as const satisfies EntryFields

/**
 * One `rate_limit` object: `{ allowed, limit_reached, primary_window, secondary_window }`, each
 * window `{ used_percent (0..100), limit_window_seconds, reset_at (unix s), reset_after_seconds }`.
 */
function codexWindows(rateLimit: unknown, prefix: string, now: number): Window[] {
  if (!isRecord(rateLimit)) return []
  const reached = get(rateLimit, 'limit_reached') === true || get(rateLimit, 'allowed') === false
  const windows: Window[] = []
  for (const [key, fallback] of [
    ['primary_window', '5h'],
    ['secondary_window', '7d']
  ] as const) {
    const entry = get(rateLimit, key)
    if (!isRecord(entry)) continue
    const used = number(get(entry, 'used_percent')) ?? (reached ? 100 : null)
    if (used === null) continue
    const seconds = number(get(entry, 'limit_window_seconds'))
    const label = seconds !== null && seconds > 0 ? durationLabel(seconds) : fallback
    const after = number(get(entry, 'reset_after_seconds'))
    const resetsAt = instant(get(entry, 'reset_at')) ?? (after !== null && after >= 0 ? now + after * 1000 : null)
    windows.push(window(prefix ? `${prefix} ${label}` : label, used, resetsAt))
  }
  // `limit_reached` is said of the whole limit; it is the fullest window that hit it.
  if (reached && windows.length > 0) {
    const fullest = windows.reduce((best, entry) => (entry.usedPercent > best.usedPercent ? entry : best))
    fullest.limitReached = true
  }
  return windows
}

function parseCodex(body: unknown, account: Account<typeof CODEX_ENTRY>, now: number): Parsed | null {
  if (!isRecord(body) || !isRecord(get(body, 'rate_limit'))) return null
  const windows = [
    ...codexWindows(get(body, 'rate_limit'), '', now),
    ...codexWindows(get(body, 'code_review_rate_limit'), 'Code review', now)
  ]
  for (const extra of list(get(body, 'additional_rate_limits'), MAX_LIST_ENTRIES)) {
    const name = cleanText(get(extra, 'limit_name'), 40) ?? cleanText(get(extra, 'metered_feature'), 40)
    if (name) windows.push(...codexWindows(get(extra, 'rate_limit'), name, now))
  }
  const planType = cleanText(get(body, 'plan_type'), 40) ?? account.details.planType
  const notes: string[] = []
  const credits = get(body, 'credits')
  if (get(credits, 'unlimited') === true) notes.push('Credits: unlimited.')
  else if (get(credits, 'has_credits') === true) {
    const balance = number(get(credits, 'balance'))
    notes.push(balance === null ? 'Credits available.' : `Credits: ${Math.round(balance * 100) / 100}.`)
  }
  return { windows, plan: planType ? capitalize(planType) : undefined, notes }
}

// --- Antigravity ----------------------------------------------------------------------------

const ANTIGRAVITY_ENTRY = {
  // Goes into the JSON body: letters, digits and `._:-` only.
  projectId: { paths: [['project_id']], pattern: /^[A-Za-z0-9._:-]{1,128}$/ }
} as const satisfies EntryFields

/** `window` spellings, lower case, as the Management Center accepts them; others show as named. */
const ANTIGRAVITY_PERIODS: Readonly<Record<string, string>> = {
  '5h': '5h',
  'five-hour': '5h',
  five_hour: '5h',
  weekly: '7d',
  week: '7d',
  daily: '1d'
}

/** `remainingFraction` as 0..1: a number, a numeric string, or a percent string such as `37%`. */
function remainingFraction(value: unknown): number | null {
  if (typeof value === 'string' && value.trim().endsWith('%')) {
    const percent = number(value.trim().slice(0, -1))
    return percent === null ? null : percent / 100
  }
  return number(value)
}

/**
 * `{ groups: [{ displayName, buckets: [{ displayName, window, remainingFraction, resetTime }] }] }`,
 * each field also in snake_case. A window is named by its group and period (`Gemini 5h`); when
 * that name is taken, or there is no period, by its group and the bucket's own name.
 */
function parseAntigravity(body: unknown): Parsed | null {
  if (!isRecord(body) || !Array.isArray(get(body, 'groups'))) return null
  const windows: Window[] = []
  for (const group of list(get(body, 'groups'), MAX_LIST_ENTRIES)) {
    const groupName = cleanText(either(group, 'displayName', 'display_name'), 40)
    for (const bucket of list(get(group, 'buckets'), MAX_LIST_ENTRIES)) {
      const remaining = remainingFraction(either(bucket, 'remainingFraction', 'remaining_fraction'))
      if (remaining === null) continue
      const rawPeriod = cleanText(get(bucket, 'window'), 20)
      const key = rawPeriod?.toLowerCase() ?? ''
      const period = Object.hasOwn(ANTIGRAVITY_PERIODS, key) ? ANTIGRAVITY_PERIODS[key] : rawPeriod
      const bucketName = cleanText(either(bucket, 'displayName', 'display_name', 'description'), 40)
      const name = (part: string | null) => [groupName, part].filter(Boolean).join(' ')
      let label = name(period ?? bucketName)
      if (bucketName && (!label || windows.some((entry) => entry.label === label))) label = name(bucketName)
      const used = 100 - Math.min(1, Math.max(0, remaining)) * 100
      windows.push(window(label || 'Quota', used, instant(either(bucket, 'resetTime', 'reset_time'))))
    }
  }
  return { windows, plan: undefined, notes: [] }
}

// --- The provider table ---------------------------------------------------------------------

const PROVIDERS: readonly Provider[] = [
  provider({
    name: 'Claude',
    matches: ['claude', 'anthropic'],
    entry: {},
    requests: () => [request(ENDPOINT.claudeUsage, { 'anthropic-beta': 'oauth-2025-04-20' })],
    parse: parseClaude,
    plan: { request: request(ENDPOINT.claudeProfile, { 'anthropic-beta': 'oauth-2025-04-20' }), parse: parseClaudePlan }
  }),
  provider({
    name: 'Codex',
    matches: ['codex'],
    entry: CODEX_ENTRY,
    requests: (account) => [
      request(
        ENDPOINT.codexUsage,
        account.details.chatgptAccountId ? { 'Chatgpt-Account-Id': account.details.chatgptAccountId } : {}
      )
    ],
    parse: parseCodex
  }),
  provider({
    name: 'Antigravity',
    matches: ['antigravity'],
    entry: ANTIGRAVITY_ENTRY,
    requests: (account) => {
      const project = account.details.projectId
      if (!project) return 'The credential list gives no Google Cloud project for this account, so its quota cannot be read.'
      const data = JSON.stringify({ project })
      const header = { 'Content-Type': 'application/json' }
      return [ENDPOINT.antigravityDaily, ENDPOINT.antigravitySandbox, ENDPOINT.antigravityProd].map((endpoint) =>
        request(endpoint, header, data)
      )
    },
    parse: parseAntigravity
  })
]

/** Display names of providers without quota support, so they read well in the panel. */
const OTHER_NAMES: Readonly<Record<string, string>> = {
  gemini: 'Gemini',
  'gemini-cli': 'Gemini CLI',
  vertex: 'Vertex AI',
  aistudio: 'AI Studio',
  kimi: 'Kimi',
  'kimi-ai': 'Kimi',
  xai: 'xAI',
  devin: 'Devin',
  meta: 'Meta',
  qwen: 'Qwen',
  iflow: 'iFlow'
}

const providerFor = (provider: string): Provider | null =>
  PROVIDERS.find((candidate) => candidate.matches.includes(provider)) ?? null

/** How the panel names a credential's provider, e.g. `Claude` for `claude`. */
export function providerName(provider: string): string {
  return (
    providerFor(provider)?.name ??
    (Object.hasOwn(OTHER_NAMES, provider) ? OTHER_NAMES[provider] : capitalize(provider.slice(0, 40)))
  )
}

/** Whether this plugin can read the quota of accounts of `provider`. */
export function hasQuota(provider: string): boolean {
  return providerFor(provider) !== null
}

/** The credential entry fields the provider of `provider` accounts needs; none for other providers. */
export function entryFieldsOf(provider: string): EntryFields {
  return providerFor(provider)?.entry ?? {}
}

// --- What an upstream status means ----------------------------------------------------------

/** What one upstream HTTP status means, for a quota request and for a plan request. */
type StatusMeaning = {
  /** Why the quota read failed, as shown on the account. */
  error(provider: string): string
  /** After a quota request: leave the account alone for a while. */
  rest?: Rest
  /** After a quota request: the other hosts are not asked, they would say the same. */
  stopsRead: boolean
  /** After a plan request: the plan (null: none, not asked again; undefined: ask again) and a rest. */
  plan: { plan: null | undefined; rest?: Rest }
}

const UPSTREAM_STATUS: Readonly<Record<number, StatusMeaning>> = {
  401: {
    error: (name) =>
      `${name} rejected the account's token (upstream 401): it expired or was revoked. CLIProxyAPI refreshes tokens in the background; sign in to the account again if this stays.`,
    rest: 'refused',
    stopsRead: true,
    plan: { plan: null }
  },
  403: {
    error: (name) => `${name} refused the quota request (upstream 403).`,
    rest: 'refused',
    stopsRead: false,
    plan: { plan: null }
  },
  404: { error: (name) => `${name} has no quota for this account (upstream 404).`, stopsRead: false, plan: { plan: null } },
  429: {
    error: (name) => `${name} rate-limited the quota request (upstream 429).`,
    rest: 'rate-limited',
    stopsRead: true,
    plan: { plan: undefined, rest: 'rate-limited' }
  }
}

/** The meaning of any status that is not a success; ones not in the table fail this read only. */
function meaningOf(status: number): StatusMeaning {
  if (Object.hasOwn(UPSTREAM_STATUS, status)) return UPSTREAM_STATUS[status]
  return { error: (name) => `${name} answered upstream HTTP ${status}.`, stopsRead: false, plan: { plan: undefined } }
}

const succeeded = (status: number) => status >= 200 && status < 300

/**
 * Reads the quota of one enabled account of a provider `hasQuota` covers (any other account
 * resolves with an error result, and nothing is sent). Sends only the provider's fixed requests,
 * at most `MAX_REQUESTS_PER_READ`, through `send`, and never puts an upstream body into a result.
 * `plan` is what earlier reads learnt; while it is undefined, a provider with a plan request asks
 * for it after a successful read. What an upstream status means (whether the other hosts are
 * asked, whether the account should rest) is `UPSTREAM_STATUS`'s. Rejects only when `send` rejects.
 */
export async function readQuota(account: Account, send: Send, options: { now: number; plan: Plan }): Promise<QuotaResult> {
  const provider = providerFor(account.provider)
  if (!provider) return { ok: false, error: `Quota is not available for ${providerName(account.provider)} accounts.` }
  const requests = provider.requests(account)
  if (typeof requests === 'string') return { ok: false, error: requests }
  let sent = 0
  let failure: (QuotaResult & { ok: false }) | null = null
  for (const next of requests.slice(0, MAX_REQUESTS_PER_READ)) {
    sent += 1
    const reply = await send(next)
    if ('failed' in reply) {
      failure ??= { ok: false, error: reply.failed }
      continue
    }
    if (!succeeded(reply.status)) {
      const meaning = meaningOf(reply.status)
      const refused: QuotaResult & { ok: false } = {
        ok: false,
        error: meaning.error(provider.name),
        ...(meaning.rest ? { rest: meaning.rest } : {})
      }
      if (meaning.stopsRead) return refused
      // A refusal says more than a host that is down or knows nothing of the account.
      if (!failure || (refused.rest && !failure.rest)) failure = refused
      continue
    }
    const parsed = provider.parse(json(reply.body), account, options.now)
    if (!parsed || parsed.windows.length === 0) {
      failure ??= {
        ok: false,
        error: parsed
          ? `${provider.name} reported no quota windows for this account.`
          : `${provider.name} answered in a form this plugin does not know.`
      }
      continue
    }
    const found = { ok: true, windows: finish(parsed.windows), notes: parsed.notes.slice(0, MAX_NOTES) } as const
    const plan = parsed.plan ?? options.plan
    if (plan !== undefined) return { ...found, plan }
    if (!provider.plan) return { ...found, plan: null }
    // Out of requests for this read: the plan is asked for on a later one.
    if (sent >= MAX_REQUESTS_PER_READ) return { ...found, plan: undefined }
    return { ...found, ...(await readPlan(provider.plan, send)) }
  }
  return failure ?? { ok: false, error: `${provider.name} gave no answer.` }
}

/** The plan from the provider's plan request; a failure is read in `UPSTREAM_STATUS`. */
async function readPlan(plan: NonNullable<Provider['plan']>, send: Send): Promise<{ plan: Plan; rest?: Rest }> {
  const reply = await send(plan.request)
  if ('failed' in reply) return { plan: undefined }
  if (!succeeded(reply.status)) return meaningOf(reply.status).plan
  return { plan: plan.parse(json(reply.body)) }
}
