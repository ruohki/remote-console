/** Per-browser preferences of the Files drawer (localStorage; every access is guarded). */

const destKey = (deviceId: string) => `remote.destDir.${deviceId}`
const COMPRESSION_KEY = 'remote.files.compression'
const WIDTH_KEY = 'remote.files.width'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* storage disabled */
  }
}

/** Remembered upload destination for a device (`null` = the agent's default folder). */
export function readDestDir(deviceId: string): string | null {
  return read(destKey(deviceId))
}

export function writeDestDir(deviceId: string, dir: string | null) {
  write(destKey(deviceId), dir)
}

/** `auto`: compress chunks on the fly when the device supports it; `off`: always raw. */
export type CompressionPref = 'auto' | 'off'

export function readCompression(): CompressionPref {
  return read(COMPRESSION_KEY) === 'off' ? 'off' : 'auto'
}

export function writeCompression(p: CompressionPref) {
  write(COMPRESSION_KEY, p === 'auto' ? null : p)
}

export const DRAWER_MIN_WIDTH = 340
export const DRAWER_MAX_WIDTH = 760
export const DRAWER_DEFAULT_WIDTH = 420

export function clampDrawerWidth(n: number): number {
  if (!Number.isFinite(n)) return DRAWER_DEFAULT_WIDTH
  return Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, Math.round(n)))
}

export function readDrawerWidth(): number {
  const v = read(WIDTH_KEY)
  return v === null ? DRAWER_DEFAULT_WIDTH : clampDrawerWidth(Number(v))
}

export function writeDrawerWidth(n: number) {
  write(WIDTH_KEY, String(clampDrawerWidth(n)))
}
