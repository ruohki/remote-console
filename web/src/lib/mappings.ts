/**
 * IdP group → console role/group mapping editor logic (pure, unit tested).
 * Rules are evaluated top to bottom on the server; the editor keeps them ordered.
 */

import type { GroupPermission, MappedRole, Mapping } from './types'

export interface MappingRow extends Mapping {
  /** stable client-side key */
  key: string
}

let seq = 0
const nextKey = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`

export function toRows(mappings: Mapping[] | undefined): MappingRow[] {
  return (mappings ?? []).map((m) => ({ ...m, groups: m.groups ? [...m.groups] : [], key: nextKey() }))
}

export function fromRows(rows: MappingRow[]): Mapping[] {
  return rows.map(({ key: _key, ...m }) => ({
    idp_group: m.idp_group.trim(),
    ...(m.role ? { role: m.role } : {}),
    ...(m.groups && m.groups.length ? { groups: m.groups.map((g) => ({ group_id: g.group_id, permission: g.permission })) } : {}),
  }))
}

export type MappingAction =
  | { type: 'reset'; rows: MappingRow[] }
  | { type: 'add' }
  | { type: 'remove'; key: string }
  | { type: 'move'; key: string; to: number }
  | { type: 'set_group'; key: string; idp_group: string }
  | { type: 'set_role'; key: string; role: MappedRole | undefined }
  | { type: 'toggle_console_group'; key: string; group_id: string; permission: GroupPermission | null }

export function reduceMappings(rows: MappingRow[], action: MappingAction): MappingRow[] {
  switch (action.type) {
    case 'reset':
      return action.rows
    case 'add':
      return [...rows, { key: nextKey(), idp_group: '', groups: [] }]
    case 'remove':
      return rows.filter((r) => r.key !== action.key)
    case 'move': {
      const from = rows.findIndex((r) => r.key === action.key)
      if (from < 0) return rows
      const to = Math.max(0, Math.min(rows.length - 1, action.to))
      if (from === to) return rows
      const copy = [...rows]
      const [row] = copy.splice(from, 1)
      copy.splice(to, 0, row!)
      return copy
    }
    case 'set_group':
      return rows.map((r) => (r.key === action.key ? { ...r, idp_group: action.idp_group } : r))
    case 'set_role':
      return rows.map((r) => (r.key === action.key ? { ...r, role: action.role } : r))
    case 'toggle_console_group':
      return rows.map((r) => {
        if (r.key !== action.key) return r
        const rest = (r.groups ?? []).filter((g) => g.group_id !== action.group_id)
        return { ...r, groups: action.permission ? [...rest, { group_id: action.group_id, permission: action.permission }] : rest }
      })
  }
}

/** Glob syntax used by the server: `*` any run, `?` one char, everything else literal. */
export function validateGlob(pattern: string): string | null {
  const p = pattern.trim()
  if (!p) return 'Enter the IdP group name (exact) or a pattern like it-support-*'
  if (p.length > 200) return 'Pattern is too long'
  if (/[\r\n\t]/.test(p)) return 'Pattern must not contain line breaks or tabs'
  if (p === '*') return '"*" matches every group — use a more specific pattern'
  return null
}

export function globToRegExp(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${esc}$`, 'i')
}

export function globMatches(pattern: string, group: string): boolean {
  return globToRegExp(pattern.trim()).test(group)
}

/** Validation for the whole rule set; returns per-row messages (empty when valid). */
export function validateRows(rows: MappingRow[]): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const r of rows) {
    const g = validateGlob(r.idp_group)
    if (g) errors[r.key] = g
    else if (!r.role && !(r.groups && r.groups.length)) errors[r.key] = 'Pick a role and/or at least one console group'
  }
  return errors
}

/**
 * Client-side preview of what the server will do for a set of IdP groups (mirrors the
 * documented semantics: all matching rules apply, highest role wins, default role otherwise).
 */
export function previewMapping(
  rows: MappingRow[],
  idpGroups: string[],
  defaultRole: MappedRole | 'none',
): { role: MappedRole | 'none'; grants: { group_id: string; permission: GroupPermission }[]; matched: string[] } {
  const matched: string[] = []
  let role: MappedRole | 'none' = 'none'
  const grants = new Map<string, GroupPermission>()
  for (const r of rows) {
    if (!idpGroups.some((g) => globMatches(r.idp_group, g))) continue
    matched.push(r.idp_group)
    if (r.role === 'admin') role = 'admin'
    else if (r.role === 'operator' && role !== 'admin') role = 'operator'
    for (const g of r.groups ?? []) {
      const prev = grants.get(g.group_id)
      if (!prev || (prev === 'view' && g.permission === 'connect')) grants.set(g.group_id, g.permission)
    }
  }
  if (matched.length === 0) role = defaultRole
  else if (role === 'none') role = defaultRole === 'none' ? 'operator' : defaultRole
  return { role, grants: [...grants].map(([group_id, permission]) => ({ group_id, permission })), matched }
}
