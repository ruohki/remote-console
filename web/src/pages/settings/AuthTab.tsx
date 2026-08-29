import { useReducer, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, ExternalLink, FlaskConical, Save } from 'lucide-react'
import { api, ApiError, errorMessage } from '@/lib/api'
import type { AuthProviders, Group, LdapConfig, MappedRole, OidcConfig, SamlConfig, SyncMode } from '@/lib/types'
import { fromRows, reduceMappings, toRows, validateRows } from '@/lib/mappings'
import { InfoTip, Badge, Button, EmptyState, Field, Input, Select, Skeleton, Textarea, Toggle, cx } from '@/components/ui'
import { MappingEditor } from '@/components/MappingEditor'
import { toast } from '@/lib/toast'

const DEFAULT_OIDC: OidcConfig = {
  enabled: false,
  display_name: 'Single sign-on',
  issuer: '',
  client_id: '',
  client_secret: '',
  scopes: 'openid email profile',
  auto_provision: true,
  default_role: 'operator',
  groups_claim: 'groups',
  trust_idp_mfa: false,
  allowed_domains: [],
  mappings: [],
  sync_mode: 'additive',
}

const DEFAULT_SAML: SamlConfig = {
  enabled: false,
  display_name: 'SAML single sign-on',
  idp_metadata_xml: '',
  idp_metadata_url: '',
  attribute_map: { email: 'email', name: 'displayName', groups: 'groups' },
  auto_provision: true,
  default_role: 'operator',
  trust_idp_mfa: false,
  sign_requests: true,
  mappings: [],
  sync_mode: 'additive',
}

const DEFAULT_LDAP: LdapConfig = {
  enabled: false,
  display_name: 'Directory account',
  url: '',
  starttls: false,
  bind_dn: '',
  bind_password: '',
  base_dn: '',
  user_filter: '(|(mail={login})(sAMAccountName={login})(uid={login}))',
  attribute_map: { email: 'mail', name: 'displayName', groups: 'memberOf' },
  group_short_names: true,
  auto_provision: true,
  default_role: 'operator',
  trust_idp_mfa: false,
  allowed_domains: [],
  mappings: [],
  sync_mode: 'additive',
}

/** `/settings/auth` — policy overview and identity-provider configuration (admin). */
export function AuthTab() {
  const providers = useQuery({
    queryKey: ['auth-providers'],
    queryFn: async () => {
      try {
        return await api.get<AuthProviders>('/api/auth/providers')
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null
        throw err
      }
    },
  })
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api.get<Group[]>('/api/groups') })
  const [section, setSection] = useState<'oidc' | 'saml' | 'ldap'>('oidc')

  if (providers.isPending) return <Skeleton className="h-40 w-full" />
  if (providers.data === null)
    return (
      <div className="panel">
        <EmptyState title="This console version has no authentication settings" detail="Update the console server." />
      </div>
    )

  return (
    <div className="flex flex-col gap-4">
      <PolicySummary providers={providers.data} />
      <div className="flex gap-1 border-b border-line">
        {(['oidc', 'saml', 'ldap'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={cx('-mb-px border-b-2 px-3 py-2 text-[13px]', section === s ? 'border-accent text-ink font-medium' : 'border-transparent text-ink-muted hover:text-ink')}
          >
            {s === 'oidc' ? 'OpenID Connect' : s === 'saml' ? 'SAML 2.0' : 'LDAP directory'}
            {(s === 'oidc' ? providers.data?.oidc : s === 'saml' ? providers.data?.saml : providers.data?.ldap) && (
              <Badge tone="live" className="ml-2">
                On
              </Badge>
            )}
          </button>
        ))}
      </div>
      {section === 'oidc' ? <OidcForm groups={groups.data ?? []} /> : section === 'saml' ? <SamlForm groups={groups.data ?? []} /> : <LdapForm groups={groups.data ?? []} />}
    </div>
  )
}

