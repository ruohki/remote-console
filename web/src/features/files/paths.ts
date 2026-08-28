/** Path helpers for device paths (POSIX or Windows), used by the remote browser. */

export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:/.test(p) || p.startsWith('\\\\')
}

function sepFor(p: string): '/' | '\\' {
  if (p.includes('\\') && !p.includes('/')) return '\\'
  if (!p.includes('/') && isWindowsPath(p)) return '\\'
  return '/'
}

export function joinPath(dir: string, name: string): string {
  if (!dir) return name
  const sep = sepFor(dir)
  return dir.endsWith(sep) ? dir + name : dir + sep + name
}

export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

/**
 * Directory containing `p`. `null` when `p` is a filesystem/drive root (the browser then
 * shows the well-known roots).
 */
export function parentPath(p: string): string | null {
  const parts = p.split(/[\\/]/).filter(Boolean)
  if (isWindowsPath(p)) {
    if (parts.length <= 1) return null
    return parts.length === 2 ? `${parts[0]}\\` : `${parts[0]}\\${parts.slice(1, -1).join('\\')}`
  }
  if (parts.length <= 1) return parts.length === 0 ? null : '/'
  return '/' + parts.slice(0, -1).join('/')
}

export interface Crumb {
  label: string
  path: string
}

export function crumbsFor(p: string): Crumb[] {
  if (!p) return []
  const isWin = isWindowsPath(p)
  const parts = p.split(/[\\/]/).filter(Boolean)
  const out: Crumb[] = []
  let acc = isWin ? '' : '/'
  parts.forEach((part, i) => {
    acc = i === 0 && isWin ? `${part}\\` : joinPath(acc, part)
    out.push({ label: part, path: acc })
  })
  return out
}
