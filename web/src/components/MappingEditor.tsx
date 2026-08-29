import { useMemo, useState, type DragEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, FlaskConical, GripVertical, Plus, Trash2 } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import type { Group, GroupPermission, MappedRole, MappingTestResult, SyncMode } from '@/lib/types'
import { previewMapping, reduceMappings, validateRows, type MappingAction, type MappingRow } from '@/lib/mappings'
import { InfoTip, Badge, Button, Input, Select, cx } from '@/components/ui'

/**
 * Editor for `Mapping[]` + `sync_mode` of an SSO provider. Rows are evaluated top to bottom on
 * the server; every matching rule applies. Drag the grip (or use the arrows) to reorder.
 */
export function MappingEditor({
  rows,
  dispatch,
  syncMode,
  onSyncMode,
  groups,
  defaultRole,
  provider,
}: {
  rows: MappingRow[]
  dispatch: (a: MappingAction) => void
  syncMode: SyncMode
  onSyncMode: (m: SyncMode) => void
  groups: Group[]
  defaultRole: MappedRole | 'none'
  /** which provider's server-side evaluator to use for "Test mapping" */
  provider: 'oidc' | 'saml' | 'ldap'
}) {
  const errors = useMemo(() => validateRows(rows), [rows])
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)

  const onDragStart = (key: string) => (e: DragEvent) => {
    setDragKey(key)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', key)
  }
  const onDragOver = (idx: number) => (e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOverIdx(idx)
  }
  const onDrop = (idx: number) => (e: DragEvent) => {
    e.preventDefault()
    const key = dragKey ?? e.dataTransfer.getData('text/plain')
    if (key) dispatch({ type: 'move', key, to: idx })
    setDragKey(null)
    setOverIdx(null)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="mapping-editor">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="eyebrow mb-1 flex items-center gap-1">
            Sync mode
            <InfoTip text="Authoritative re-evaluates SSO-created grants on every login; manual grants are kept" />
          </div>
          <Select<SyncMode>
            value={syncMode}
            onChange={onSyncMode}
            className="w-56"
            aria-label="Sync mode"
            options={[
              { value: 'additive', label: 'Additive', description: 'Only adds roles and grants' },
              { value: 'authoritative', label: 'Authoritative', description: 'Removes SSO grants that stop matching' },
            ]}
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-strong p-4 text-center text-[12.5px] text-ink-muted">
          No rules — default role: {defaultRole === 'none' ? 'no access' : defaultRole}
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {rows.map((r, idx) => (
            <li
              key={r.key}
              draggable
              onDragStart={onDragStart(r.key)}
              onDragOver={onDragOver(idx)}
              onDrop={onDrop(idx)}
              onDragEnd={() => {
                setDragKey(null)
                setOverIdx(null)
              }}
              className={cx('panel flex flex-col gap-2 p-3', overIdx === idx && dragKey && dragKey !== r.key && 'ring-2 ring-accent/60', dragKey === r.key && 'opacity-60')}
              data-testid="mapping-row"
            >
              <div className="flex items-start gap-2">
                <span className="mt-1.5 cursor-grab text-ink-faint" title="Drag to reorder" aria-hidden>
                  <GripVertical size={14} />
                </span>
                <span className="mt-1.5 w-5 text-right text-[11px] text-ink-faint">{idx + 1}.</span>
                <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[1fr_11rem]">
                  <div>
                    <Input
                      value={r.idp_group}
                      placeholder="it-support-*"
                      onChange={(e) => dispatch({ type: 'set_group', key: r.key, idp_group: e.target.value })}
                      className={cx('mono', errors[r.key] && 'border-danger')}
                      aria-label="IdP group pattern"
                    />
                  </div>
                  <Select<MappedRole | 'keep'>
                    value={r.role ?? 'keep'}
                    onChange={(v) => dispatch({ type: 'set_role', key: r.key, role: v === 'keep' ? undefined : v })}
                    aria-label="Role"
                    options={[
                      { value: 'keep', label: 'No role change' },
                      { value: 'operator', label: 'Operator' },
                      { value: 'admin', label: 'Admin' },
                    ]}
                  />
                </div>
                <div className="flex shrink-0 gap-0.5">
                  <Button size="sm" variant="ghost" icon={<ArrowUp size={13} />} title="Move up" disabled={idx === 0} onClick={() => dispatch({ type: 'move', key: r.key, to: idx - 1 })} />
                  <Button size="sm" variant="ghost" icon={<ArrowDown size={13} />} title="Move down" disabled={idx === rows.length - 1} onClick={() => dispatch({ type: 'move', key: r.key, to: idx + 1 })} />
                  <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} title="Remove rule" onClick={() => dispatch({ type: 'remove', key: r.key })} />
                </div>
              </div>
              <div className="ml-11 flex flex-wrap gap-1.5">
                {groups.length === 0 ? (
                  <span className="text-[12px] text-ink-faint">No device groups yet</span>
                ) : (
                  groups.map((g) => {
                    const cur = r.groups?.find((x) => x.group_id === g.id)?.permission ?? null
                    return <GroupChip key={g.id} name={g.name} value={cur} onChange={(p) => dispatch({ type: 'toggle_console_group', key: r.key, group_id: g.id, permission: p })} />
                  })
                )}
              </div>
              {errors[r.key] && <div className="ml-11 text-[12px] text-danger">{errors[r.key]}</div>}
            </li>
          ))}
        </ol>
      )}
      <div>
        <Button size="sm" icon={<Plus size={13} />} onClick={() => dispatch({ type: 'add' })} data-testid="mapping-add">
          Add rule
        </Button>
      </div>

      <TestMapping rows={rows} groups={groups} defaultRole={defaultRole} provider={provider} />
    </div>
  )
}

