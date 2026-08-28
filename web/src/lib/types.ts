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
}

export interface ApiErrorBody {
  error: { code: string; message: string }
}
