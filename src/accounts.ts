// Reading CLIProxyAPI's credential list (`GET /v8/management/credentials`, v0 `auth-files`) into
// accounts. The fields every entry has are read here; the few that only one provider needs are
// declared by that provider in src/providers.ts and read through `EntryFields`, so this module
// knows no provider.
import { cleanText, get, isRecord } from './untrusted'

/** At most this many accounts are taken from the credential list; the rest are counted only. */
export const MAX_ACCOUNTS = 100

/**
 * A value a provider takes from its credential entries: the value at the first of `paths` that is
 * a string matching `pattern`. The pattern (anchored with `^...$`) is the only check, so it must
 * keep out anything that could change a request the value goes into (`$`, quotes, CR/LF, ...).
 */
export type EntryField = { paths: readonly (readonly string[])[]; pattern: RegExp }
/** A provider's entry fields by the name its requests read them under. */
export type EntryFields = Readonly<Record<string, EntryField>>

/** The values of the entry fields `F` that were present and valid, by their names. */
export type Details<F extends EntryFields> = { readonly [K in keyof F]?: string }

/**
 * One account (credential) as the server lists it, validated and capped. Strings are trimmed,
 * free of control characters and at most 200 characters long (`cleanText`). `F` is the entry
 * fields its provider declares, so a provider reads only the details it declared.
 */
export type Account<F extends EntryFields = EntryFields> = {
  /** Unique within one listing: the auth index, or `name:<name>` when the server gave none. */
  id: string
  /** The server's runtime handle for api-call; null when it listed the account without one. */
  authIndex: string | null
  /** The credential's file name, or `unnamed`. */
  name: string
  /** `provider` (or `type`), lower case with `_` as `-`, e.g. `claude`, `codex`, `gemini-cli`. */
  provider: string
  email: string | null
  label: string | null
  disabled: boolean
  /** The provider's entry fields that were present and valid, by their names. */
  details: Details<F>
}

/**
 * Every account in a credential list answer, in its order, at most `MAX_ACCOUNTS` (`omitted`
 * counts the rest). Entries that are not objects are skipped, and a repeated id keeps its first
 * entry. Null when the answer has no `files` list.
 */
export function readCredentialList(
  body: unknown,
  fieldsOf: (provider: string) => EntryFields
): { accounts: Account[]; omitted: number } | null {
  const files = get(body, 'files')
  if (!Array.isArray(files)) return null
  const seen = new Set<string>()
  const accounts: Account[] = []
  let omitted = 0
  for (const entry of files) {
    const account = readAccount(entry, fieldsOf)
    if (!account || seen.has(account.id)) continue
    seen.add(account.id)
    if (accounts.length < MAX_ACCOUNTS) accounts.push(account)
    else omitted += 1
  }
  return { accounts, omitted }
}

function readAccount(entry: unknown, fieldsOf: (provider: string) => EntryFields): Account | null {
  if (!isRecord(entry)) return null
  const rawIndex = get(entry, 'auth_index')
  const authIndex =
    typeof rawIndex === 'number' && Number.isSafeInteger(rawIndex) ? String(rawIndex) : cleanText(rawIndex, 128)
  const name = cleanText(get(entry, 'name')) ?? cleanText(get(entry, 'id')) ?? 'unnamed'
  const provider = (cleanText(get(entry, 'provider'), 64) ?? cleanText(get(entry, 'type'), 64) ?? 'unknown')
    .toLowerCase()
    .replace(/_/g, '-')
  const details: Record<string, string> = {}
  for (const [key, field] of Object.entries(fieldsOf(provider))) {
    const value = firstMatch(entry, field)
    if (value !== null) details[key] = value
  }
  return {
    id: authIndex ?? `name:${name}`,
    authIndex,
    name,
    provider,
    email: cleanText(get(entry, 'email')),
    label: cleanText(get(entry, 'label')),
    disabled: get(entry, 'disabled') === true,
    details
  }
}

function firstMatch(entry: unknown, field: EntryField): string | null {
  for (const path of field.paths) {
    const value = path.reduce<unknown>((at, key) => get(at, key), entry)
    if (typeof value === 'string' && field.pattern.test(value)) return value
  }
  return null
}
