// REST types from API.md that are not part of the shared protocol crate.
import type { AgentConfig, DeviceMode, DeviceSummary } from '@/protocol'

export type Role = 'admin' | 'operator'

export type AuthMethod = 'password' | 'passkey' | 'oidc' | 'saml' | 'ldap'
export type Require2fa = 'admins' | 'all' | 'off'

export interface User {
  id: string
  email: string
  name: string
  role: Role
  disabled: boolean
  created_at: string
  last_login_at?: string
  // ── authentication pass (optional: older servers omit them) ──
  two_factor_enabled?: boolean
  /** true while the 2FA policy applies and enrollment is still pending */
  two_factor_required?: boolean
  passkeys?: number
  auth_methods?: AuthMethod[]
  break_glass?: boolean
  last_login_method?: AuthMethod
  /** method used for the current session (from /api/auth/me) */
  auth_method?: AuthMethod
}

/** `GET /api/auth/providers` (public). */
export interface AuthProviders {
  local_login: boolean
  oidc?: { display_name: string }
  saml?: { display_name: string }
  ldap?: { display_name: string }
  passkeys: boolean
  /** policy from `REQUIRE_2FA`; absent on older servers */
  require_2fa?: Require2fa
}

/** LDAP simple-bind provider (`/api/auth/ldap/config`); the bind password is write-only. */
export interface LdapConfig {
  enabled: boolean
  display_name: string
  url: string
  starttls: boolean
  ca_cert_pem?: string
  bind_dn: string
  /** write-only: empty keeps the stored password */
  bind_password?: string
  /** read-only flag from the server */
  bind_password_set?: boolean
  base_dn: string
  user_filter: string
  attribute_map: { email: string; name: string; groups: string }
  group_short_names: boolean
  admin_group?: string
  auto_provision: boolean
  default_role: MappedRole | 'none'
  trust_idp_mfa: boolean
  allowed_domains?: string[]
  mappings: Mapping[]
  sync_mode: SyncMode
}

/** `202` answer of `POST /api/auth/login`. */
export interface LoginPending {
  pending: 'two_factor'
  methods: ('totp' | 'passkey')[]
  challenge_id: string
}

export interface Passkey {
  id: string
  name: string
  created_at: string
  last_used_at?: string
  backup_eligible: boolean
}

export interface TotpSetup {
  secret: string
  otpauth_url: string
  qr_svg: string
}

export type GroupPermission = 'view' | 'connect'
export type SyncMode = 'additive' | 'authoritative'
export type MappedRole = 'admin' | 'operator'

export interface Mapping {
  idp_group: string
  role?: MappedRole
  groups?: { group_id: string; permission: GroupPermission }[]
}

export interface OidcConfig {
  enabled: boolean
  display_name: string
  issuer: string
  client_id: string
  /** write-only: empty string keeps the stored secret */
  client_secret?: string
  scopes: string
  auto_provision: boolean
  default_role: MappedRole | 'none'
  admin_claim?: { name: string; value: string }
  groups_claim?: string
  trust_idp_mfa: boolean
  allowed_domains?: string[]
  mappings: Mapping[]
  sync_mode: SyncMode
}

export interface SamlConfig {
  enabled: boolean
  display_name: string
  idp_metadata_xml?: string
  idp_metadata_url?: string
  sp_entity_id?: string
  attribute_map: { email: string; name: string; groups: string }
  auto_provision: boolean
  default_role: MappedRole | 'none'
  admin_group?: string
  trust_idp_mfa: boolean
  sign_requests: boolean
  mappings: Mapping[]
  sync_mode: SyncMode
}

export interface MappingTestResult {
  role: MappedRole | 'none'
  grants: { group_id: string; group_name?: string; permission: GroupPermission }[]
  matched: string[]
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
  /** result of the last bake for this platform */
  signed?: boolean
  notarized?: boolean
  /** a signing identity is configured on the console */
  signing_configured?: boolean
}

export interface ApiErrorBody {
  error: { code: string; message: string }
}