function PolicySummary({ providers }: { providers?: AuthProviders }) {
  return (
    <section className="panel p-4">
      <h2 className="mb-2 font-semibold">Sign-in policy</h2>
      <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[12rem_1fr]">
        <dt className="text-ink-muted">Two-factor requirement</dt>
        <dd>
          <span className="mono">REQUIRE_2FA</span> = <span className="mono">admins</span> (default), <span className="mono">all</span> or <span className="mono">off</span>
        </dd>
        <dt className="text-ink-muted">Password sign-in</dt>
        <dd>
          {providers?.local_login === false ? (
            <>
              <Badge tone="warn">Disabled</Badge> <span className="text-ink-muted"><span className="mono">LOCAL_LOGIN=0</span> — break-glass accounts only</span>
            </>
          ) : (
            <>
              <Badge tone="live">Enabled</Badge> <span className="text-ink-muted"><span className="mono">LOCAL_LOGIN=0</span> disables it — keep one break-glass admin</span>
            </>
          )}
        </dd>
        <dt className="text-ink-muted">Passkeys &amp; security keys</dt>
        <dd>
          <Badge tone="live">Enabled</Badge> <span className="text-ink-muted">Bound to the console’s public URL host</span>
        </dd>
      </dl>
    </section>
  )
}

/* ───────────── OIDC ───────────── */

function OidcForm({ groups }: { groups: Group[] }) {
  const cfg = useQuery({ queryKey: ['oidc-config'], queryFn: () => api.get<OidcConfig>('/api/auth/oidc/config') })
  if (cfg.isPending) return <Skeleton className="h-60 w-full" />
  if (cfg.isError) return <EmptyState title="OpenID Connect settings unavailable" detail={errorMessage(cfg.error)} />
  // Re-mount the form whenever the stored config changes so local edits start from it.
  return <OidcFormInner key={cfg.dataUpdatedAt} initial={cfg.data} groups={groups} />
}

function OidcFormInner({ initial, groups }: { initial: OidcConfig; groups: Group[] }) {
  const qc = useQueryClient()
  const [form, setForm] = useState<OidcConfig>(() => ({ ...DEFAULT_OIDC, ...initial, client_secret: '' }))
  const [rows, dispatch] = useReducer(reduceMappings, initial.mappings, toRows)
  const [domains, setDomains] = useState(() => (initial.allowed_domains ?? []).join(', '))
  const [adminClaim, setAdminClaim] = useState(() => initial.admin_claim ?? { name: '', value: '' })
  const save = useMutation({
    mutationFn: () =>
      api.put<OidcConfig>('/api/auth/oidc/config', {
        ...form,
        client_secret: form.client_secret || undefined,
        allowed_domains: domains
          .split(/[,\s]+/)
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean),
        admin_claim: adminClaim.name.trim() ? { name: adminClaim.name.trim(), value: adminClaim.value.trim() } : undefined,
        mappings: fromRows(rows),
      }),
    onSuccess: () => {
      toast.success('OpenID Connect settings saved')
      void qc.invalidateQueries({ queryKey: ['oidc-config'] })
      void qc.invalidateQueries({ queryKey: ['auth-providers'] })
    },
    onError: (e) => toast.error('Could not save', errorMessage(e)),
  })
  const test = useMutation({
    mutationFn: () => api.post<{ issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; userinfo_endpoint?: string }>('/api/auth/oidc/test', { issuer: form.issuer }),
  })

  const set = <K extends keyof OidcConfig>(k: K, v: OidcConfig[K]) => setForm((f) => ({ ...f, [k]: v }))
  const errors = validateRows(rows)
  const canSave = form.issuer.trim() && form.client_id.trim() && Object.keys(errors).length === 0

  return (
    <div className="flex flex-col gap-4">
      <section className="panel grid gap-3 p-4 sm:grid-cols-2">
        <div className="sm:col-span-2 flex items-center justify-between">
          <h2 className="font-semibold">Provider</h2>
          <Toggle checked={form.enabled} onChange={(v) => set('enabled', v)} label="Enabled" />
        </div>
        <Field label="Button label" hint="Shown on the sign-in page">
          <Input value={form.display_name} onChange={(e) => set('display_name', e.target.value)} placeholder="Acme SSO" />
        </Field>
        <Field label="Issuer URL" tip="Discovery: <issuer>/.well-known/openid-configuration">
          <Input value={form.issuer} onChange={(e) => set('issuer', e.target.value)} placeholder="https://login.example.com/realms/acme" className="mono" />
        </Field>
        <Field label="Client ID">
          <Input value={form.client_id} onChange={(e) => set('client_id', e.target.value)} className="mono" />
        </Field>
        <Field label="Client secret" hint={initial.client_id ? 'Leave empty to keep the stored secret' : undefined}>
          <Input type="password" autoComplete="new-password" value={form.client_secret ?? ''} onChange={(e) => set('client_secret', e.target.value)} className="mono" />
        </Field>
        <Field label="Scopes">
          <Input value={form.scopes} onChange={(e) => set('scopes', e.target.value)} className="mono" />
        </Field>
        <Field label="Groups claim">
          <Input value={form.groups_claim ?? ''} onChange={(e) => set('groups_claim', e.target.value)} className="mono" placeholder="groups" />
        </Field>
        <Field label="Allowed email domains" tip="Comma separated; empty allows any verified email">
          <Input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com, corp.example" className="mono" />
        </Field>
        <Field label="Admin claim (optional)">
          <div className="flex gap-2">
            <Input value={adminClaim.name} onChange={(e) => setAdminClaim((a) => ({ ...a, name: e.target.value }))} placeholder="roles" className="mono" />
            <Input value={adminClaim.value} onChange={(e) => setAdminClaim((a) => ({ ...a, value: e.target.value }))} placeholder="console-admin" className="mono" />
          </div>
        </Field>
        <div className="sm:col-span-2 grid gap-2 sm:grid-cols-3">
          <Toggle checked={form.auto_provision} onChange={(v) => set('auto_provision', v)} label="Auto-create accounts" />
          <Toggle checked={form.trust_idp_mfa} onChange={(v) => set('trust_idp_mfa', v)} label="Trust IdP MFA" tip="amr/acr from the IdP satisfies the two-factor policy" />
          <div>
            <div className="eyebrow mb-1">Default role</div>
            <DefaultRole value={form.default_role} onChange={(v) => set('default_role', v)} />
          </div>
        </div>
        <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
          <Button size="sm" icon={<FlaskConical size={13} />} onClick={() => test.mutate()} loading={test.isPending} disabled={!form.issuer.trim()}>
            Test discovery
          </Button>
          {test.data && (
            <span className="text-[12px] text-ink-muted" data-testid="oidc-test-result">
              OK — authorize <span className="mono">{test.data.authorization_endpoint}</span>, token <span className="mono">{test.data.token_endpoint}</span>, JWKS <span className="mono">{test.data.jwks_uri}</span>
            </span>
          )}
          {test.isError && <span className="text-[12px] text-danger">{errorMessage(test.error)}</span>}
          <span className="ml-auto text-[12px] text-ink-faint">
            Redirect URI: <span className="mono select-all">{`${window.location.origin}/api/auth/oidc/callback`}</span>
          </span>
        </div>
      </section>

      <section className="panel p-4">
        <h2 className="mb-3 flex items-center gap-1.5 font-semibold">
          Group mapping
          <InfoTip text="Rules run top to bottom; every matching rule applies" />
        </h2>
        <MappingEditor rows={rows} dispatch={dispatch} syncMode={form.sync_mode} onSyncMode={(m: SyncMode) => set('sync_mode', m)} groups={groups} defaultRole={form.default_role} provider="oidc" />
      </section>

      <div className="flex justify-end">
        <Button variant="primary" icon={<Save size={14} />} loading={save.isPending} disabled={!canSave} onClick={() => save.mutate()} data-testid="oidc-save">
          Save OpenID Connect settings
        </Button>
      </div>
    </div>
  )
}

