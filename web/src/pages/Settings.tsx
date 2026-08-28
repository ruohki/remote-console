import { useState } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, ShieldOff } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import type { EnrollToken, ServerInfo } from '@/lib/types'
import { useIsAdmin } from '@/store/auth'
import { Badge, Button, ConfirmDialog, EmptyState, PageHeader, Skeleton, Table, Td, Th, cx } from '@/components/ui'
import { ModeBadge, Tags } from '@/components/badges'
import { AddDeviceDialog } from '@/components/AddDeviceDialog'
import { dateTime, relativeTime } from '@/lib/format'
import { toast } from '@/lib/toast'
import { useNow } from '@/hooks/useNow'

export function Settings({ tab = 'info' }: { tab?: 'info' | 'tokens' }) {
  const isAdmin = useIsAdmin()
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Settings" subtitle="Console information and enrollment tokens." />
      <div className="mb-4 flex gap-1 border-b border-line">
        <TabLink to="/settings" active={tab === 'info'}>
          Console
        </TabLink>
        {isAdmin && (
          <TabLink to="/settings/tokens" active={tab === 'tokens'}>
            Enrollment tokens
          </TabLink>
        )}
      </div>
      {tab === 'info' ? <InfoTab /> : isAdmin ? <TokensTab /> : <InfoTab />}
    </div>
  )
}

function TabLink({ to, active, children }: { to: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className={cx('-mb-px border-b-2 px-3 py-2 text-[13px]', active ? 'border-accent text-ink font-medium' : 'border-transparent text-ink-muted hover:text-ink')}
    >
      {children}
    </Link>
  )
}

function InfoTab() {
  const info = useQuery({ queryKey: ['info'], queryFn: () => api.get<ServerInfo>('/api/info') })
  if (info.isPending) return <Skeleton className="h-40 w-full max-w-xl" />
  if (info.isError)
    return (
      <div className="panel max-w-xl">
        <EmptyState title="Could not load console info" detail={errorMessage(info.error)} />
      </div>
    )
  const i = info.data
  const rows: [string, React.ReactNode][] = [
    ['Console version', <span className="mono">{i.version}</span>],
    ['Protocol version', <span className="mono">{i.protocol_version}</span>],
    ['Public URL', <span className="mono">{i.public_url}</span>],
    [
      'STUN servers',
      i.stun_urls.length ? (
        <span className="mono">{i.stun_urls.join(', ')}</span>
      ) : (
        <span className="text-ink-faint">none</span>
      ),
    ],
    [
      'TURN relay',
      i.turn_enabled ? (
        <Badge tone="live">Enabled</Badge>
      ) : (
        <span>
          <Badge tone="warn">Not configured</Badge>
          <span className="ml-2 text-ink-muted">Sessions through strict NATs will fail. Set TURN_URLS and TURN_SECRET.</span>
        </span>
      ),
    ],
    ['This browser', <span className="text-ink-muted">{navigator.userAgent}</span>],
  ]
  return (
    <div className="panel max-w-3xl divide-y divide-line">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[160px_1fr] gap-3 px-4 py-2.5">
          <div className="text-ink-muted">{k}</div>
          <div className="min-w-0 break-words">{v}</div>
        </div>
      ))}
    </div>
  )
}

function TokensTab() {
  const qc = useQueryClient()
  const tokens = useQuery({ queryKey: ['enroll-tokens'], queryFn: () => api.get<EnrollToken[]>('/api/enroll-tokens') })
  const [adding, setAdding] = useState(false)
  const [revoking, setRevoking] = useState<EnrollToken | null>(null)
  const now = useNow(30_000)
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/api/enroll-tokens/${id}`),
    onSuccess: () => {
      toast.success('Token revoked')
      setRevoking(null)
      qc.invalidateQueries({ queryKey: ['enroll-tokens'] })
    },
    onError: (e) => toast.error('Could not revoke the token', errorMessage(e)),
  })

  const status = (t: EnrollToken) => {
    if (t.revoked) return <Badge tone="danger">Revoked</Badge>
    if (t.expires_at && Date.parse(t.expires_at) < now) return <Badge>Expired</Badge>
    if (t.max_uses !== undefined && t.max_uses !== null && t.uses >= t.max_uses) return <Badge>Used up</Badge>
    return <Badge tone="live">Active</Badge>
  }

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
          New token
        </Button>
      </div>
      {tokens.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : tokens.isError ? (
        <div className="panel">
          <EmptyState title="Could not load tokens" detail={errorMessage(tokens.error)} />
        </div>
      ) : tokens.data.length === 0 ? (
        <div className="panel">
          <EmptyState title="No enrollment tokens" detail="A token lets a machine enroll with the one-line installer." />
        </div>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Label</Th>
              <Th>Status</Th>
              <Th>Uses</Th>
              <Th className="hidden md:table-cell">Defaults</Th>
              <Th className="hidden lg:table-cell">Expires</Th>
              <Th className="hidden lg:table-cell">Created</Th>
              <Th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {tokens.data.map((t) => (
              <tr key={t.id} className="row-hover">
                <Td>
                  <div className="font-medium">{t.label}</div>
                  <div className="mono text-ink-faint">{t.token_prefix}…</div>
                </Td>
                <Td>{status(t)}</Td>
                <Td className="mono">
                  {t.uses}
                  {t.max_uses !== undefined && t.max_uses !== null ? ` / ${t.max_uses}` : ''}
                </Td>
                <Td className="hidden md:table-cell">
                  <div className="flex items-center gap-2">
                    <ModeBadge mode={t.default_mode} />
                    <Tags tags={t.default_tags} />
                  </div>
                </Td>
                <Td className="hidden lg:table-cell text-ink-muted">{t.expires_at ? relativeTime(t.expires_at) : 'never'}</Td>
                <Td className="hidden lg:table-cell text-ink-muted">{dateTime(t.created_at)}</Td>
                <Td className="text-right">
                  {!t.revoked && (
                    <Button size="sm" variant="ghost" icon={<ShieldOff size={13} />} onClick={() => setRevoking(t)}>
                      Revoke
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <AddDeviceDialog open={adding} onClose={() => setAdding(false)} />
      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
        title="Revoke token?"
        body={
          <>
            Installers using <b>{revoking?.label}</b> will stop working. Devices already enrolled are not affected.
          </>
        }
        confirmLabel="Revoke"
        danger
        loading={revoke.isPending}
      />
    </>
  )
}
