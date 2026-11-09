// The panel <-> worker contract, declared once: src/panel.tsx and src/collector.ts both read it.
import type { ApiVersion } from './client'
import type { RangeId, UsageView } from './usage'

/**
 * `unconfigured`: no valid URL, or no key saved for this server's origin; nothing is sent. `auth`:
 * the server refused the key; nothing is sent until a key is saved again. `error`: the last poll
 * failed; the next one retries (after an IP ban, once the ban ends).
 */
export type StatusKind = 'unconfigured' | 'ok' | 'auth' | 'error'
export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger'

export type UsageState = {
  /** The URL the worker polls, after normalizing; null while the setting is not a valid URL. */
  baseUrl: string | null
  /** Whether a key is stored for this server's origin. The key itself never leaves the worker. */
  hasKey: boolean
  status: { kind: StatusKind; tone: StatusTone; label: string; message: string | null }
  /** When the last poll finished, successful or not (epoch ms). */
  lastPollAt: number | null
  /** When counting started (epoch ms); see `UsageStore.since`. */
  trackingSince: number | null
  apiVersion: ApiVersion | null
  /** false: the server does not publish usage records; null: unknown. */
  statisticsEnabled: boolean | null
  /** Days of history the worker keeps (1 to 366, today included); longer ranges show only these. */
  retentionDays: number
  views: Record<RangeId, UsageView>
}

declare module 'orca' {
  interface PluginRequests {
    /** The current usage and connection status. */
    'cpa.state': { output: UsageState }
    /** Stores the management key for the configured server and polls with it at once. */
    'cpa.setKey': { input: { key: string }; output: UsageState }
    /** Forgets the stored management key. */
    'cpa.clearKey': { output: UsageState }
    /** Polls now, or waits for the poll already running. */
    'cpa.refresh': { output: UsageState }
    /** Deletes the counted usage. Records already read from the server are gone for good. */
    'cpa.reset': { output: UsageState }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after each poll and each change of key or counts. */
    'cpa.changed': UsageState
  }
}
