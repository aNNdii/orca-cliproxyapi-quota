// The collector owns everything that changes over time: the poll timer, the poll in flight, what
// is known about the server and key (refused, banned), the counted usage, and telling the status
// bar and open panels. src/worker.ts only connects Orca's handlers to it.
import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import { ClientError, CpaClient, type FetchLike, normalizeBaseUrl } from './client'
import type { StatusKind, StatusTone, UsageState } from './protocol'
import { allViews, compact, emptyStore, ingest, readStore, STORE_KEY, type UsageStore, viewFor } from './usage'

/**
 * Secret holding the key as JSON `{ origin, key, refused? }`. The key is only ever sent to the
 * origin (scheme, host and port) it was saved for; `refused: true` marks a key the server refused,
 * so it is not sent again, not even after a restart, until a key is saved anew.
 */
export const KEY_SECRET = 'managementKey'

const PAGE_SIZE = 500
/** Pages per poll; whatever is left waits for the next poll. */
const MAX_PAGES = 20
const DEFAULTS = { pollSeconds: 15, retentionDays: 31 }

const MESSAGES = {
  enterKey: 'Enter the CLIProxyAPI management key in the panel.',
  keyRefused:
    'The server refused the management key. Polling is paused until you save a key again (CLIProxyAPI bans an IP for about 30 minutes after 5 failed attempts).'
}

const STATUS: Record<StatusKind, { tone: StatusTone; label: string }> = {
  unconfigured: { tone: 'neutral', label: 'not set up' },
  ok: { tone: 'success', label: 'connected' },
  auth: { tone: 'danger', label: 'key refused' },
  error: { tone: 'warning', label: 'error' }
}

type Settings = { baseUrl: string | null; urlError: string | null; pollSeconds: number; retentionDays: number }
type Credentials = { origin: string; key: string; refused?: true }

