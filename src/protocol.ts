// The panel <-> worker contract, declared once: src/panel.tsx and src/collector.ts both read it.
// How a status reads (its label and tone) is src/format.ts's business, not part of the contract.
import type { ApiVersion } from './client'
import type { Window } from './providers'

/**
 * - `unconfigured`: no valid URL, or no key saved for this server's origin; nothing is sent.
 * - `connecting`: a key was just saved; the first poll with it is running.
 * - `ok`: the last poll read the server. Failures of single accounts leave the status `ok` and
 *   show on the account.
 * - `auth`: the server refused the key; nothing is sent until a key is saved again.
 * - `error`: the last poll failed as a whole; the next one retries (after an IP ban, once the ban
 *   ends).
 */
export type StatusKind = 'unconfigured' | 'connecting' | 'ok' | 'auth' | 'error'

/**
 * - `quota`: an enabled account of a provider whose quota this plugin reads.
 * - `disabled`: disabled in CLIProxyAPI; not queried.
 * - `unsupported`: a provider without a quota this plugin can read (Gemini CLI, Vertex, ...); not queried.
 */
export type AccountKind = 'quota' | 'disabled' | 'unsupported'

export type AccountView = {
  /** Stable while the server keeps the account. */
  id: string
  kind: AccountKind
  /** Display name of the provider, e.g. `Claude`. */
  provider: string
  /** E-mail, label or credential name, whichever the server gave first. */
  title: string
  /** e.g. `Max 5x`, `Plus`; null when unknown. */
  plan: string | null
  /** From the last successful read; kept while later reads fail or miss. Empty for other kinds. */
  windows: Window[]
  notes: string[]
  /** Why the last read failed; null after a success and for other kinds. */
  error: string | null
  /** When the last successful read finished (epoch ms); null before one. */
  updatedAt: number | null
  /**
   * The last poll was due to read this account but stopped first (it reached its deadline, or
   * failed as a whole); everything else here is from an earlier read. The next poll reads it first.
   */
  missed: boolean
}

export type QuotaState = {
  /** The URL the worker polls, after normalizing; null while the setting is not a valid URL. */
  baseUrl: string | null
  /** Whether a key is stored for this server's origin. The key itself never leaves the worker. */
  hasKey: boolean
  status: { kind: StatusKind; message: string | null }
  /**
   * When the last poll that sent requests with the current URL and key ended, successful or not
   * (epoch ms). Null before such a poll, and again after the key or the server changed. Polls that
   * sent nothing (no key, a refused key, a ban) leave it as it is.
   */
  lastPollAt: number | null
  /** A poll is running; `cpa.changed` follows when it ends. */
  polling: boolean
  apiVersion: ApiVersion | null
  /** Seconds between polls (60 to 3600). */
  pollSeconds: number
  /** In the server's order; empty until the first successful poll of this server. */
  accounts: AccountView[]
  /** Accounts the server listed beyond the ones shown. */
  omitted: number
}

/**
 * The most a published state may take as JSON, in UTF-8 bytes: well below the 256 KiB Orca allows
 * a panel post, so it is never dropped. Answers to requests (1 MiB) keep the same size.
 */
export const STATE_BUDGET_BYTES = 200 * 1024
/** Text lengths, in characters, a state over budget is cut to before accounts are dropped. */
const BRIEF = { title: 64, label: 40, error: 160, note: 80 }

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * `state` within `STATE_BUDGET_BYTES`: as it is when it fits; otherwise with every account's text
 * cut short, and then with as many accounts from the end dropped as needed, counted in `omitted`
 * (the panel says how many more there are).
 */
export function fitState(state: QuotaState, budget = STATE_BUDGET_BYTES): QuotaState {
  if (bytes(state) <= budget) return state
  const accounts = state.accounts.map(brief)
  // The `omitted` count may gain digits; 16 bytes leave room for that.
  let size = bytes({ ...state, accounts: [] }) + 16
  let kept = 0
  for (const account of accounts) {
    const next = bytes(account) + 1
    if (size + next > budget) break
    size += next
    kept += 1
  }
  return { ...state, accounts: accounts.slice(0, kept), omitted: state.omitted + accounts.length - kept }
}

function brief(account: AccountView): AccountView {
  const seen = new Set<string>()
  const windows = account.windows.map((window) => {
    let label = shorten(window.label, BRIEF.label)
    for (let count = 2; seen.has(label); count++) label = `${shorten(window.label, BRIEF.label - 5)} (${count})`
    seen.add(label)
    return { ...window, label }
  })
  return {
    ...account,
    title: shorten(account.title, BRIEF.title),
    windows,
    notes: account.notes.map((note) => shorten(note, BRIEF.note)),
    error: account.error === null ? null : shorten(account.error, BRIEF.error)
  }
}

declare module 'orca' {
  interface PluginRequests {
    /** The current quota and connection status. */
    'cpa.state': { output: QuotaState }
    /**
     * Stores the management key for the configured server and starts a poll with it; answers once
     * the key is stored (status `connecting`), and `cpa.changed` follows when the poll ends.
     */
    'cpa.setKey': { input: { key: string }; output: QuotaState }
    /** Forgets the stored management key and what was read with it; nothing is sent after. */
    'cpa.clearKey': { output: QuotaState }
    /**
     * Starts a poll and answers at once (`polling`); `cpa.changed` follows when it ends. Accounts
     * resting after an upstream 401 or 403 are asked again, accounts resting after a 429 are not.
     * During a poll no refresh started (the timer's, say), that poll is followed by one more that
     * does so; during a poll a refresh started, it joins that one.
     */
    'cpa.refresh': { output: QuotaState }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after each poll and each change of key. */
    'cpa.changed': QuotaState
  }
}
