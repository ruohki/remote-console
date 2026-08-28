import { useState } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, ShieldOff } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import type { EnrollToken, ServerInfo } from '@/lib/types'
import { useIsAdmin } from '@/store/auth'
import { Badge, Button, ConfirmDialog, EmptyState, PageHeader, Skeleton, Table, Td, Th, cx } from '@/components/ui'
import { GroupChips, ModeBadge, Tags } from '@/components/badges'
import { AddDeviceDialog } from '@/components/AddDeviceDialog'
import { dateTime, relativeTime } from '@/lib/format'
import { toast } from '@/lib/toast'
import { useNow } from '@/hooks/useNow'
import { BrandingTab } from './settings/BrandingTab'
import { AuthTab } from './settings/AuthTab'
import { AgentDownloadMenu, AgentDownloadsPanel } from '@/components/AgentDownloads'

type SettingsTab = 'info' | 'tokens' | 'branding' | 'agent' | 'auth'

export function Settings({ tab = 'info' }: { tab?: SettingsTab }) {
  const isAdmin = useIsAdmin()
  const current: SettingsTab = isAdmin || tab === 'info' ? tab : 'info'
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Settings" subtitle="Console information, enrollment tokens, branding, agent downloads and authentication." />
      <div className="mb-4 flex flex-wrap gap-1 border-b border-line">
        <TabLink to="/settings" active={current === 'info'}>
          Console
        </TabLink>
        {isAdmin && (
          <>
            <TabLink to="/settings/tokens" active={current === 'tokens'}>
              Enrollment tokens
            </TabLink>
            <TabLink to="/settings/branding" active={current === 'branding'}>
              Branding
            </TabLink>
            <TabLink to="/settings/agent" active={current === 'agent'}>
              Agent downloads
            </TabLink>
            <TabLink to="/settings/auth" active={current === 'auth'}>
              Authentication
            </TabLink>
          </>
        )}
      </div>
      {current === 'tokens' ? <TokensTab /> : current === 'branding' ? <BrandingTab /> : current === 'agent' ? <AgentDownloadsPanel /> : current === 'auth' ? <AuthTab /> : <InfoTab />}
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
    [
      'Signing key',
      i.console_public_key ? (
        <span className="mono break-all" title="ed25519 public key that signs baked agent binaries">
          {i.console_public_key}
        </span>
      ) : (
        <span className="text-ink-faint">not available</span>
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
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-ink-muted">Each token can also be downloaded as a pre-configured agent that enrolls itself.</div>
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
              <Th className="w-56" />
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
                    {t.default_group && <GroupChips groups={[t.default_group]} />}
                    <Tags tags={t.default_tags} />
                  </div>
                </Td>
                <Td className="hidden lg:table-cell text-ink-muted">{t.expires_at ? relativeTime(t.expires_at) : 'never'}</Td>
                <Td className="hidden lg:table-cell text-ink-muted">{dateTime(t.created_at)}</Td>
                <Td className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    {!t.revoked && <TokenDownload token={t} />}
                    {!t.revoked && (
                      <Button size="sm" variant="ghost" icon={<ShieldOff size={13} />} onClick={() => setRevoking(t)}>
                        Revoke
                      </Button>
                    )}
                  </div>
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

/**
 * The plain token is only known right after creation, so downloads for an existing token
 * are only possible while the console still has it — the API accepts the token value, not
 * its id. We keep it in session storage for the current browser session when it was created here.
 */
function TokenDownload({ token }: { token: EnrollToken }) {
  const plain = readPlainToken(token.id)
  if (!plain) {
    return (
      <span className="text-[11.5px] text-ink-faint" title="The token value was only shown once; create a new token to download a pre-configured agent.">
        token not on hand
      </span>
    )
  }
  return <AgentDownloadMenu token={plain} label="Agent" size="sm" variant="ghost" />
}

const PLAIN_KEY = 'console.plainTokens'

/** Remember a freshly created token for this browser session so its downloads stay available. */
export function rememberPlainToken(id: string, token: string) {
  try {
    const map = JSON.parse(sessionStorage.getItem(PLAIN_KEY) ?? '{}') as Record<string, string>
    map[id] = token
    sessionStorage.setItem(PLAIN_KEY, JSON.stringify(map))
  } catch {
    /* storage unavailable */
  }
}

export function readPlainToken(id: string): string | null {
  try {
    const map = JSON.parse(sessionStorage.getItem(PLAIN_KEY) ?? '{}') as Record<string, string>
    return map[id] ?? null
  } catch {
    return null
  }
}
