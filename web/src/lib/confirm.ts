/**
 * Gate for destructive confirmations that require the user to type the resource name
 * (or check an acknowledgement box). Pure so it can be unit tested.
 */
export interface ConfirmGate {
  /** exact name the user must type; `null` = checkbox acknowledgement instead */
  expected: string | null
  typed: string
  acknowledged: boolean
}

/** Case-insensitive, whitespace-trimmed comparison so a copy-pasted name with a trailing space still passes. */
export function normalizeName(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function confirmAllowed(g: ConfirmGate): boolean {
  if (g.expected === null) return g.acknowledged
  const expected = normalizeName(g.expected)
  if (expected === '') return g.acknowledged
  return normalizeName(g.typed) === expected
}
