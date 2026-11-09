// Pure usage bookkeeping: turns CLIProxyAPI usage queue records into per-day totals and the views
// the panel and status bar show. No Orca or network access here, so it tests in plain Node.
//
// Model and account names come from the server, so every map keyed by them is created without a
// prototype: a name such as `__proto__` or `constructor` is an ordinary key, never a property of
// Object.prototype.

/** Token and request counts. `latencyMs` is the sum over all requests, for an average. */
export type Totals = {
  requests: number
  failed: number
  input: number
  output: number
  reasoning: number
  cached: number
  total: number
  latencyMs: number
}

export type DayBucket = {
  models: Record<string, Totals>
  accounts: Record<string, Totals>
  /** Provider of each model key, as the last record reported it. */
  providers: Record<string, string>
}

/** What the worker keeps in plugin storage under `STORE_KEY`. */
export type UsageStore = {
  version: 1
  /** Local calendar day of the computer running Orca (`YYYY-MM-DD`) to that day's totals. */
  days: Record<string, DayBucket>
  /**
   * When this store first counted a record: the local clock at that poll (epoch ms), not the record's
   * timestamp. Null until then and after a reset; pruning old days does not move it.
   */
  since: number | null
  /** Timestamp of the newest record counted (epoch ms, clamped to the poll time). */
  lastRecordAt: number | null
}

export type UsageRow = {
  key: string
  provider: string | null
  totals: Totals
}

export type UsageView = {
  totals: Totals
  models: UsageRow[]
  accounts: UsageRow[]
}

/**
 * The ranges the panel offers. Each counts back `days` local calendar days, today included. A range
 * longer than the retention setting shows only the days still kept.
 */
export const RANGES = [
  { id: 'today', label: 'Today', days: 1 },
  { id: 'days7', label: 'Last 7 days', days: 7 },
  { id: 'days30', label: 'Last 30 days', days: 30 }
] as const

export type RangeId = (typeof RANGES)[number]['id']

export const STORE_KEY = 'usage'
/** Distinct model or account names kept per day; further names are counted under `OTHER`. */
export const MAX_NAMES_PER_DAY = 200
export const OTHER = '(other)'
/** Rows a view lists per table, largest first. */
const MAX_ROWS = 50

const TOTAL_FIELDS = ['requests', 'failed', 'input', 'output', 'reasoning', 'cached', 'total', 'latencyMs'] as const

function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

export function emptyTotals(): Totals {
  return { requests: 0, failed: 0, input: 0, output: 0, reasoning: 0, cached: 0, total: 0, latencyMs: 0 }
}

export function emptyStore(): UsageStore {
  return { version: 1, days: dict(), since: null, lastRecordAt: null }
}

/** One queue record reduced to what the plugin counts. Never holds API keys or headers. */
export type NormalizedRecord = {
  at: number
  model: string
  provider: string | null
  account: string
  failed: boolean
  latencyMs: number
  input: number
  output: number
  reasoning: number
  cached: number
  total: number
}

/** A non-negative whole number from untrusted input; anything else counts as 0. */
const tokenCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
const label = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null

/**
 * Reads one record of the usage queue. Returns null for anything that is not a record. A
 * timestamp in the future (a server clock ahead of this computer) counts as `now`, so the record
 * lands in today's bucket instead of a day that does not exist yet.
 */
export function normalizeRecord(raw: unknown, now: number): NormalizedRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const tokens =
    record.tokens && typeof record.tokens === 'object' ? (record.tokens as Record<string, unknown>) : {}
  const parsed = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
  const input = tokenCount(tokens.input_tokens)
  const output = tokenCount(tokens.output_tokens)
  const reported = tokenCount(tokens.total_tokens)
  return {
    at: Number.isFinite(parsed) ? Math.min(parsed, now) : now,
    model: label(record.model) ?? label(record.alias) ?? 'unknown',
    provider: label(record.provider),
    account: label(record.source) ?? label(record.auth_index) ?? 'unknown',
    failed: record.failed === true,
    latencyMs: tokenCount(record.latency_ms),
    input,
    output,
    reasoning: tokenCount(tokens.reasoning_tokens),
    cached: tokenCount(tokens.cached_tokens),
    total: reported > 0 ? reported : input + output
  }
}

/** Calendar day of an epoch-ms timestamp in the local time zone of this computer, `YYYY-MM-DD`. */
export function dayKey(at: number): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** The `days` (at least 1) most recent local day keys up to the day of `now`, newest first. */
export function lastDays(now: number, days: number): string[] {
  const keys: string[] = []
  const cursor = new Date(now)
  for (let i = 0; i < Math.max(1, days); i++) {
    keys.push(dayKey(cursor.getTime()))
    cursor.setDate(cursor.getDate() - 1)
  }
  return keys
}

function totalsFor(map: Record<string, Totals>, name: string): Totals {
  const existing = map[name]
  if (existing) return existing
  const key = Object.keys(map).length >= MAX_NAMES_PER_DAY ? OTHER : name
  return (map[key] ??= emptyTotals())
}

