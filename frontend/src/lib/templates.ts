// Helpers for dynamic templates (placeholders in Russian square brackets, e.g. [дата]).
// Mirrors okdesk-console client-side rendering: extract unique [name] tokens,
// collect operator values, substitute all occurrences.

const PLACEHOLDER_RE = /\[([^\]]+)\]/g

/** Extract unique placeholder names (without brackets) in order of first appearance. */
export function extractPlaceholders(content: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const m of content.matchAll(PLACEHOLDER_RE)) {
    const name = m[1]
    if (!seen.has(name)) {
      seen.add(name)
      result.push(name)
    }
  }
  return result
}

/** True if the content contains at least one [placeholder]. */
export function hasPlaceholders(content: string): boolean {
  PLACEHOLDER_RE.lastIndex = 0
  return PLACEHOLDER_RE.test(content)
}

/** Current date in Moscow time (UTC+3), regardless of the browser's timezone. */
function nowMsk(): Date {
  const now = new Date()
  // Shift the UTC epoch by +3h, then read fields via UTC getters so the
  // result reflects Moscow wall-clock independent of the local zone.
  return new Date(now.getTime() + 3 * 60 * 60 * 1000)
}

/** Format a Date's UTC fields as ru DD.MM.YYYY. */
function fmtRu(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${d.getUTCFullYear()}`
}

/** Today's date (MSK) in ru DD.MM.YYYY format. */
export function todayRu(): string {
  return fmtRu(nowMsk())
}

/** Date offset from today (MSK) by ``days`` in ru DD.MM.YYYY format. */
function dateRuOffset(days: number): string {
  const d = nowMsk()
  d.setUTCDate(d.getUTCDate() + days)
  return fmtRu(d)
}

/** Replace every [name] with its value from the map. Unfilled placeholders are left as-is. */
export function renderTemplate(content: string, values: Record<string, string>): string {
  return content.replace(PLACEHOLDER_RE, (whole, name: string) =>
    name in values ? values[name] : whole,
  )
}

/** Names that auto-fill with today's date (case-insensitive). */
export function isTodayPlaceholder(name: string): boolean {
  return name.trim().toLowerCase() === 'сегодня'
}

/**
 * Computed placeholders that auto-fill without operator input (MSK dates).
 * Returns the value string, or ``null`` if the name is not a known computed one.
 * Case-insensitive, trims surrounding whitespace.
 */
export function computedPlaceholderValue(name: string): string | null {
  switch (name.trim().toLowerCase()) {
    case 'сегодня':
      return todayRu()
    case 'вчера':
      return dateRuOffset(-1)
    case 'завтра':
      return dateRuOffset(1)
    default:
      return null
  }
}

/** True if the placeholder auto-fills from a computed value (date helpers). */
export function isComputedPlaceholder(name: string): boolean {
  return computedPlaceholderValue(name) !== null
}
