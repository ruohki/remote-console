import { type FormEvent, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Circle, ImagePlus, Info, MessageSquare, MonitorSmartphone, Trash2 } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import { DEFAULT_BRANDING, accentVariables, isHexColor, logoUrl, readLogo, useBranding } from '@/lib/branding'
import type { Branding } from '@/protocol'
import { Button, Field, Input, Skeleton, Textarea, Toggle, cx } from '@/components/ui'
import { toast } from '@/lib/toast'

/** Settings → Branding: what the person at the device sees (agent app, banner, approval prompt) and, optionally, the console. */
export function BrandingTab() {
  const branding = useBranding()
  if (branding.isPending && !branding.data) return <Skeleton className="h-64 w-full max-w-3xl" />
  return <BrandingForm key={JSON.stringify(branding.data ?? DEFAULT_BRANDING)} initial={{ ...DEFAULT_BRANDING, ...(branding.data ?? {}) }} />
}

function BrandingForm({ initial }: { initial: Branding }) {
  const qc = useQueryClient()
  const [form, setForm] = useState<Branding>(initial)
  const [hex, setHex] = useState(initial.accent)
  const fileInput = useRef<HTMLInputElement>(null)

  // The hex text field and the colour picker share one value; only valid colours reach the form.
  const changeHex = (v: string) => {
    setHex(v)
    if (isHexColor(v)) setForm((f) => ({ ...f, accent: v.toLowerCase() }))
  }

  const save = useMutation({
    mutationFn: (b: Branding) => api.put<Branding>('/api/branding', b),
    onSuccess: () => {
      toast.success('Branding saved', 'Agents downloaded from now on carry it.')
      qc.invalidateQueries({ queryKey: ['branding'] })
      qc.invalidateQueries({ queryKey: ['info'] })
      qc.invalidateQueries({ queryKey: ['agent-downloads'] })
    },
    onError: (e) => toast.error('Could not save the branding', errorMessage(e)),
  })

  const pickLogo = async (file: File | null | undefined) => {
    if (!file) return
    try {
      const b64 = await readLogo(file)
      setForm((f) => ({ ...f, logo_png_base64: b64 }))
    } catch (e) {
      toast.error('Logo not accepted', (e as Error).message)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!form.product_name.trim()) return toast.error('The product name is required')
    if (!isHexColor(form.accent)) return toast.error('The accent must be a #rrggbb colour')
    save.mutate({ ...form, product_name: form.product_name.trim() })
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(initial)
  const name = form.product_name.trim() || DEFAULT_BRANDING.product_name

  return (
    <form onSubmit={submit} className="grid max-w-6xl gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="panel flex flex-col gap-4 p-4">
        <Field label="Product name">
          <Input value={form.product_name} maxLength={60} onChange={(e) => setForm({ ...form, product_name: e.target.value })} placeholder="Acme Remote Support" required />
        </Field>
        <Field label="Accent colour">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={isHexColor(form.accent) ? form.accent : DEFAULT_BRANDING.accent}
              onChange={(e) => changeHex(e.target.value)}
              className="h-9 w-12 cursor-pointer rounded-md border border-line bg-surface p-0.5"
              aria-label="Pick accent colour"
            />
            <Input value={hex} onChange={(e) => changeHex(e.target.value.trim())} className={cx('mono w-32', hex && !isHexColor(hex) && 'border-danger')} placeholder="#2f7fe0" />
            <Button type="button" size="sm" variant="ghost" onClick={() => changeHex(DEFAULT_BRANDING.accent)}>
              Reset
            </Button>
          </div>
        </Field>
        <Field label="Logo" tip="PNG up to 512 KiB; shown at 24–48 px and as the macOS app icon">
          <div className="flex items-center gap-3">
            <div className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-raised">
              {logoUrl(form) ? <img src={logoUrl(form)!} alt="Logo preview" className="max-h-full max-w-full object-contain" /> : <MonitorSmartphone size={20} className="text-ink-faint" />}
            </div>
            <input ref={fileInput} type="file" accept="image/png" className="hidden" onChange={(e) => void pickLogo(e.target.files?.[0])} />
            <Button type="button" size="sm" icon={<ImagePlus size={13} />} onClick={() => fileInput.current?.click()}>
              {logoUrl(form) ? 'Replace PNG' : 'Upload PNG'}
            </Button>
            {logoUrl(form) && (
              <Button type="button" size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setForm({ ...form, logo_png_base64: undefined })}>
                Remove
              </Button>
            )}
          </div>
        </Field>
        <Field label="Organisation">
          <Input value={form.organization} onChange={(e) => setForm({ ...form, organization: e.target.value })} placeholder="Acme IT" />
        </Field>
        <Field label="Support text">
          <Textarea rows={3} value={form.support_text} onChange={(e) => setForm({ ...form, support_text: e.target.value })} placeholder="Support by Acme IT · +49 123 456 · help@acme.example" />
        </Field>
        <div className="rounded-md border border-line bg-raised px-3 py-2.5">
          <Toggle checked={form.apply_to_console} onChange={(v) => setForm({ ...form, apply_to_console: v })} label="Apply to web console" tip="Console title, logo and accent follow the branding" />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
          {dirty && (
            <Button
              type="button"
              onClick={() => {
                setForm(initial)
                setHex(initial.accent)
              }}
            >
              Discard
            </Button>
          )}
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
            Save branding
          </Button>
        </div>
      </div>

      <BrandingPreview branding={{ ...form, product_name: name }} />
    </form>
  )
}

