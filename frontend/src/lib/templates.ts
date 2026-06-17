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

/** Today's date in ru DD.MM.YYYY format. */
export function todayRu(): string {
  const d = new Date()
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${d.getFullYear()}`
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
