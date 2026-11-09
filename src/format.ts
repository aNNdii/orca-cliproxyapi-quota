// How quota numbers, the connection status and the worker's messages read, the same in the panel,
// the status bar, its tooltip and the summary command. Pure functions of the state the worker
// publishes, plus the wording the worker publishes in it.
import { BAN_ATTEMPTS, BAN_MS } from './client'
import type { AccountView, QuotaState, StatusKind } from './protocol'
import type { Rest, Window } from './providers'

export type QuotaTone = 'neutral' | 'warning' | 'danger'
export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger'

/** At or above this percent used a window shows as a warning. */
export const WARNING_PERCENT = 80
/** At or above this percent used (or when its limit is reached) a window shows as danger. */
export const DANGER_PERCENT = 95
/** Orca's limits for a status bar item's text and tooltip, in characters. */
export const STATUS_TEXT_CHARS = 64
export const TOOLTIP_CHARS = 256

/**
 * How each status reads: the panel's badge (`label`, `tone`), the tone of the status message in
 * the panel, and the status bar item while it lasts. `ok` has no status bar text of its own: the
 * status bar shows the tightest window then.
 */
export const STATUS: Readonly<
  Record<StatusKind, { label: string; tone: StatusTone; messageTone: 'warning' | 'danger'; bar: { text: string; tone: QuotaTone } | null }>
> = {
  unconfigured: { label: 'not set up', tone: 'neutral', messageTone: 'warning', bar: { text: 'CPA: set up', tone: 'neutral' } },
  connecting: { label: 'connecting', tone: 'neutral', messageTone: 'warning', bar: { text: 'CPA: connecting', tone: 'neutral' } },
  ok: { label: 'connected', tone: 'success', messageTone: 'warning', bar: null },
  auth: { label: 'key refused', tone: 'danger', messageTone: 'danger', bar: { text: 'CPA: key refused', tone: 'danger' } },
  error: { label: 'error', tone: 'warning', messageTone: 'warning', bar: { text: 'CPA: error', tone: 'warning' } }
}

