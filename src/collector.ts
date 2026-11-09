// The collector owns everything that changes over time: the poll timer, the poll in flight and its
// time budget, what is known about the server (its ban), the last good quota of every account and
// when each may be asked again, and telling the status bar and open panels. The key lives in
// src/keystore.ts, how anything reads (status labels, messages) in src/format.ts; src/worker.ts
// only connects Orca's handlers to it.
import type { OrcaWorkerApi } from 'orca/worker'
import type { Account } from './accounts'
import { API_CALL_TIMEOUT_MS, ClientError, CpaClient, type FetchLike, MANAGEMENT_TIMEOUT_MS, normalizeBaseUrl } from './client'
import { MESSAGES, type Overview, statusBarItem, summaryText } from './format'
import { KeyStore, type StoredKey } from './keystore'
import { type AccountView, fitState, type QuotaState, type StatusKind } from './protocol'
import {
  hasQuota,
  MAX_REQUESTS_PER_READ,
  type Plan,
  providerName,
  type QuotaResult,
  readQuota,
  type Rest,
  type Window
} from './providers'

/** Where the collector gets the time from, and how it waits. Tests pass one they can move. */
export type Clock = {
  /** Epoch ms. */
  now(): number
  /** Runs `task` once after `ms` milliseconds; the returned function cancels it. */
  after(ms: number, task: () => void): () => void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  after: (ms, task) => {
    const timer = setTimeout(task, ms)
    return () => clearTimeout(timer)
  }
}

/** Accounts read at the same time. */
export const CONCURRENCY = 3
/** How long an account rests after its provider rate-limited it (429). */
export const RATE_LIMIT_REST_MS = 15 * 60 * 1000
/** How long an account rests after its provider refused its token or the request (401, 403). */
export const REFUSED_REST_MS = 30 * 60 * 1000
/** The longest one account read can take: every request `readQuota` may send, each to its timeout. */
export const SLOWEST_READ_MS = MAX_REQUESTS_PER_READ * API_CALL_TIMEOUT_MS
/** A poll's deadline is at most this long after it began, unless the slowest read needs longer. */
export const MAX_POLL_MS = 5 * 60 * 1000
/** Time for the credential list, and to spare, on top of the slowest read. */
const DEADLINE_MARGIN_MS = MANAGEMENT_TIMEOUT_MS + 10_000

/**
 * When a poll stops starting account reads, in ms after it began: after its interval (at most
 * `MAX_POLL_MS`), but never before the slowest read could have ended, so one slow account cannot
 * keep the others from being read. Reads already running at the deadline end on their own,
 * bounded by the client's timeouts; the poll then shows what it read, and the accounts it did not
 * get to keep their last numbers, say so (`AccountView.missed`) and go first in the next poll. A
 * credential list still pending at the deadline is stopped, which fails the poll.
 */
export function pollDeadlineMs(pollSeconds: number): number {
  return Math.max(SLOWEST_READ_MS + DEADLINE_MARGIN_MS, Math.min(pollSeconds * 1000, MAX_POLL_MS))
}

/** Plugin storage key of the usage counts version 0.1 kept; deleted on start. */
const LEGACY_STORE_KEY = 'usage'
const POLL = { default: 300, min: 60, max: 3600 }
const REST_MS: Record<Rest, number> = { 'rate-limited': RATE_LIMIT_REST_MS, refused: REFUSED_REST_MS }

type Settings = { baseUrl: string | null; urlError: string | null; pollSeconds: number }

/** What the collector remembers of one account between polls. */
type Memory = {
  plan: Plan
  windows: Window[]
  notes: string[]
  error: string | null
  updatedAt: number | null
  /** Not asked before `until` (epoch ms); a manual refresh ignores a `refused` rest. */
  rest: { until: number; reason: Rest } | null
  /** When a read of this account last ended (epoch ms); the longest unread go first. */
  readAt: number | null
  /** The last poll was due to read it but stopped first. */
  missed: boolean
}

