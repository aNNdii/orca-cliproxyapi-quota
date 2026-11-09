// Small readers for JSON that comes from the server or an upstream provider. They never throw and
// never trust a shape: a value of the wrong type reads as missing (undefined or null).

// Control characters (C0, DEL, C1) and bidi overrides never reach a label or a message.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g

/**
 * `value` without unprintable characters, at its full length; null for anything but a string.
 * Text that must be searched before it is cut (for a secret, say) is searched in this form, so a
 * control character inside the secret cannot hide it.
 */
export function printable(value: unknown): string | null {
  return typeof value === 'string' ? value.replace(UNPRINTABLE, '') : null
}

/** A trimmed, printable string of at most `max` characters; null for anything else or when empty. */
export function cleanText(value: unknown, max = 200): string | null {
  const text = printable(value)?.trim().slice(0, max).trim()
  return text || null
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** `value[key]` when `value` is a plain object that has `key` itself (never from its prototype). */
export const get = (value: unknown, key: string): unknown =>
  isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined

/** The first `max` entries of an array; an empty list for anything else. Each caller says how many it can use. */
export const list = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : [])

/** A finite number, also from a numeric string; null for anything else. */
export function number(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null
}

/** `JSON.parse`, or undefined when `text` is not JSON. */
export function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