/** Three-state chip: none → view → connect → none. */
function GroupChip({ name, value, onChange }: { name: string; value: GroupPermission | null; onChange: (p: GroupPermission | null) => void }) {
  const next: GroupPermission | null = value === null ? 'view' : value === 'view' ? 'connect' : null
  return (
    <button
      type="button"
      onClick={() => onChange(next)}
      title={value ? `${name}: ${value} (click to change)` : `Grant ${name}`}
      className={cx(
        'rounded-full border px-2 py-0.5 text-[12px]',
        value === 'connect' ? 'border-accent bg-accent text-accent-ink' : value === 'view' ? 'border-accent text-accent' : 'border-line-strong text-ink-muted hover:bg-raised',
      )}
    >
      {name}
      {value && <span className="ml-1 opacity-80">· {value}</span>}
    </button>
  )
}

function TestMapping({ rows, groups, defaultRole, provider }: { rows: MappingRow[]; groups: Group[]; defaultRole: MappedRole | 'none'; provider: 'oidc' | 'saml' | 'ldap' }) {
  const [input, setInput] = useState('')
  const idpGroups = input
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const local = useMemo(() => previewMapping(rows, idpGroups, defaultRole), [rows, idpGroups, defaultRole])
  const server = useMutation({
    mutationFn: () => api.post<MappingTestResult>(`/api/auth/${provider}/test-mapping`, { groups: idpGroups }),
  })
  const name = (id: string) => groups.find((g) => g.id === id)?.name ?? id
  return (
    <div className="rounded-lg border border-line bg-raised/60 p-3">
      <div className="mb-2 flex items-center gap-2">
        <FlaskConical size={14} className="text-ink-muted" />
        <span className="font-medium">Test mapping</span>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="it-support-emea, auditors" className="mono flex-1" aria-label="IdP groups to test" data-testid="mapping-test-input" />
        <Button size="sm" onClick={() => server.mutate()} loading={server.isPending} disabled={idpGroups.length === 0} title="Uses the saved configuration">
          Test on server
        </Button>
      </div>
      {idpGroups.length > 0 && (
        <div className="mt-2 text-[12.5px]" data-testid="mapping-test-result">
          <span className="text-ink-muted">Preview (unsaved rules):</span> role <Badge tone={local.role === 'admin' ? 'danger' : local.role === 'none' ? 'warn' : 'accent'}>{local.role}</Badge>
          {local.grants.length > 0 ? (
            <span className="ml-2">
              {local.grants.map((g) => (
                <Badge key={g.group_id} className="mr-1">
                  {name(g.group_id)} · {g.permission}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="ml-2 text-ink-faint">no device groups</span>
          )}
          {local.matched.length > 0 && <span className="ml-2 text-ink-faint">matched: {local.matched.join(', ')}</span>}
          {server.data && (
            <div className="mt-1">
              <span className="text-ink-muted">Server (saved rules):</span> role <Badge>{server.data.role}</Badge>
              {server.data.grants.map((g) => (
                <Badge key={g.group_id} className="ml-1">
                  {g.group_name ?? name(g.group_id)} · {g.permission}
                </Badge>
              ))}
            </div>
          )}
          {server.isError && <div className="mt-1 text-danger">{errorMessage(server.error)}</div>}
        </div>
      )}
    </div>
  )
}

export { reduceMappings }