/**
 * The one rule for which accounts are read: only `readable` ones are. The others are shown, and
 * say why they are not read.
 */
function classify(account: Account): 'disabled' | 'unsupported' | 'no-auth-index' | 'readable' {
  if (account.disabled) return 'disabled'
  if (!hasQuota(account.provider)) return 'unsupported'
  if (account.authIndex === null) return 'no-auth-index'
  return 'readable'
}

const clamp = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const invalid = (text: string) => Object.assign(new Error(text), { code: 'invalid_params' })

export class Collector {
  private status: QuotaState['status'] = { kind: 'unconfigured', message: null }
  private lastPollAt: number | null = null
  private accounts: AccountView[] = []
  private omitted = 0
  /** By account id; only accounts of the current server and key. Replaced as a whole by each poll. */
  private memory = new Map<string, Memory>()
  /**
   * Reused while URL and key stay the same, so the API version it found stays cached. A poll
   * whose client is no longer this one was overtaken (the key was saved or forgotten meanwhile)
   * and changes nothing.
   */
  private client: CpaClient | null = null
  /** The server banned this computer's IP: nothing goes to `origin` before `until` (epoch ms). */
  private ban: { origin: string; until: number; reason: string } | null = null
  /** Stops the poll in flight when the key changes under it. */
  private pollAbort: AbortController | null = null
  private running: Promise<void> | null = null
  /** Whether `running` is a manual poll, which also asks accounts resting after a 401 or 403. */
  private runningManual = false
  /** A poll waiting for `running` to end; callers arriving meanwhile share it. */
  private next: Promise<void> | null = null
  /** Whether `next` is to be manual: a caller asked for that while `running` was not. */
  private nextManual = false
  private cancelTimer: (() => void) | null = null
  /** Rises with every schedule(), so a schedule that awaited settings can tell it was superseded. */
  private timerGeneration = 0
  private settingsSubscription: { dispose(): void } | null = null
  private readonly keys: KeyStore
  private readonly abort = new AbortController()
  private stopped = false

  constructor(
    private readonly orca: OrcaWorkerApi,
    private readonly fetch: FetchLike,
    private readonly clock: Clock = systemClock
  ) {
    this.keys = new KeyStore(orca.secrets)
  }

  /**
   * Starts working: follows settings changes from now on, deletes the usage counts version 0.1
   * stored (they mean nothing to the quota view), then starts the first poll without waiting for
   * it. Never rejects.
   */
  async start(): Promise<void> {
    this.settingsSubscription = this.orca.settings.onDidChange(() => void this.refresh({ fresh: true }))
    try {
      if ((await this.orca.storage.keys()).includes(LEGACY_STORE_KEY)) await this.orca.storage.delete(LEGACY_STORE_KEY)
    } catch (error) {
      this.orca.log(`could not delete the old usage counts: ${message(error)}`)
    }
    void this.refresh()
  }

