import { type FormEvent, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ImagePlus, MonitorSmartphone, Trash2 } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import { DEFAULT_BRANDING, accentVariables, isHexColor, logoUrl, readLogo, useBranding } from '@/lib/branding'
import type { Branding } from '@/protocol'
import { Button, Field, Input, Skeleton, Textarea, cx } from '@/components/ui'
import { toast } from '@/lib/toast'

/** Settings → Branding: product name, accent, logo and support text used by the console and baked agents. */
export function BrandingTab() {
  const branding = useBranding()
  if (branding.isPending && !branding.data) return <Skeleton className="h-64 w-full max-w-3xl" />
  return <BrandingForm key={JSON.stringify(branding.data ?? DEFAULT_BRANDING)} initial={branding.data ?? DEFAULT_BRANDING} />
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
  const logo = logoUrl(form)
  const previewVars = isHexColor(form.accent) ? (accentVariables(form.accent) as React.CSSProperties) : undefined

  return (
    <form onSubmit={submit} className="grid max-w-5xl gap-4 lg:grid-cols-[1fr_320px]">
      <div className="panel flex flex-col gap-4 p-4">
        <Field label="Product name" hint="Shown in the console, the agent window and the banner on the device.">
          <Input value={form.product_name} maxLength={60} onChange={(e) => setForm({ ...form, product_name: e.target.value })} placeholder="Acme Remote Support" required />
        </Field>
        <Field label="Accent colour" hint="Buttons, links and the agent's accent stripe. The dark theme lightens it automatically.">
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
        <Field label="Logo" hint="PNG, up to 512 KiB. Square or wide logos both work; it is shown at 24–48 px.">
          <div className="flex items-center gap-3">
            <div className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-raised">
              {logo ? <img src={logo} alt="Logo preview" className="max-h-full max-w-full object-contain" /> : <MonitorSmartphone size={20} className="text-ink-faint" />}
            </div>
            <input ref={fileInput} type="file" accept="image/png" className="hidden" onChange={(e) => void pickLogo(e.target.files?.[0])} />
            <Button type="button" size="sm" icon={<ImagePlus size={13} />} onClick={() => fileInput.current?.click()}>
              {logo ? 'Replace PNG' : 'Upload PNG'}
            </Button>
            {logo && (
              <Button type="button" size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setForm({ ...form, logo_png_base64: undefined })}>
                Remove
              </Button>
            )}
          </div>
        </Field>
        <Field label="Organisation" hint="Shown in the agent's About section.">
          <Input value={form.organization} onChange={(e) => setForm({ ...form, organization: e.target.value })} placeholder="Acme IT" />
        </Field>
        <Field label="Support text" hint="Shown to the person at the device, e.g. how to reach you.">
          <Textarea rows={3} value={form.support_text} onChange={(e) => setForm({ ...form, support_text: e.target.value })} placeholder="Support by Acme IT · +49 123 456 · help@acme.example" />
        </Field>
        <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
          {dirty && (
            <Button type="button" onClick={() => { setForm(initial); setHex(initial.accent) }}>
              Discard
            </Button>
          )}
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
            Save branding
          </Button>
        </div>
      </div>

      {/* live preview */}
      <div className="flex flex-col gap-3" style={previewVars} data-brand-accent={isHexColor(form.accent) ? form.accent : undefined}>
        <div className="eyebrow">Preview</div>
        <div className="panel overflow-hidden">
          <div className="flex h-12 items-center gap-2 border-b border-line px-4 font-semibold tracking-tight">
            {logo ? (
              <img src={logo} alt="" className="size-6 rounded-md object-contain" />
            ) : (
              <span className="grid size-6 place-items-center rounded-md bg-accent text-accent-ink">
                <MonitorSmartphone size={14} />
              </span>
            )}
            <span className="truncate">{form.product_name || DEFAULT_BRANDING.product_name}</span>
          </div>
          <div className="flex flex-col gap-2 p-4">
            <div className="rounded-md bg-accent-soft px-2.5 py-1.5 text-[13px] font-medium text-accent">Devices</div>
            <div className="px-2.5 py-1.5 text-[13px] text-ink-muted">Sessions</div>
            <div className="mt-2 flex gap-2">
              <span className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink">Connect</span>
              <span className="rounded-md border border-line px-3 py-1.5 text-[13px]">Details</span>
            </div>
          </div>
        </div>
        <div className="panel p-4 text-[12.5px]">
          <div className="mb-2 flex items-center gap-2 font-semibold">
            <span className="inline-block h-4 w-1 rounded-sm bg-accent" />
            {form.product_name || DEFAULT_BRANDING.product_name}
          </div>
          <div className="text-ink-muted">Alice is controlling this computer.</div>
          {form.support_text.trim() && <div className="mt-2 whitespace-pre-wrap text-ink-faint">{form.support_text}</div>}
          <div className="mt-3 text-[11px] text-ink-faint">How the banner on the device looks.</div>
        </div>
      </div>
    </form>
  )
}
