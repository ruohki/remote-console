import type { LocalOverrides } from '@/protocol'

/** Human-readable list of the restrictions the person at the device applied locally. */
export function overrideLabels(o: LocalOverrides | undefined | null): string[] {
  if (!o) return []
  const out: string[] = []
  if (o.mode === 'help_me') out.push('Requires approval for every session')
  if (o.allow_input === false) out.push('Keyboard & mouse control blocked')
  if (o.allow_audio === false) out.push('Audio streaming blocked')
  if (o.allow_clipboard === false) out.push('Clipboard sync blocked')
  if (o.allow_file_transfer === false) out.push('File transfer blocked')
  return out
}

export function hasOverrides(o: LocalOverrides | undefined | null): boolean {
  return overrideLabels(o).length > 0
}
