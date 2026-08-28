import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import type { Branding } from '@/protocol'

export const DEFAULT_BRANDING: Branding = {
  product_name: 'Remote Console',
  accent: '#2f7fe0',
  support_text: '',
  organization: '',
  apply_to_console: true,
}

export const MAX_LOGO_BYTES = 512 * 1024

/** `#rrggbb` only (what the server accepts). */
export function isHexColor(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v)
}

/** Relative luminance of a `#rrggbb` colour (0 = black, 1 = white). */
export function luminance(hex: string): number {
  if (!isHexColor(hex)) return 0.5
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/** Text colour that stays readable on the accent. */
export function accentInk(hex: string): string {
  return luminance(hex) > 0.42 ? '#0b1220' : '#ffffff'
}

/** Inline CSS variables consumed by the `[data-brand-accent]` rules in `index.css`. */
export function accentVariables(hex: string): Record<string, string> {
  return {
    '--brand-accent': hex,
    '--brand-accent-ink': accentInk(hex),
    // dark surfaces: lift the hue towards white so a saturated brand colour stays legible
    '--brand-accent-dark': `color-mix(in oklab, ${hex} 72%, white)`,
    '--brand-accent-dark-ink': '#0b1220',
  }
}

const BRAND_VARS = ['--brand-accent', '--brand-accent-ink', '--brand-accent-dark', '--brand-accent-dark-ink'] as const

/** Apply branding to the document: title and the accent tokens (theme-aware via CSS). */
export function applyBranding(b: Branding) {
  const root = document.documentElement
  const useIt = consoleBranded(b)
  document.title = useIt ? b.product_name || DEFAULT_BRANDING.product_name : DEFAULT_BRANDING.product_name
  if (useIt && isHexColor(b.accent) && b.accent.toLowerCase() !== DEFAULT_BRANDING.accent) {
    for (const [k, v] of Object.entries(accentVariables(b.accent))) root.style.setProperty(k, v)
    root.dataset.brandAccent = b.accent
  } else {
    for (const k of BRAND_VARS) root.style.removeProperty(k)
    delete root.dataset.brandAccent
  }
}

/** Whether the console itself should show this branding (the agent always gets it). */
export function consoleBranded(b: Branding | undefined): boolean {
  return !!b && b.apply_to_console !== false
}

/** Branding as the console should display it (defaults when not applied to the console). */
export function consoleBranding(b: Branding | undefined): Branding {
  return consoleBranded(b) ? (b as Branding) : DEFAULT_BRANDING
}

/** Data URL for the logo, if any. */
export function logoUrl(b: Branding | undefined): string | null {
  const png = b?.logo_png_base64
  return png ? `data:image/png;base64,${png}` : null
}

export function useBranding() {
  return useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<Branding>('/api/branding'),
    staleTime: 5 * 60_000,
    retry: 0,
    placeholderData: DEFAULT_BRANDING,
  })
}

/** Loads the branding once and keeps the document in sync with it. */
export function useApplyBranding() {
  const q = useBranding()
  const b = q.data ?? DEFAULT_BRANDING
  useEffect(() => {
    applyBranding(b)
  }, [b])
  return b
}

/** Read a PNG file as base64, enforcing type and size. */
export async function readLogo(file: File): Promise<string> {
  if (file.size > MAX_LOGO_BYTES) throw new Error(`The logo must be at most ${Math.round(MAX_LOGO_BYTES / 1024)} KiB.`)
  const buf = new Uint8Array(await file.arrayBuffer())
  const png = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  if (!png) throw new Error('The logo must be a PNG file.')
  let bin = ''
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(bin)
}
