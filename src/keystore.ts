// The management key in Orca's encrypted plugin secrets. This module owns the secret's format, the
// rule for which keys can be saved, and what is known about a refused key; nothing else reads or
// writes the secret.
import type { OrcaWorkerApi } from 'orca/worker'

/**
 * Secret holding the key as JSON `{ origin, key, refused? }`. The key is only ever sent to the
 * origin (scheme, host and port) it was saved for; `refused: true` marks a key the server refused,
 * so it is not sent again, not even after a restart, until a key is saved anew.
 */
export const KEY_SECRET = 'managementKey'
/** Printable ASCII without spaces: anything else could break the Authorization header. */
export const KEY_PATTERN = /^[\x21-\x7e]{1,512}$/

/** The stored key, the origin it is for, and whether the server refused it. */
export type StoredKey = { origin: string; key: string; refused: boolean }

/** The secret's text for `key` at `origin`, as `KeyStore` writes it; also for setting up test hosts. */
export function encodeKey({ origin, key, refused = false }: { origin: string; key: string; refused?: boolean }): string {
  return JSON.stringify(refused ? { origin, key, refused: true } : { origin, key })
}

const invalid = (text: string) => Object.assign(new Error(text), { code: 'invalid_params' })
const sameKey = (a: { origin: string; key: string } | null, b: { origin: string; key: string }) =>
  a !== null && a.origin === b.origin && a.key === b.key

export class KeyStore {
  /**
   * The last key the server refused, kept here too: it counts as refused even when storing that
   * failed (a locked keychain, say), until a key is saved or forgotten.
   */
  private refused: { origin: string; key: string } | null = null
  /** Writes run one after another, so marking a key refused never overwrites a newer key. */
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly secrets: OrcaWorkerApi['secrets']) {}

  /** The stored key; null when none is stored or the secret is not in this module's format. */
  async read(): Promise<StoredKey | null> {
    const raw = await this.secrets.get(KEY_SECRET)
    if (!raw) return null
    let value: { origin?: unknown; key?: unknown; refused?: unknown } | null
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
    if (!value || typeof value.origin !== 'string' || typeof value.key !== 'string' || !value.key) return null
    const stored = { origin: value.origin, key: value.key }
    return { ...stored, refused: value.refused === true || sameKey(this.refused, stored) }
  }

  /**
   * Stores `key`, trimmed, for `origin`, replacing any key and its refusal. Rejects with
   * `invalid_params` for an empty key or one `KEY_PATTERN` does not allow.
   */
  async save(origin: string, key: string): Promise<void> {
    const trimmed = key.trim()
    if (!trimmed) throw invalid('The management key is empty.')
    if (!KEY_PATTERN.test(trimmed)) {
      throw invalid('The management key can hold only printable ASCII characters without spaces, at most 512 of them.')
    }
    this.refused = null
    await this.serially(() => this.secrets.set(KEY_SECRET, encodeKey({ origin, key: trimmed })))
  }

  /** Deletes the stored key. */
  async clear(): Promise<void> {
    this.refused = null
    await this.serially(() => this.secrets.delete(KEY_SECRET))
  }

  /**
   * The server refused `used`: it reads as refused from now on, at once and even if storing that
   * fails (then it is sent once more only after a restart). Resolves with whether `used` was still
   * the stored key, so a refusal that a newer key overtook can be told apart; rejects when the
   * write failed.
   */
  markRefused(used: { origin: string; key: string }): Promise<boolean> {
    this.refused = { origin: used.origin, key: used.key }
    return this.serially(async () => {
      const stored = await this.read()
      if (!stored || !sameKey(stored, used)) return false
      await this.secrets.set(KEY_SECRET, encodeKey({ ...used, refused: true }))
      return true
    })
  }

  private serially<T>(write: () => Promise<T>): Promise<T> {
    const result = this.writes.then(write)
    this.writes = result.catch(() => undefined)
    return result
  }
}