  /**
   * Polls, tells the status bar and open panels, then schedules the next poll. A caller arriving
   * while a poll runs shares it, unless that poll does not do what it asks: with `fresh` (after a
   * new key or settings) it gets a poll that starts after the running one ends and so reads the
   * new configuration; `manual` (the person asked) also asks accounts resting after an upstream
   * 401 or 403, so a manual caller arriving during another poll gets one more, manual, poll after
   * it. Such callers share that one poll. Never rejects.
   */
  refresh(options: { fresh?: boolean; manual?: boolean } = {}): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const manual = options.manual === true
    if (!this.running) return this.startPoll(manual)
    if (!options.fresh && !(manual && !this.runningManual)) return this.running
    this.nextManual ||= manual
    this.next ??= this.running.then(() => {
      const nextManual = this.nextManual
      this.next = null
      this.nextManual = false
      return this.refresh({ manual: nextManual })
    })
    return this.next
  }

  /**
   * Stores `key` for the origin of the configured URL and starts a poll with it, without waiting
   * for that poll. Rejects with `invalid_params` for a missing URL or a malformed key.
   */
  async saveKey(key: string): Promise<void> {
    const { baseUrl, urlError } = await this.settings()
    if (!baseUrl) throw invalid(urlError ?? MESSAGES.setUrlFirst)
    await this.keys.save(new URL(baseUrl).origin, key)
    this.restart('connecting', null)
  }

  /** Forgets the stored key and everything read with it. */
  async clearKey(): Promise<void> {
    await this.keys.clear()
    this.restart('unconfigured', MESSAGES.enterKey)
  }

  /** The state for the panel, within `STATE_BUDGET_BYTES`. */
  async state(): Promise<QuotaState> {
    const settings = await this.settings()
    const origin = settings.baseUrl ? new URL(settings.baseUrl).origin : null
    return fitState({
      baseUrl: settings.baseUrl,
      hasKey: origin !== null && (await this.keys.read())?.origin === origin,
      ...this.overview(),
      polling: this.running !== null,
      apiVersion: this.client?.version ?? null,
      pollSeconds: settings.pollSeconds
    })
  }

  /** One line per account with its windows and resets, for the quota command. */
  summary(): string {
    return summaryText(this.overview(), this.clock.now())
  }

  /** Cancels the timer and the requests in flight, and waits for the running poll to end. */
  async stop(): Promise<void> {
    this.stopped = true
    this.timerGeneration += 1
    this.settingsSubscription?.dispose()
    this.cancelTimer?.()
    this.cancelTimer = null
    this.abort.abort()
    await (this.next ?? this.running)
  }

  private overview(): Overview {
    return { status: this.status, accounts: this.accounts, omitted: this.omitted, lastPollAt: this.lastPollAt }
  }

  /** The key changed: drop what the old one read, say so at once, and poll with the new one. */
  private restart(kind: StatusKind, text: string | null): void {
    this.pollAbort?.abort(new Error('The management key changed.'))
    this.forgetServer()
    this.setStatus(kind, text)
    void this.publish()
    void this.refresh({ fresh: true })
  }

  private startPoll(manual: boolean): Promise<void> {
    this.runningManual = manual
    const run = this.pollOnce(manual)
      .catch((error: unknown) => this.orca.log(`poll error: ${message(error)}`))
      .then(() => {
        this.running = null
        return this.publish()
      })
      .finally(() => void this.schedule())
    this.running = run
    return run
  }

  private async schedule(): Promise<void> {
    const generation = ++this.timerGeneration
    this.cancelTimer?.()
    this.cancelTimer = null
    const { pollSeconds } = await this.settings()
    if (this.stopped || generation !== this.timerGeneration) return
    this.cancelTimer = this.clock.after(pollSeconds * 1000, () => {
      this.cancelTimer = null
      void this.refresh()
    })
  }

  private async pollOnce(manual: boolean): Promise<void> {
    const settings = await this.settings()
    const stored = await this.keys.read()
    const origin = settings.baseUrl ? new URL(settings.baseUrl).origin : null
    // What was read belongs to one URL and key; any other, or none, starts from nothing.
    const key = stored?.origin === origin ? stored.key : null
    if (!settings.baseUrl || key === null || !this.client?.matches(settings.baseUrl, key)) this.forgetServer()
    if (!settings.baseUrl || origin === null) return this.setStatus('unconfigured', settings.urlError)
    if (!stored || stored.origin !== origin) {
      return this.setStatus('unconfigured', stored ? MESSAGES.keyForOtherOrigin(stored.origin, origin) : MESSAGES.enterKey)
    }
    if (stored.refused) return this.setStatus('auth', MESSAGES.keyRefused)
    if (this.ban && this.ban.origin === origin && this.clock.now() < this.ban.until) {
      return this.setStatus('error', MESSAGES.pausedUntil(this.ban.reason, this.ban.until, this.clock.now()))
    }
    this.client ??= new CpaClient(settings.baseUrl, stored.key, this.fetch)
    const client = this.client
    const pollAbort = new AbortController()
    this.pollAbort = pollAbort
    const signal = AbortSignal.any([this.abort.signal, pollAbort.signal])
    const deadlineMs = pollDeadlineMs(settings.pollSeconds)
    const listingAbort = new AbortController()
    let pastDeadline = false
    const cancelDeadline = this.clock.after(deadlineMs, () => {
      pastDeadline = true
      listingAbort.abort(new ClientError(MESSAGES.pollTooSlow(deadlineMs)))
    })
    try {
      const { accounts, omitted } = await client.listAccounts(AbortSignal.any([signal, listingAbort.signal]))
      const fatal = await this.readAccounts(client, accounts, signal, manual, () => pastDeadline)
      if (this.client !== client) return
      this.omitted = omitted
      if (fatal) throw fatal.error
      this.setStatus('ok', null)
    } catch (error) {
      if (!this.stopped) await this.fail(error, stored, client)
    } finally {
      cancelDeadline()
      if (this.pollAbort === pollAbort) this.pollAbort = null
      if (this.client === client && !this.stopped) this.lastPollAt = this.clock.now()
    }
  }

  /** The poll with `client` and `used` failed as a whole: remember a ban or refusal, and say so. */
  private async fail(error: unknown, used: StoredKey, client: CpaClient): Promise<void> {
    const failure = error instanceof ClientError ? error : new ClientError(message(error))
    // A ban is of this computer's IP, whichever key was sent.
    if (failure.pause.kind === 'banned') {
      const until = this.clock.now() + failure.pause.retryAfterMs
      this.ban = { origin: new URL(client.baseUrl).origin, until, reason: failure.message }
      if (this.client === client) this.setStatus('error', MESSAGES.pausedUntil(failure.message, until, this.clock.now()))
      return
    }
    if (failure.pause.kind === 'key-refused') return this.refuse(used, client)
    if (this.client !== client) return
    this.orca.log(`poll failed: ${failure.message}`)
    this.setStatus('error', failure.message)
  }

  /**
   * Reads every account that is `readable` and not resting, `CONCURRENCY` at a time, the longest
   * unread first, until `pastDeadline()`; then rebuilds the account views in the server's order.
   * A failure of one account stays on that account; a failure that concerns every account (the
   * key refused, a ban, the poll stopped) stops the other reads and is handed back. What was read
   * is kept either way, rests included, unless `client` was replaced meanwhile: then these
   * accounts belong to a key no longer in use, and nothing changes.
   */
  private async readAccounts(
    client: CpaClient,
    listed: Account[],
    signal: AbortSignal,
    manual: boolean,
    pastDeadline: () => boolean
  ): Promise<{ error: unknown } | null> {
    // Copies, so a poll that is overtaken leaves `this.memory` as it was.
    const memory = new Map<string, Memory>()
    for (const account of listed) {
      memory.set(account.id, { ...(this.memory.get(account.id) ?? blankMemory()), missed: false })
    }
    const now = this.clock.now()
    const due = listed
      .filter((account) => classify(account) === 'readable' && !resting(memory.get(account.id)!, now, manual))
      .sort((a, b) => (memory.get(a.id)!.readAt ?? -Infinity) - (memory.get(b.id)!.readAt ?? -Infinity))
    const stopReads = new AbortController()
    const lanesSignal = AbortSignal.any([signal, stopReads.signal])
    let fatal: { error: unknown } | null = null
    const lane = async () => {
      while (!fatal && !pastDeadline()) {
        const account = due.shift()
        if (!account) return
        const remembered = memory.get(account.id)!
        const authIndex = account.authIndex!
        try {
          const result = await readQuota(account, (request) => client.apiCall(authIndex, request, lanesSignal), {
            now: this.clock.now(),
            plan: remembered.plan
          })
          this.remember(remembered, account, result)
        } catch (error) {
          remembered.missed = true
          fatal ??= { error }
          stopReads.abort()
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, lane))
    for (const account of due) memory.get(account.id)!.missed = true
    if (this.client !== client) return fatal
    this.memory = memory
    this.accounts = listed.map((account) => view(account, memory.get(account.id)!))
    return fatal
  }

  private remember(memory: Memory, account: Account, result: QuotaResult): void {
    const now = this.clock.now()
    memory.readAt = now
    memory.rest = result.rest ? { until: now + REST_MS[result.rest], reason: result.rest } : null
    const name = `${providerName(account.provider)} account ${account.id.slice(0, 40)}`
    const restText = memory.rest ? MESSAGES.restsUntil(memory.rest.reason, memory.rest.until, now) : ''
    if (result.ok) {
      Object.assign(memory, { plan: result.plan, windows: result.windows, notes: result.notes, error: null, updatedAt: now })
      if (memory.rest) this.orca.log(`${name}: the plan lookup was rate-limited. ${restText}`)
      return
    }
    memory.error = memory.rest ? `${result.error} ${restText}` : result.error
    this.orca.log(`${name}: ${memory.error}`)
  }

  /**
   * The server refused `used`. The key store counts it refused at once, even if storing that
   * fails; the status says so unless a newer key replaced it meanwhile.
   */
  private async refuse(used: StoredKey, client: CpaClient): Promise<void> {
    let current = true
    try {
      current = await this.keys.markRefused(used)
    } catch (error) {
      this.orca.log(`could not store that the key was refused: ${message(error)}`)
    }
    if (current && this.client === client) this.setStatus('auth', MESSAGES.keyRefused)
  }

  /** Drops everything learnt from the previous server or key. */
  private forgetServer(): void {
    this.client = null
    this.accounts = []
    this.omitted = 0
    this.lastPollAt = null
    this.memory = new Map()
  }

  /** Updates the status bar, then posts the state to open panels. Never rejects. */
  private async publish(): Promise<void> {
    if (this.stopped) return
    if (this.orca.host.has('statusBar.update')) {
      try {
        const item = statusBarItem(this.overview(), this.clock.now())
        await this.orca.host.call('statusBar.update', { id: 'usage', icon: 'gauge', ...item })
      } catch (error) {
        this.orca.log(`status bar update failed: ${message(error)}`)
      }
    }
    try {
      this.orca.panels.post('cpa.changed', await this.state())
    } catch (error) {
      this.orca.log(`posting to the panels failed: ${message(error)}`)
    }
  }

  private setStatus(kind: StatusKind, text: string | null): void {
    this.status = { kind, message: text }
  }

  private async settings(): Promise<Settings> {
    const values = await this.orca.settings.get()
    let baseUrl: string | null = null
    let urlError: string | null = null
    try {
      baseUrl = normalizeBaseUrl(values.baseUrl)
    } catch (error) {
      urlError = message(error)
    }
    return { baseUrl, urlError, pollSeconds: clamp(values.pollSeconds, POLL.default, POLL.min, POLL.max) }
  }
}

const blankMemory = (): Memory => ({
  plan: undefined,
  windows: [],
  notes: [],
  error: null,
  updatedAt: null,
  rest: null,
  readAt: null,
  missed: false
})

function resting(memory: Memory, now: number, manual: boolean): boolean {
  if (!memory.rest || memory.rest.until <= now) return false
  return !(manual && memory.rest.reason === 'refused')
}

function view(account: Account, memory: Memory): AccountView {
  const base = {
    id: account.id,
    provider: providerName(account.provider),
    title: account.email ?? account.label ?? account.name,
    plan: memory.plan ?? null
  }
  const empty = { windows: [], notes: [], error: null, updatedAt: null, missed: false }
  switch (classify(account)) {
    case 'disabled':
      return { ...base, kind: 'disabled', ...empty }
    case 'unsupported':
      return { ...base, kind: 'unsupported', ...empty }
    case 'no-auth-index':
      return { ...base, kind: 'quota', ...empty, error: MESSAGES.noAuthIndex }
    case 'readable':
      return {
        ...base,
        kind: 'quota',
        windows: memory.windows,
        notes: memory.notes,
        error: memory.error,
        updatedAt: memory.updatedAt,
        missed: memory.missed
      }
  }
}