function add(target: Totals, record: NormalizedRecord): void {
  target.requests += 1
  if (record.failed) target.failed += 1
  target.input += record.input
  target.output += record.output
  target.reasoning += record.reasoning
  target.cached += record.cached
  target.total += record.total
  target.latencyMs += record.latencyMs
}

function sum(target: Totals, source: Totals): void {
  for (const field of TOTAL_FIELDS) target[field] += source[field]
}

/**
 * Counts queue records into the store in place, skipping anything that is not a record, and drops
 * days older than `retentionDays` local days (today counts as one). `now` is epoch ms. Returns
 * whether the store changed, that is, whether it needs saving.
 */
export function ingest(store: UsageStore, records: readonly unknown[], now: number, retentionDays: number): boolean {
  let counted = 0
  for (const raw of records) {
    const record = normalizeRecord(raw, now)
    if (!record) continue
    const day = (store.days[dayKey(record.at)] ??= { models: dict(), accounts: dict(), providers: dict() })
    add(totalsFor(day.models, record.model), record)
    add(totalsFor(day.accounts, record.account), record)
    if (record.provider && day.models[record.model]) day.providers[record.model] = record.provider
    store.lastRecordAt = Math.max(store.lastRecordAt ?? record.at, record.at)
    counted += 1
  }
  if (counted > 0) store.since ??= now
  const keep = new Set(lastDays(now, retentionDays))
  let dropped = false
  for (const key of Object.keys(store.days)) {
    if (keep.has(key)) continue
    delete store.days[key]
    dropped = true
  }
  return counted > 0 || dropped
}

function rows(totals: Record<string, Totals>, providers: Record<string, string>): UsageRow[] {
  return Object.entries(totals)
    .map(([key, value]) => ({ key, provider: providers[key] ?? null, totals: value }))
    .sort((a, b) => b.totals.total - a.totals.total || b.totals.requests - a.totals.requests)
    .slice(0, MAX_ROWS)
}

/** Totals and the largest rows (at most 50 per table) of one range ending on the local day of `now`. */
export function viewFor(store: UsageStore, now: number, range: RangeId): UsageView {
  const days = RANGES.find((candidate) => candidate.id === range)?.days ?? 1
  const totals = emptyTotals()
  const models = dict<Totals>()
  const accounts = dict<Totals>()
  const providers = dict<string>()
  for (const key of lastDays(now, days)) {
    const bucket = store.days[key]
    if (!bucket) continue
    for (const [model, value] of Object.entries(bucket.models)) {
      sum((models[model] ??= emptyTotals()), value)
      sum(totals, value)
    }
    for (const [account, value] of Object.entries(bucket.accounts)) sum((accounts[account] ??= emptyTotals()), value)
    for (const [model, provider] of Object.entries(bucket.providers)) providers[model] ??= provider
  }
  return { totals, models: rows(models, providers), accounts: rows(accounts, dict()) }
}

export function allViews(store: UsageStore, now: number): Record<RangeId, UsageView> {
  return Object.fromEntries(RANGES.map((range) => [range.id, viewFor(store, now, range.id)])) as Record<
    RangeId,
    UsageView
  >
}

function readTotals(value: unknown): Totals | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const totals = emptyTotals()
  for (const field of TOTAL_FIELDS) totals[field] = tokenCount(source[field])
  return totals
}

function readMap<T>(value: unknown, read: (entry: unknown) => T | null): Record<string, T> {
  const map = dict<T>()
  if (!value || typeof value !== 'object') return map
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const parsed = read(entry)
    if (parsed !== null) map[key] = parsed
  }
  return map
}

/**
 * Reads a stored value back into prototype-free maps, dropping anything malformed. Starts over when
 * the value is missing or from an unknown version.
 */
export function readStore(value: unknown): UsageStore {
  if (!value || typeof value !== 'object') return emptyStore()
  const candidate = value as Record<string, unknown>
  if (candidate.version !== 1 || !candidate.days || typeof candidate.days !== 'object') return emptyStore()
  const store = emptyStore()
  for (const [key, bucket] of Object.entries(candidate.days as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !bucket || typeof bucket !== 'object') continue
    const day = bucket as Record<string, unknown>
    store.days[key] = {
      models: readMap(day.models, readTotals),
      accounts: readMap(day.accounts, readTotals),
      providers: readMap(day.providers, (entry) => (typeof entry === 'string' ? entry : null))
    }
  }
  store.since = typeof candidate.since === 'number' ? candidate.since : null
  store.lastRecordAt = typeof candidate.lastRecordAt === 'number' ? candidate.lastRecordAt : null
  return store
}

/** `950`, `12.3k`, `4.56M`, `1.2B`. */
export function compact(value: number): string {
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k']
  ]
  for (const [size, suffix] of units) {
    if (Math.abs(value) >= size) {
      const scaled = value / size
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
      return `${Number(scaled.toFixed(digits))}${suffix}`
    }
  }
  return String(Math.round(value))
}