/* ───────────── SAML ───────────── */

function SamlForm({ groups }: { groups: Group[] }) {
  const cfg = useQuery({ queryKey: ['saml-config'], queryFn: () => api.get<SamlConfig>('/api/auth/saml/config') })
  if (cfg.isPending) return <Skeleton className="h-60 w-full" />
  if (cfg.isError) return <EmptyState title="SAML settings unavailable" detail={errorMessage(cfg.error)} />
  return <SamlFormInner key={cfg.dataUpdatedAt} initial={cfg.data} groups={groups} />
}

function SamlFormInner({ initial, groups }: { initial: SamlConfig; groups: Group[] }) {
  const qc = useQueryClient()
  const [form, setForm] = useState<SamlConfig>(() => ({ ...DEFAULT_SAML, ...initial }))
  const [rows, dispatch] = useReducer(reduceMappings, initial.mappings, toRows)
  const [metaMode, setMetaMode] = useState<'url' | 'xml'>(() => (initial.idp_metadata_xml && !initial.idp_metadata_url ? 'xml' : 'url'))
  const save = useMutation({
    mutationFn: () =>
      api.put<SamlConfig>('/api/auth/saml/config', {
        ...form,
        idp_metadata_url: metaMode === 'url' ? form.idp_metadata_url : undefined,
        idp_metadata_xml: metaMode === 'xml' ? form.idp_metadata_xml : undefined,
        mappings: fromRows(rows),
      }),
    onSuccess: () => {
      toast.success('SAML settings saved')
      void qc.invalidateQueries({ queryKey: ['saml-config'] })
      void qc.invalidateQueries({ queryKey: ['auth-providers'] })
    },
    onError: (e) => toast.error('Could not save', errorMessage(e)),
  })
  const test = useMutation({
    mutationFn: () => api.post<{ entity_id: string; sso_url: string; certificates: number }>('/api/auth/saml/test', {}),
  })

  const set = <K extends keyof SamlConfig>(k: K, v: SamlConfig[K]) => setForm((f) => ({ ...f, [k]: v }))
  const errors = validateRows(rows)
  const hasMeta = metaMode === 'url' ? !!form.idp_metadata_url?.trim() : !!form.idp_metadata_xml?.trim()
  const canSave = hasMeta && Object.keys(errors).length === 0

  return (
    <div className="flex flex-col gap-4">
      <section className="panel grid gap-3 p-4 sm:grid-cols-2">
        <div className="sm:col-span-2 flex items-center justify-between">
          <h2 className="font-semibold">Identity provider</h2>
          <Toggle checked={form.enabled} onChange={(v) => set('enabled', v)} label="Enabled" />
        </div>
        <Field label="Button label">
          <Input value={form.display_name} onChange={(e) => set('display_name', e.target.value)} />
        </Field>
        <Field label="SP entity ID">
          <Input value={form.sp_entity_id ?? ''} onChange={(e) => set('sp_entity_id', e.target.value)} className="mono" placeholder={`${window.location.origin}/saml`} />
        </Field>
        <div className="sm:col-span-2">
          <div className="mb-1 flex items-center gap-3">
            <span className="eyebrow">IdP metadata</span>
            <label className="flex items-center gap-1 text-[12.5px]">
              <input type="radio" checked={metaMode === 'url'} onChange={() => setMetaMode('url')} /> URL
            </label>
            <label className="flex items-center gap-1 text-[12.5px]">
              <input type="radio" checked={metaMode === 'xml'} onChange={() => setMetaMode('xml')} /> Upload / paste XML
            </label>
          </div>
          {metaMode === 'url' ? (
            <Input value={form.idp_metadata_url ?? ''} onChange={(e) => set('idp_metadata_url', e.target.value)} placeholder="https://idp.example.com/metadata.xml" className="mono" />
          ) : (
            <div className="flex flex-col gap-2">
              <Textarea rows={6} value={form.idp_metadata_xml ?? ''} onChange={(e) => set('idp_metadata_xml', e.target.value)} className="mono text-[12px]" placeholder="<EntityDescriptor …>" />
              <input
                type="file"
                accept=".xml,text/xml,application/xml"
                className="text-[12.5px]"
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  if (f) set('idp_metadata_xml', await f.text())
                }}
              />
            </div>
          )}
        </div>
        <Field label="Email attribute">
          <Input value={form.attribute_map.email} onChange={(e) => set('attribute_map', { ...form.attribute_map, email: e.target.value })} className="mono" />
        </Field>
        <Field label="Name attribute">
          <Input value={form.attribute_map.name} onChange={(e) => set('attribute_map', { ...form.attribute_map, name: e.target.value })} className="mono" />
        </Field>
        <Field label="Groups attribute">
          <Input value={form.attribute_map.groups} onChange={(e) => set('attribute_map', { ...form.attribute_map, groups: e.target.value })} className="mono" />
        </Field>
        <Field label="Admin group (optional)">
          <Input value={form.admin_group ?? ''} onChange={(e) => set('admin_group', e.target.value)} className="mono" />
        </Field>
        <div className="sm:col-span-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Toggle checked={form.auto_provision} onChange={(v) => set('auto_provision', v)} label="Auto-create accounts" />
          <Toggle checked={form.sign_requests} onChange={(v) => set('sign_requests', v)} label="Sign AuthnRequests" />
          <Toggle checked={form.trust_idp_mfa} onChange={(v) => set('trust_idp_mfa', v)} label="Trust IdP MFA" tip="IdP MFA satisfies the two-factor policy" />
          <div>
            <div className="eyebrow mb-1">Default role</div>
            <DefaultRole value={form.default_role} onChange={(v) => set('default_role', v)} />
          </div>
        </div>
        <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
          <Button size="sm" icon={<FlaskConical size={13} />} onClick={() => test.mutate()} loading={test.isPending} title="Uses the saved metadata">
            Test IdP metadata
          </Button>
          {test.data && (
            <span className="text-[12px] text-ink-muted">
              OK — entity <span className="mono">{test.data.entity_id}</span>, SSO <span className="mono">{test.data.sso_url}</span>, {test.data.certificates} signing cert(s)
            </span>
          )}
          {test.isError && <span className="text-[12px] text-danger">{errorMessage(test.error)}</span>}
          <a className="ml-auto inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline" href="/api/auth/saml/metadata" target="_blank" rel="noreferrer">
            <Download size={12} /> SP metadata <ExternalLink size={11} />
          </a>
        </div>
        <p className="sm:col-span-2 text-[12px] text-ink-faint">
          ACS URL: <span className="mono select-all">{`${window.location.origin}/api/auth/saml/acs`}</span>
        </p>
      </section>

      <section className="panel p-4">
        <h2 className="mb-3 flex items-center gap-1.5 font-semibold">
          Group mapping
          <InfoTip text="Rules run top to bottom; every matching rule applies" />
        </h2>
        <MappingEditor rows={rows} dispatch={dispatch} syncMode={form.sync_mode} onSyncMode={(m: SyncMode) => set('sync_mode', m)} groups={groups} defaultRole={form.default_role} provider="saml" />
      </section>

      <div className="flex justify-end">
        <Button variant="primary" icon={<Save size={14} />} loading={save.isPending} disabled={!canSave} onClick={() => save.mutate()} data-testid="saml-save">
          Save SAML settings
        </Button>
      </div>
    </div>
  )
}

