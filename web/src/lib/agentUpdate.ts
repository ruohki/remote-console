// Agent versions and the desktop state, as shown on the device list and detail page.
import type { Arch, DesktopState, DeviceSummary, Os } from '@/protocol'
import type { AgentPlatform } from './types'

/** `GET /api/agent/versions`: version the console hands out per platform (`null` = unknown). */
export type AgentVersions = Partial<Record<AgentPlatform, string | null>>

/** Download platform a device runs (mirrors the server's `Platform::for_device`). */
export function platformFor(os: Os, arch: Arch): AgentPlatform | null {
  if (os === 'macos') return 'macos-universal'
  if (os === 'windows') return arch === 'aarch64' ? 'windows-aarch64' : 'windows-x86_64'
  return null
}

interface SemVer {
  core: [number, number, number]
  pre: string[]
}

/** `1.2.3`, `v1.2.3-beta.1+build`; `null` for anything else. */
export function parseSemver(v: string): SemVer | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim())
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** Semver precedence: negative when `a < b`. Pre-releases sort before their release. */
export function compareSemver(a: SemVer, b: SemVer): number {
  for (const i of [0, 1, 2] as const) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i]
  if (!a.pre.length || !b.pre.length) return (b.pre.length ? 1 : 0) - (a.pre.length ? 1 : 0)
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x) ? Number(x) : null
    const ny = /^\d+$/.test(y) ? Number(y) : null
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx - ny
    } else if (nx !== null) return -1
    else if (ny !== null) return 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** `current` is older than `available`; unparsable or unknown versions never are. */
export function isOutdated(current: string, available: string | null | undefined): boolean {
  if (!available) return false
  const c = parseSemver(current)
  const a = parseSemver(available)
  return !!c && !!a && compareSemver(c, a) < 0
}

/** The version this device could update to, or `null`. */
export function availableUpdate(device: Pick<DeviceSummary, 'os' | 'arch' | 'agent_version'>, versions: AgentVersions | undefined): string | null {
  const platform = platformFor(device.os, device.arch)
  const available = platform ? versions?.[platform] : null
  return available && isOutdated(device.agent_version, available) ? available : null
}

/** Badge copy for the desktop states worth calling out (`user` / `unknown` show nothing). */
export const DESKTOP_BADGE: Partial<Record<DesktopState, { label: string; tip: string }>> = {
  sign_in: { label: 'Signed out', tip: 'Nobody is signed in; a session shows the sign-in screen.' },
  locked: { label: 'Locked', tip: 'The user session is locked; a session shows the lock screen.' },
}

/** Badge for an online device's desktop state, or `null`. */
export function desktopBadge(device: Pick<DeviceSummary, 'online' | 'desktop'>): { label: string; tip: string } | null {
  if (!device.online) return null
  return DESKTOP_BADGE[device.desktop ?? 'unknown'] ?? null
}