/** The worker's own messages: status messages and the notes it adds to an account. */
export const MESSAGES = {
  enterKey: 'Enter the CLIProxyAPI management key in the panel.',
  setUrlFirst: 'Set the CLIProxyAPI URL first.',
  keyRefused: `The server refused the management key. Polling is paused until you save a key again: CLIProxyAPI bans an IP for ${BAN_MS / 60_000} minutes after ${BAN_ATTEMPTS} failed attempts.`,
  noAuthIndex: 'CLIProxyAPI listed this account without an auth index, so its quota cannot be read.',
  keyForOtherOrigin: (stored: string, origin: string) =>
    `The stored key is for ${stored}. Enter the management key for ${origin}.`,
  /** `reason` is a whole sentence, e.g. the server's ban. */
  pausedUntil: (reason: string, until: number, now: number) => `${reason} Polling resumes at ${formatReset(until, now)}.`,
  pollTooSlow: (ms: number) => `The poll took longer than ${ms / 1000} s and was stopped; the next poll starts over.`,
  /** When a resting account is asked again; a manual refresh asks one that the provider refused. */
  restsUntil: (reason: Rest, until: number, now: number) =>
    reason === 'refused' ? `Asked again at ${formatReset(until, now)}, or on Refresh.` : `Asked again at ${formatReset(until, now)}.`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (value: number) => String(value).padStart(2, '0')

/**
 * A reset time in the local time zone, as short as stays unambiguous: `14:20` later today,
 * `Mon 14:20` within the next six days, `12 Nov 14:20` beyond that (or when it already passed).
 */
export function formatReset(at: number, now: number): string {
  const date = new Date(at)
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const today = new Date(now)
  const sameDay = date.toDateString() === today.toDateString()
  if (sameDay && at >= now) return time
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (at >= now && at < startOfToday + 7 * 86_400_000) return `${WEEKDAYS[date.getDay()]} ${time}`
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${time}`
}

/**
 * Whole percent, e.g. `62%`. Only a full window reads `100%` (99.9 reads `99%`), and only an
 * unused one `0%` (0.4 reads `<1%`).
 */
export function formatPercent(used: number): string {
  if (used > 0 && used < 1) return '<1%'
  return used < 100 ? `${Math.min(99, Math.round(used))}%` : '100%'
}

export function windowTone(window: Window): QuotaTone {
  if (window.limitReached || window.usedPercent >= DANGER_PERCENT) return 'danger'
  return window.usedPercent >= WARNING_PERCENT ? 'warning' : 'neutral'
}

/** `resets 14:20`, or `reset 9 Nov 08:00` for a time already passed (the numbers predate it). */
export function resetText(at: number, now: number): string {
  return `${at > now ? 'resets' : 'reset'} ${formatReset(at, now)}`
}

/** `5h 62% · resets 14:20`, or without the reset when the provider did not say. */
function describeWindow(window: Window, now: number): string {
  const reset = window.resetsAt === null ? '' : ` · ${resetText(window.resetsAt, now)}`
  return `${window.label} ${formatPercent(window.usedPercent)}${window.limitReached ? ' (limit reached)' : ''}${reset}`
}

const TONE_RANK: Record<QuotaTone, number> = { neutral: 0, warning: 1, danger: 2 }

/** The fullest window across enabled accounts that has not reset yet; ties go to the earliest reset. */
function tightestWindow(accounts: readonly AccountView[], now: number): { account: AccountView; window: Window } | null {
  let best: { account: AccountView; window: Window } | null = null
  for (const account of accounts) {
    if (account.kind !== 'quota') continue
    for (const window of account.windows) {
      if (window.resetsAt !== null && window.resetsAt <= now) continue
      if (!best || tighter(window, best.window)) best = { account, window }
    }
  }
  return best
}

function tighter(a: Window, b: Window): boolean {
  const rank = TONE_RANK[windowTone(a)] - TONE_RANK[windowTone(b)]
  if (rank !== 0) return rank > 0
  if (a.usedPercent !== b.usedPercent) return a.usedPercent > b.usedPercent
  return (a.resetsAt ?? Infinity) < (b.resetsAt ?? Infinity)
}

/** What the status bar, its tooltip and the summary read from the published state. */
export type Overview = Pick<QuotaState, 'status' | 'accounts' | 'omitted' | 'lastPollAt'>

/**
 * The status bar item. While the status is `ok`: the tightest window, e.g. `Claude 5h 62% · 14:20`,
 * toned by that window alone (green would mark every healthy poll, so there is none). Otherwise
 * the status (`STATUS`), e.g. `CPA: key refused`, never numbers that may be stale.
 */
export function statusBarItem(overview: Overview, now: number): { text: string; tone: QuotaTone; tooltip: string } {
  const tooltip = statusTooltip(overview)
  const bar = STATUS[overview.status.kind].bar
  if (bar) return { ...bar, tooltip }
  const tight = tightestWindow(overview.accounts, now)
  if (!tight) return { text: 'CPA quota', tone: 'neutral', tooltip }
  const { account, window } = tight
  const reset = window.resetsAt === null ? '' : ` · ${formatReset(window.resetsAt, now)}`
  const text = `${account.provider} ${window.label} ${formatPercent(window.usedPercent)}${reset}`
  return { text: shorten(text, STATUS_TEXT_CHARS), tone: windowTone(window), tooltip }
}

/**
 * The status bar tooltip: the status message when there is a problem, then one short line per
 * account with its windows' percent used, as many as fit in `TOOLTIP_CHARS`, then how many more
 * the panel shows.
 */
function statusTooltip({ status, accounts, omitted, lastPollAt }: Overview): string {
  const lines: string[] = []
  if (status.kind !== 'ok' && status.message) lines.push(shorten(`CLIProxyAPI quota: ${status.message}`, 120))
  if (accounts.length === 0 && lines.length === 0) {
    lines.push(lastPollAt ? 'No accounts on the server.' : 'CLIProxyAPI quota: not read yet.')
  }
  const total = accounts.length + omitted
  const more = (shown: number) => `+${total - shown} more in the panel`
  // The first line needs no line break before it; counting one anyway keeps this simple.
  let length = lines.join('\n').length
  let shown = 0
  for (const account of accounts) {
    const line = shorten(`${account.provider} ${shorten(account.title, 24)}: ${accountBrief(account)}`, 90)
    const reserve = shown + 1 < total ? 1 + more(shown + 1).length : 0
    if (length + 1 + line.length + reserve > TOOLTIP_CHARS) break
    lines.push(line)
    length += 1 + line.length
    shown += 1
  }
  if (shown < total) lines.push(more(shown))
  return lines.join('\n')
}

/** One line per account with its windows and resets, for the quota command. */
export function summaryText({ status, accounts, omitted, lastPollAt }: Overview, now: number): string {
  const lines = ['CLIProxyAPI quota']
  if (status.kind !== 'ok' && status.message) lines.push(status.message)
  for (const account of accounts) lines.push(`${accountName(account)}: ${accountLine(account, now)}`)
  if (omitted > 0) lines.push(`${omitted} more accounts not shown`)
  if (lines.length === 1) lines.push(lastPollAt ? 'No accounts on the server.' : 'Not read yet.')
  return lines.join('\n')
}

const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** `5h 62%, 7d 31%`, or a word for an account without windows. */
function accountBrief(account: AccountView): string {
  if (account.kind === 'disabled') return 'disabled'
  if (account.kind === 'unsupported') return 'quota not available'
  const windows = account.windows.map((window) => `${window.label} ${formatPercent(window.usedPercent)}`).join(', ')
  if (account.missed) return `${windows || 'not read yet'} (not read this poll)`
  if (!account.error) return windows || 'not read yet'
  return windows ? `${windows} (stale)` : 'read failed'
}

const accountName = (account: AccountView) =>
  `${account.provider} ${account.title}${account.plan ? ` (${account.plan})` : ''}`

function accountLine(account: AccountView, now: number): string {
  if (account.kind === 'disabled') return 'disabled'
  if (account.kind === 'unsupported') return 'quota not available'
  const windows = account.windows.map((window) => describeWindow(window, now)).join(', ')
  if (account.missed) return `${windows || 'not read yet'} (not read this poll)`
  if (!account.error) return windows || 'not read yet'
  const error = shorten(account.error, 160)
  return windows ? `${windows} (last read failed: ${error})` : error
}
