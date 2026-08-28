// REST types from API.md that are not part of the shared protocol crate.
import type { AgentConfig, DeviceMode, DeviceSummary } from '@/protocol'

export type Role = 'admin' | 'operator'

export interface User {
  id: string
  email: string
  name: string
  role: Role
  disabled: boolean
  created_at: string
  last_login_at?: string
}

export interface EnrollToken {
  id: string
  label: string
  token_prefix: string
  created_by: string
  created_at: string
  expires_at?: string
  max_uses?: number
  uses: number
  revoked: boolean
  default_mode: DeviceMode
  default_tags: string[]
  default_group?: { id: string; name: string } | null
}

/* ── device groups & access control ── */

export type GroupPermission = 'view' | 'connect'

export interface Group {
  id: string
  name: string
  description: string
  device_count: number
  created_at: string
}

export interface GroupGrant {
  user_id: string
  user_name: string
  user_email: string
  permission: GroupPermission
}

export interface UserGrant {
  group_id: string
  group_name: string
  permission: GroupPermission
}

export interface EnrollTokenCreated extends EnrollToken {
  token: string
  install: { macos: string; windows: string }
}

export interface EnrollTokenInput {
  label: string
  expires_in_hours?: number
  max_uses?: number
  default_mode: DeviceMode
  default_tags: string[]
  default_group_id?: string
}

export interface DeviceDetail extends DeviceSummary {
  notes: string
  created_at: string
  enrolled_with?: string
  config: AgentConfig
}

export interface AuditEntry {
  id: string
  ts: string
  user_id?: string
  user_name?: string
  action: string
  target?: string
  details: unknown
}

export interface ServerInfo {
  version: string
  protocol_version: number
  public_url: string
  stun_urls: string[]
  turn_enabled: boolean
  /** base64 ed25519 key that signs baked agent trailers */
  console_public_key?: string
  branding_product_name?: string
}

/* ── agent bakery ── */

export type AgentPlatform = 'macos-universal' | 'windows-x86_64' | 'windows-aarch64'

export interface AgentDownload {
  platform: AgentPlatform
  available: boolean
  source: 'local' | 'release'
  size?: number
}

export interface ApiErrorBody {
  error: { code: string; message: string }
}