const clamp = (value: JsonValue | undefined, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const invalid = (text: string) => Object.assign(new Error(text), { code: 'invalid_params' })

export class Collector {
  private status: UsageState['status'] = { kind: 'unconfigured', ...STATUS.unconfigured, message: null }
  private lastPollAt: number | null = null
  /** Reused while URL and key stay the same, so the API version it found stays cached. */
  private client: CpaClient | null = null
  /** The server banned this computer's IP: nothing goes to `origin` before `until` (epoch ms). */
  private ban: { origin: string; until: number } | null = null
  private running: Promise<void> | null = null
  /** A fresh poll waiting for `running` to end; fresh callers arriving meanwhile share it. */
  private next: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Rises with every schedule(), so a schedule that awaited settings can tell it was superseded. */
  private timerGeneration = 0
  /** Secret writes run one after another, so marking a key refused never overwrites a newer key. */
  private secretWrites: Promise<unknown> = Promise.resolve()
  private readonly abort = new AbortController()
  private stopped = false

  private constructor(
    private readonly orca: OrcaWorkerApi,
    private readonly fetch: FetchLike,
    private store: UsageStore
  ) {}

  static async open(orca: OrcaWorkerApi, fetch: FetchLike): Promise<Collector> {
    return new Collector(orca, fetch, readStore(await orca.storage.get(STORE_KEY)))
  }

  /**
   * Polls, tells the status bar and open panels, then schedules the next poll. Without `fresh`, a
   * caller arriving while a poll runs shares it; with `fresh` (after a new key or settings) it gets
   * a poll that starts after the running one ends and so reads the new configuration. Never rejects.
   */
  refresh(options: { fresh?: boolean } = {}): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (!this.running) return this.start()
    if (!options.fresh) return this.running
    this.next ??= this.running.then(() => {
      this.next = null
      return this.refresh()
    })
    return this.next
  }

  /** The plugin settings changed: poll with them now and reschedule with the new interval. */
  reconfigure(): Promise<void> {
    return this.refresh({ fresh: true })
  }

  /** Stores `key` for the origin of the configured URL and polls with it. Rejects with `invalid_params`. */
  async saveKey(key: string): Promise<void> {
    const { baseUrl, urlError } = await this.settings()
    if (!baseUrl) throw invalid(urlError ?? 'Set the CLIProxyAPI URL first.')
    const trimmed = key.trim()
    if (!trimmed) throw invalid('The management key is empty.')
    const credentials: Credentials = { origin: new URL(baseUrl).origin, key: trimmed }
    await this.serially(() => this.orca.secrets.set(KEY_SECRET, JSON.stringify(credentials)))
    await this.refresh({ fresh: true })
  }

  async clearKey(): Promise<void> {
    await this.serially(() => this.orca.secrets.delete(KEY_SECRET))
    this.client = null
    await this.refresh({ fresh: true })
  }

  /** Deletes the counted usage and starts counting anew. */
  async reset(): Promise<void> {
    this.store = emptyStore()
    await this.orca.storage.set(STORE_KEY, this.store as unknown as JsonValue)
    await this.publish()
  }

  async state(): Promise<UsageState> {
    const settings = await this.settings()
    const origin = settings.baseUrl ? new URL(settings.baseUrl).origin : null
    return {
      baseUrl: settings.baseUrl,
      hasKey: origin !== null && (await this.storedCredentials())?.origin === origin,
      status: this.status,
      lastPollAt: this.lastPollAt,
      trackingSince: this.store.since,
      apiVersion: this.client?.version ?? null,
      statisticsEnabled: this.client?.statisticsEnabled ?? null,
      retentionDays: settings.retentionDays,
      views: allViews(this.store, Date.now())
    }
  }

  /** Today's usage as a few lines of text, for the status bar tooltip and the summary command. */
  summary(): string {
    const today = viewFor(this.store, Date.now(), 'today')
    const { totals } = today
    const lines = [
      `CLIProxyAPI today: ${totals.requests} requests (${totals.failed} failed), ${compact(totals.total)} tokens`,
      `in ${compact(totals.input)} · out ${compact(totals.output)} · cached ${compact(totals.cached)} · reasoning ${compact(totals.reasoning)}`
    ]
    const top = today.models[0]
    if (top) lines.push(`Top model: ${top.key} (${compact(top.totals.total)} tokens)`)
    if (this.status.kind !== 'ok' && this.status.message) lines.push(this.status.message)
    return lines.join('\n')
  }

  /** Cancels the timer and the requests in flight, and waits for the running poll to end. */
  async stop(): Promise<void> {
    this.stopped = true
    this.timerGeneration += 1
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.abort.abort()
    await (this.next ?? this.running)
  }

  private start(): Promise<void> {
    const run = this.pollOnce()
      .then(() => this.publish())
      .catch((error: unknown) => this.orca.log(`poll error: ${message(error)}`))
      .finally(() => {
        this.running = null
        void this.schedule()
      })
    this.running = run
    return run
  }

  private async schedule(): Promise<void> {
    const generation = ++this.timerGeneration
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const { pollSeconds } = await this.settings()
    if (this.stopped || generation !== this.timerGeneration) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh()
    }, pollSeconds * 1000)
  }

  private async pollOnce(): Promise<void> {
    const settings = await this.settings()
    if (!settings.baseUrl) return this.setStatus('unconfigured', settings.urlError)
    const origin = new URL(settings.baseUrl).origin
    const credentials = await this.storedCredentials()
    if (!credentials || credentials.origin !== origin) {
      return this.setStatus(
        'unconfigured',
        credentials
          ? `The stored key is for ${credentials.origin}. Enter the management key for ${origin}.`
          : MESSAGES.enterKey
      )
    }
    if (credentials.refused) return this.setStatus('auth', MESSAGES.keyRefused)
    if (this.ban && this.ban.origin === origin && Date.now() < this.ban.until) return
    if (!this.client?.matches(settings.baseUrl, credentials.key)) {
      this.client = new CpaClient(settings.baseUrl, credentials.key, this.fetch)
    }
    const client = this.client
    try {
      for (let page = 0; page < MAX_PAGES && !this.stopped; page++) {
        const records = await client.pop(PAGE_SIZE, this.abort.signal)
        // Saved before asking for the next page: the server has already dropped these records.
        if (ingest(this.store, records, Date.now(), settings.retentionDays)) {
          await this.orca.storage.set(STORE_KEY, this.store as unknown as JsonValue)
        }
        if (records.length < PAGE_SIZE) break
      }
      this.setStatus('ok', null)
    } catch (error) {
      if (this.stopped) return
      const failure = error instanceof ClientError ? error : new ClientError(message(error))
      this.orca.log(`poll failed: ${failure.message}`)
      if (failure.pause === 'until-key-changes') {
        // A key saved while this poll ran is not the one refused; its own poll follows.
        if (await this.markRefused(credentials)) this.setStatus('auth', MESSAGES.keyRefused)
        return
      }
      if (failure.pause === 'until-time' && failure.retryAt !== null) this.ban = { origin, until: failure.retryAt }
      this.setStatus('error', failure.message)
    } finally {
      this.lastPollAt = Date.now()
    }
  }

  private async publish(): Promise<void> {
    if (this.stopped) return
    this.orca.panels.post('cpa.changed', await this.state())
    if (!this.orca.host.has('statusBar.update')) return
    const today = viewFor(this.store, Date.now(), 'today').totals
    const unconfigured = this.status.kind === 'unconfigured'
    try {
      await this.orca.host.call('statusBar.update', {
        id: 'usage',
        icon: 'gauge',
        text: unconfigured ? 'CPA: set up' : `CPA ${compact(today.total)}`,
        // Green would mark every healthy poll; the status bar only draws attention to problems.
        tone: this.status.kind === 'ok' ? 'neutral' : this.status.tone,
        tooltip: unconfigured ? `CLIProxyAPI usage: ${this.status.message ?? MESSAGES.enterKey}` : this.summary()
      })
    } catch (error) {
      this.orca.log(`status bar update failed: ${message(error)}`)
    }
  }

  private setStatus(kind: StatusKind, text: string | null): void {
    this.status = { kind, ...STATUS[kind], message: text }
  }

  private serially<T>(write: () => Promise<T>): Promise<T> {
    const result = this.secretWrites.then(write)
    this.secretWrites = result.catch(() => undefined)
    return result
  }

  /** Marks `used` refused if it is still the stored key; returns whether it was. */
  private markRefused(used: Credentials): Promise<boolean> {
    return this.serially(async () => {
      const stored = await this.storedCredentials()
      if (!stored || stored.origin !== used.origin || stored.key !== used.key) return false
      const refused: Credentials = { origin: stored.origin, key: stored.key, refused: true }
      await this.orca.secrets.set(KEY_SECRET, JSON.stringify(refused))
      return true
    })
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
    return {
      baseUrl,
      urlError,
      pollSeconds: clamp(values.pollSeconds, DEFAULTS.pollSeconds, 5, 300),
      retentionDays: clamp(values.retentionDays, DEFAULTS.retentionDays, 1, 366)
    }
  }

  /** The stored key; null when none is stored or the secret is not in the `{ origin, key }` form. */
  private async storedCredentials(): Promise<Credentials | null> {
    const raw = await this.orca.secrets.get(KEY_SECRET)
    if (!raw) return null
    try {
      const value = JSON.parse(raw) as Partial<Credentials> | null
      if (!value || typeof value.origin !== 'string' || typeof value.key !== 'string' || !value.key) return null
      return value.refused === true
        ? { origin: value.origin, key: value.key, refused: true }
        : { origin: value.origin, key: value.key }
    } catch {
      return null
    }
  }
}
