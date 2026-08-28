// Client-side mirror of the server's access rules (API.md "Device groups & access control").
// The server is the authority; these helpers only decide what to show.
import type { DevicePermission, DeviceSummary } from '@/protocol'
import type { GroupGrant, GroupPermission, User } from './types'

type Who = Pick<User, 'role'> | null | undefined
type What = Pick<DeviceSummary, 'permission'>

/** May the user open sessions on / rename / tag this device? */
export function canConnect(device: What, user: Who): boolean {
  if (user?.role === 'admin') return true
  return device.permission === 'connect' || device.permission === 'manage'
}

/** May the user change config, groups or delete the device? Admins only. */
export function canManage(device: What, user: Who): boolean {
  if (user?.role === 'admin') return true
  return device.permission === 'manage'
}

export const PERMISSION_LABEL: Record<DevicePermission, string> = {
  view: 'View only',
  connect: 'Connect',
  manage: 'Manage',
}

export const GROUP_PERMISSION_LABEL: Record<GroupPermission, string> = {
  view: 'View',
  connect: 'Connect',
}

/** Editable state of the Access panel: user id → permission, 'none' = no grant. */
export type GrantChoice = GroupPermission | 'none'

/** Turn the server's grant list into the editor's map. */
export function grantsToChoices(grants: Pick<GroupGrant, 'user_id' | 'permission'>[]): Record<string, GrantChoice> {
  const out: Record<string, GrantChoice> = {}
  for (const g of grants) out[g.user_id] = g.permission
  return out
}

/** Build the `PUT /api/groups/:id/grants` payload from the editor state (drops 'none'). */
export function buildGrantsPayload(choices: Record<string, GrantChoice>): { grants: { user_id: string; permission: GroupPermission }[] } {
  const grants = Object.entries(choices)
    .filter((e): e is [string, GroupPermission] => e[1] !== 'none')
    .map(([user_id, permission]) => ({ user_id, permission }))
    .sort((a, b) => a.user_id.localeCompare(b.user_id))
  return { grants }
}

/** Which users changed between the saved grants and the editor state (for the dirty flag / summary). */
export function grantsDiff(saved: Record<string, GrantChoice>, next: Record<string, GrantChoice>): { user_id: string; from: GrantChoice; to: GrantChoice }[] {
  const ids = new Set([...Object.keys(saved), ...Object.keys(next)])
  const out: { user_id: string; from: GrantChoice; to: GrantChoice }[] = []
  for (const id of ids) {
    const from = saved[id] ?? 'none'
    const to = next[id] ?? 'none'
    if (from !== to) out.push({ user_id: id, from, to })
  }
  return out.sort((a, b) => a.user_id.localeCompare(b.user_id))
}
