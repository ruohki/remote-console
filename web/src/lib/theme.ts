export type Theme = 'system' | 'light' | 'dark'

const KEY = 'console.theme'

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* storage unavailable */
  }
  return 'system'
}

export function applyTheme(theme: Theme) {
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  const dark = theme === 'dark' || (theme === 'system' && prefersDark)
  document.documentElement.classList.toggle('dark', dark)
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* ignore */
  }
}

/** Apply the stored theme and keep following the OS while in `system` mode. */
export function initTheme() {
  applyTheme(readTheme())
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
  mq?.addEventListener?.('change', () => {
    if (readTheme() === 'system') applyTheme('system')
  })
}