/* ───────────── LDAP ───────────── */

function LdapForm({ groups }: { groups: Group[] }) {
  const cfg = useQuery({
    queryKey: ['ldap-config'],
    queryFn: async () => {
      try {
        return await api.get<LdapConfig>('/api/auth/ldap/config')
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null
        throw err
      }
    },
  })
  if (cfg.isPending) return <Skeleton className="h-60 w-full" />
  if (cfg.isError) return <EmptyState title="LDAP settings unavailable" detail={errorMessage(cfg.error)} />
  if (cfg.data === null) return <EmptyState title="This console version has no LDAP support" detail="Update the console server." />
  return <LdapFormInner key={cfg.dataUpdatedAt} initial={cfg.data} groups={groups} />
}

function LdapFormInner({ initial, groups }: { initial: LdapConfig; groups: Group[] }) {
  const qc = useQueryClient()
  const [form, setForm] = useState<LdapConfig>(() => ({ ...DEFAULT_LDAP, ...initial, bind_password: '' }))
  const [rows, dispatch] = useReducer(reduceMappings, initial.mappings ?? [], toRows)
  const [domains, setDomains] = useState(() => (initial.allowed_domains ?? []).join(', '))
  const payload = () => ({
    ...form,
    bind_password: form.bind_password || undefined,
    allowed_domains: domains
      .split(/[,\s]+/)
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    mappings: fromRows(rows),
  })
  const save = useMutation({
    mutationFn: () => api.put<LdapConfig>('/api/auth/ldap/config', payload()),
    onSuccess: () => {
      toast.success('LDAP settings saved')
      void qc.invalidateQueries({ queryKey: ['ldap-config'] })
      void qc.invalidateQueries({ queryKey: ['auth-providers'] })
    },
    onError: (e) => toast.error('Could not save', errorMessage(e)),
  })
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message?: string; bound_as?: string; users_found?: number }>('/api/auth/ldap/test', payload()),
  })
  const set = <K extends keyof LdapConfig>(k: K, v: LdapConfig[K]) => setForm((f) => ({ ...f, [k]: v }))
  const setAttr = (k: keyof LdapConfig['attribute_map'], v: string) => setForm((f) => ({ ...f, attribute_map: { ...f.attribute_map, [k]: v } }))
  const errors = validateRows(rows)
  const canSave = form.url.trim() && form.base_dn.trim() && Object.keys(errors).length === 0

  return (
    <div className="flex flex-col gap-4">
      <section className="panel grid gap-3 p-4 sm:grid-cols-2">
        <div className="sm:col-span-2 flex items-center justify-between">
          <h2 className="font-semibold">Directory</h2>
          <Toggle checked={form.enabled} onChange={(v) => set('enabled', v)} label="Enabled" />
        </div>
        <Field label="Button label" hint="Shown on the sign-in page">
          <Input value={form.display_name} onChange={(e) => set('display_name', e.target.value)} placeholder="Company directory" />
        </Field>
        <Field label="Server URL" tip="Use ldaps://, or ldap:// with StartTLS">
          <Input value={form.url} onChange={(e) => set('url', e.target.value)} placeholder="ldaps://ldap.example.com:636" className="mono" />
        </Field>
        <Field label="Bind DN">
          <Input value={form.bind_dn} onChange={(e) => set('bind_dn', e.target.value)} placeholder="cn=console,ou=service,dc=example,dc=com" className="mono" />
        </Field>
        <Field label="Bind password" hint={initial.bind_password_set ? 'Leave empty to keep the stored password' : undefined}>
          <Input type="password" autoComplete="new-password" value={form.bind_password ?? ''} onChange={(e) => set('bind_password', e.target.value)} className="mono" />
        </Field>
        <Field label="Base DN">
          <Input value={form.base_dn} onChange={(e) => set('base_dn', e.target.value)} placeholder="ou=people,dc=example,dc=com" className="mono" />
        </Field>
        <Field label="User filter" tip="{login} is replaced by the typed login">
          <Input value={form.user_filter} onChange={(e) => set('user_filter', e.target.value)} className="mono" />
        </Field>
        <Field label="Attributes" tip="Email, display name, groups">
          <div className="flex gap-2">
            <Input value={form.attribute_map.email} onChange={(e) => setAttr('email', e.target.value)} placeholder="mail" className="mono" />
            <Input value={form.attribute_map.name} onChange={(e) => setAttr('name', e.target.value)} placeholder="displayName" className="mono" />
            <Input value={form.attribute_map.groups} onChange={(e) => setAttr('groups', e.target.value)} placeholder="memberOf" className="mono" />
          </div>
        </Field>
        <Field label="Allowed email domains" tip="Comma separated; empty allows any">
          <Input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com" className="mono" />
        </Field>
        <div className="sm:col-span-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Toggle checked={form.starttls} onChange={(v) => set('starttls', v)} label="StartTLS (ldap:// only)" />
          <Toggle checked={form.group_short_names} onChange={(v) => set('group_short_names', v)} label="Match groups by CN" />
          <Toggle checked={form.auto_provision} onChange={(v) => set('auto_provision', v)} label="Auto-create accounts" />
          <div>
            <div className="eyebrow mb-1">Default role</div>
            <DefaultRole value={form.default_role} onChange={(v) => set('default_role', v)} />
          </div>
        </div>
        <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
          <Button size="sm" icon={<FlaskConical size={13} />} onClick={() => test.mutate()} loading={test.isPending} disabled={!form.url.trim()} title="Binds and runs the user filter once">
            Test connection
          </Button>
          {test.data && (
            <span className={cx('text-[12px]', test.data.ok ? 'text-ink-muted' : 'text-danger')} data-testid="ldap-test-result">
              {test.data.ok ? `OK — bound as ${test.data.bound_as ?? form.bind_dn}${test.data.users_found !== undefined ? `, ${test.data.users_found} users visible` : ''}` : test.data.message ?? 'Failed'}
            </span>
          )}
          {test.isError && <span className="text-[12px] text-danger">{errorMessage(test.error)}</span>}
        </div>
      </section>

      <section className="panel p-4">
        <h2 className="mb-3 flex items-center gap-1.5 font-semibold">
          Group mapping
          <InfoTip text="memberOf groups; rules run top to bottom, every match applies" />
        </h2>
        <MappingEditor rows={rows} dispatch={dispatch} syncMode={form.sync_mode} onSyncMode={(m: SyncMode) => set('sync_mode', m)} groups={groups} defaultRole={form.default_role} provider="ldap" />
      </section>

      <div className="flex justify-end">
        <Button variant="primary" icon={<Save size={14} />} loading={save.isPending} disabled={!canSave} onClick={() => save.mutate()} data-testid="ldap-save">
          Save LDAP settings
        </Button>
      </div>
    </div>
  )
}

function DefaultRole({ value, onChange }: { value: MappedRole | 'none'; onChange: (v: MappedRole | 'none') => void }) {
  return (
    <Select<MappedRole | 'none'>
      value={value}
      onChange={onChange}
      aria-label="Default role"
      className="w-full"
      options={[
        { value: 'operator', label: 'Operator', description: 'Can be granted device groups' },
        { value: 'admin', label: 'Admin', description: 'Everyone from this IdP becomes an admin — rarely what you want' },
        { value: 'none', label: 'No access', description: 'Users without a matching rule are rejected' },
      ]}
    />
  )
}