/* ───────────── previews: faithful mocks of what the device user sees ───────────── */

function BrandingPreview({ branding }: { branding: Branding }) {
  const accent = isHexColor(branding.accent) ? branding.accent : DEFAULT_BRANDING.accent
  const vars = accentVariables(accent) as React.CSSProperties
  const logo = logoUrl(branding)
  return (
    <div className="flex flex-col gap-4" style={vars} data-brand-accent={accent}>
      <div>
        <div className="eyebrow">Preview</div>
      </div>

      <Captioned caption="Agent app window">
        <AgentWindowMock branding={branding} logo={logo} />
      </Captioned>

      <Captioned caption="Session banner">
        <BannerMock branding={branding} logo={logo} />
      </Captioned>

      <Captioned caption="Approval prompt">
        <ApprovalMock branding={branding} logo={logo} />
      </Captioned>

      {branding.apply_to_console && (
        <Captioned caption="Console header">
          <ConsoleHeaderMock branding={branding} logo={logo} />
        </Captioned>
      )}
    </div>
  )
}

function Captioned({ caption, hint, children }: { caption: string; hint?: string; children: React.ReactNode }) {
  return (
    <figure className="m-0">
      <figcaption className="mb-1.5">
        <div className="text-[12.5px] font-medium">{caption}</div>
        {hint && <div className="text-[11.5px] text-ink-faint">{hint}</div>}
      </figcaption>
      {children}
    </figure>
  )
}

function Logo({ logo, size = 24, className }: { logo: string | null; size?: number; className?: string }) {
  return logo ? (
    <img src={logo} alt="" style={{ width: size, height: size }} className={cx('shrink-0 rounded-md object-contain', className)} />
  ) : (
    <span style={{ width: size, height: size }} className={cx('grid shrink-0 place-items-center rounded-md bg-accent text-accent-ink', className)}>
      <MonitorSmartphone size={Math.round(size * 0.55)} />
    </span>
  )
}

