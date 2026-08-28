import { type FormEvent, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import type { EnrollTokenCreated, EnrollTokenInput, Group } from '@/lib/types'
import type { DeviceMode } from '@/protocol'
import { Button, CopyButton, Dialog, Field, Input, Select } from './ui'

/**
 * "Add device" = create an enrollment token and hand the operator the one-line installers.
 * The plain token is only ever shown here.
 */
export function AddDeviceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [label, setLabel] = useState('')
  const [expires, setExpires] = useState('24')
  const [maxUses, setMaxUses] = useState('1')
  const [mode, setMode] = useState<DeviceMode>('unattended')
  const [tags, setTags] = useState('')
  const [groupId, setGroupId] = useState('')
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api.get<Group[]>('/api/groups'), enabled: open })
  const [created, setCreated] = useState<EnrollTokenCreated | null>(null)

  const create = useMutation({
    mutationFn: (input: EnrollTokenInput) => api.post<EnrollTokenCreated>('/api/enroll-tokens', input),
    onSuccess: (t) => {
      setCreated(t)
      qc.invalidateQueries({ queryKey: ['enroll-tokens'] })
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate({
      label: label.trim() || 'Untitled',
      expires_in_hours: expires ? Number(expires) : undefined,
      max_uses: maxUses ? Number(maxUses) : undefined,
      default_mode: mode,
      default_tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      default_group_id: groupId || undefined,
    })
  }

  const close = () => {
    onClose()
    setTimeout(() => {
      setCreated(null)
      create.reset()
    }, 200)
  }

  return (
    <Dialog open={open} onClose={close} title={created ? 'Install the agent' : 'Add a device'} width="max-w-xl">
      {!created ? (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <p className="text-ink-muted -mt-1">
            Create an enrollment token, then run the installer on the machine. It downloads the agent, enrolls it here and starts the
            service.
          </p>
          <Field label="Label" hint="What this token is for, e.g. “Front desk PCs”.">
            <Input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Front desk PCs" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Expires after">
              <Select value={expires} onChange={(e) => setExpires(e.target.value)}>
                <option value="1">1 hour</option>
                <option value="24">24 hours</option>
                <option value="168">7 days</option>
                <option value="720">30 days</option>
                <option value="">Never</option>
              </Select>
            </Field>
            <Field label="Maximum uses">
              <Select value={maxUses} onChange={(e) => setMaxUses(e.target.value)}>
                <option value="1">1 device</option>
                <option value="10">10 devices</option>
                <option value="100">100 devices</option>
                <option value="">Unlimited</option>
              </Select>
            </Field>
            <Field label="Default mode">
              <Select value={mode} onChange={(e) => setMode(e.target.value as DeviceMode)}>
                <option value="unattended">Unattended</option>
                <option value="help_me">Help me (user approves)</option>
              </Select>
            </Field>
            <Field label="Default tags" hint="Comma separated.">
              <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="office, windows" />
            </Field>
            <Field label="Default group" hint="Operators only see devices in groups they are granted." className="col-span-2">
              <Select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">No group (admins only)</option>
                {(groups.data ?? [])
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          {create.isError && (
            <div className="flex items-center gap-2 rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
              <AlertCircle size={14} /> {errorMessage(create.error)}
            </div>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={create.isPending}>
              Create token
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-[12.5px]">
            The token is shown only once. Copy an installer command now.
          </div>
          <Installer title="macOS" hint="Terminal, will ask for your password (sudo)." command={created.install.macos} />
          <Installer title="Windows" hint="PowerShell, run as administrator." command={created.install.windows} />
          <div>
            <div className="eyebrow mb-1">Token</div>
            <div className="flex items-center gap-2">
              <code className="mono flex-1 truncate rounded-md border border-line bg-raised px-2 py-1.5">{created.token}</code>
              <CopyButton text={created.token} />
            </div>
          </div>
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}

function Installer({ title, hint, command }: { title: string; hint: string; command: string }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <div className="font-medium">{title}</div>
        <div className="text-[11.5px] text-ink-faint">{hint}</div>
      </div>
      <div className="flex items-start gap-2">
        <pre className="mono flex-1 overflow-x-auto rounded-md border border-line bg-raised px-2.5 py-2 whitespace-pre-wrap break-all">{command}</pre>
        <CopyButton text={command} />
      </div>
    </div>
  )
}