/** 168 px rail + Status screen, mirroring `crates/agent/src/app/assets`. */
function AgentWindowMock({ branding, logo }: { branding: Branding; logo: string | null }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line-strong bg-surface shadow-pop" aria-label="Agent window preview">
      <div className="flex h-7 items-center gap-1.5 border-b border-line bg-raised px-2.5">
        <span className="size-2.5 rounded-full bg-[#ff5f57]" />
        <span className="size-2.5 rounded-full bg-[#febc2e]" />
        <span className="size-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-2 truncate text-[11px] text-ink-muted">{branding.product_name}</span>
      </div>
      <div className="grid grid-cols-[112px_1fr] text-[11.5px]">
        <div className="flex flex-col gap-0.5 border-r border-line bg-raised p-2">
          <div className="mb-1.5 flex items-center gap-1.5 px-1 py-0.5 font-semibold">
            <Logo logo={logo} size={18} />
            <span className="truncate">{branding.product_name}</span>
          </div>
          {['Status', 'Chat', 'Install', 'Settings', 'About'].map((item, i) => (
            <div key={item} className={cx('flex items-center gap-1.5 rounded-md px-1.5 py-1', i === 0 ? 'bg-accent-soft font-medium text-accent' : 'text-ink-muted')}>
              {i === 1 ? <MessageSquare size={11} /> : i === 4 ? <Info size={11} /> : <Circle size={7} className={i === 0 ? 'fill-current' : ''} />}
              {item}
            </div>
          ))}
          <div className="mt-auto flex items-center gap-1 px-1.5 pt-2 text-[10.5px] text-ink-faint">
            <span className="size-1.5 rounded-full bg-live" /> Online
          </div>
        </div>
        <div className="flex flex-col gap-2.5 p-3">
          <div className="flex items-center gap-2.5">
            <Logo logo={logo} size={34} className="rounded-lg" />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold">{branding.product_name}</div>
              <div className="truncate text-[11px] text-ink-muted">{branding.organization || 'Remote support'}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <div className="rounded-md border border-line bg-raised px-2 py-1.5">
              <div className="text-[9.5px] tracking-wide text-ink-faint uppercase">Console</div>
              <div className="flex items-center gap-1 font-medium">
                <span className="size-1.5 rounded-full bg-live" /> Connected
              </div>
            </div>
            <div className="rounded-md border border-line bg-raised px-2 py-1.5">
              <div className="text-[9.5px] tracking-wide text-ink-faint uppercase">This device</div>
              <div className="truncate font-medium">Front desk PC</div>
            </div>
          </div>
          <div className="rounded-md border border-line bg-raised px-2 py-2">
            <div className="flex items-center gap-2">
              <span className="grid size-6 place-items-center rounded-full bg-accent text-[11px] font-bold text-accent-ink">A</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">Alice</div>
                <div className="text-[10.5px] text-ink-muted">is controlling this computer</div>
              </div>
              <span className="rounded-md bg-accent px-2 py-0.5 text-[10.5px] font-medium text-accent-ink">Open chat</span>
              <span className="rounded-md border border-line px-2 py-0.5 text-[10.5px]">End</span>
            </div>
          </div>
          {branding.support_text.trim() ? (
            <div className="whitespace-pre-wrap text-[10.5px] text-ink-muted">{branding.support_text}</div>
          ) : (
            <div className="text-[10.5px] text-ink-faint">Support text appears here.</div>
          )}
        </div>
      </div>
    </div>
  )
}

function BannerMock({ branding, logo }: { branding: Branding; logo: string | null }) {
  return (
    <div className="flex items-center gap-2.5 overflow-hidden rounded-lg border border-line-strong bg-surface py-2 pr-2 pl-0 shadow-pop" aria-label="Session banner preview">
      <span className="h-9 w-1 shrink-0 rounded-r bg-accent" />
      <Logo logo={logo} size={22} />
      <div className="min-w-0 flex-1 text-[12px]">
        <span className="font-semibold">{branding.product_name}</span>
        <span className="text-ink-faint"> · </span>
        <span className="text-ink-muted">Alice is controlling this computer</span>
      </div>
      <span className="rounded-md border border-line px-2 py-1 text-[11.5px]">Disconnect</span>
    </div>
  )
}

function ApprovalMock({ branding, logo }: { branding: Branding; logo: string | null }) {
  return (
    <div className="mx-auto w-[300px] rounded-xl border border-line-strong bg-surface p-4 text-center shadow-pop" aria-label="Approval prompt preview">
      <div className="mx-auto mb-2 w-fit">
        <Logo logo={logo} size={44} className="rounded-xl" />
      </div>
      <div className="text-[12.5px] font-semibold">
        {branding.product_name}: Alice wants to control this computer.
      </div>
      <div className="mt-1 text-[11.5px] text-ink-muted">You can end the session at any time from the banner.</div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
        <span className="rounded-md border border-line px-2 py-1.5">Deny</span>
        <span className="rounded-md bg-accent px-2 py-1.5 font-medium text-accent-ink">Allow</span>
      </div>
    </div>
  )
}

function ConsoleHeaderMock({ branding, logo }: { branding: Branding; logo: string | null }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line-strong bg-surface shadow-pop" aria-label="Console header preview">
      <div className="flex h-10 items-center gap-2 border-b border-line px-3 text-[12.5px] font-semibold tracking-tight">
        <Logo logo={logo} size={20} />
        <span className="truncate">{branding.product_name}</span>
      </div>
      <div className="flex gap-2 p-3 text-[11.5px]">
        <span className="rounded-md bg-accent-soft px-2 py-1 font-medium text-accent">Devices</span>
        <span className="px-2 py-1 text-ink-muted">Sessions</span>
        <span className="ml-auto rounded-md bg-accent px-2.5 py-1 font-medium text-accent-ink">Connect</span>
      </div>
    </div>
  )
}
