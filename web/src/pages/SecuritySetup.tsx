import { type FormEvent, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useMutation } from '@tanstack/react-query'
import { Check, Copy, Download, Fingerprint, Smartphone } from 'lucide-react'
import { useAuth } from '@/store/auth'
import { AuthShell } from './Login'
import { Button, Field, Input } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import type { Passkey, TotpSetup } from '@/lib/types'
import { toast } from '@/lib/toast'
import { createCredential, friendlyWebAuthnError, platformAuthenticatorAvailable, webauthnSupported, type JsonCreationOptions } from '@/lib/webauthn'

type Step = 'choose' | 'totp' | 'totp_codes' | 'passkey' | 'done'

/**
 * Forced second-factor enrollment (`two_factor_required`): the router keeps users here until
 * they enabled TOTP or registered a passkey / security key.
 */
export function SecuritySetup() {
  const { user, refresh, logout } = useAuth()
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('choose')
  const [platformAvail, setPlatformAvail] = useState(false)
  useEffect(() => {
    void platformAuthenticatorAvailable().then(setPlatformAvail)
  }, [])

  const finish = async () => {
    const u = await refresh()
    setStep('done')
    toast.success('Two-factor authentication is set up')
    navigate(u?.two_factor_required ? '/security/setup' : '/devices', { replace: true })
  }

  const required = !!user?.two_factor_required

  return (
    <AuthShell
      title={required ? 'Set up two-factor authentication' : 'Add a second factor'}
      subtitle={
        required
          ? 'Your role requires a second factor before you can use the console. This only takes a minute.'
          : 'Protect your account with an authenticator app or a security key.'
      }
    >
      {step === 'choose' && (
        <div className="flex flex-col gap-2">
          <ChoiceButton
            icon={<Smartphone size={18} />}
            title="Authenticator app"
            detail="Time-based codes from 1Password, Google Authenticator, Microsoft Authenticator, Authy, …"
            onClick={() => setStep('totp')}
            testId="choose-totp"
          />
          <ChoiceButton
            icon={<Fingerprint size={18} />}
            title={platformAvail ? 'Passkey or security key' : 'Security key'}
            detail={
              webauthnSupported()
                ? platformAvail
                  ? 'Touch ID / Windows Hello passkey, or a FIDO2 key such as a YubiKey.'
                  : 'A FIDO2 hardware key such as a YubiKey (USB or NFC).'
                : 'Not available in this browser.'
            }
            disabled={!webauthnSupported()}
            onClick={() => setStep('passkey')}
            testId="choose-passkey"
          />
          <button
            type="button"
            className="mt-2 self-start text-[12.5px] text-ink-muted hover:underline"
            onClick={async () => {
              await logout()
              navigate('/login')
            }}
          >
            Sign out instead
          </button>
        </div>
      )}
      {step === 'totp' && <TotpEnroll onDone={() => setStep('totp_codes')} onBack={() => setStep('choose')} onCodes={(c) => setCodes(c)} />}
      {step === 'totp_codes' && <RecoveryCodes codes={codesRef.current} onDone={finish} />}
      {step === 'passkey' && <PasskeyEnroll onDone={finish} onBack={() => setStep('choose')} />}
      {step === 'done' && <div className="text-ink-muted">Redirecting…</div>}
    </AuthShell>
  )
}

// Recovery codes are shown exactly once; keep them out of React state to avoid re-renders
// leaking them into devtools time-travel — a ref is enough for the single step.
const codesRef = { current: [] as string[] }
function setCodes(c: string[]) {
  codesRef.current = c
}

function ChoiceButton({ icon, title, detail, onClick, disabled, testId }: { icon: React.ReactNode; title: string; detail: string; onClick: () => void; disabled?: boolean; testId?: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className="flex items-start gap-3 rounded-lg border border-line-strong p-3 text-left hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="mt-0.5 text-accent">{icon}</span>
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-[12.5px] text-ink-muted">{detail}</span>
      </span>
    </button>
  )
}

/** QR + secret + code confirmation. Reused by the account security page. */
export function TotpEnroll({ onDone, onBack, onCodes }: { onDone: () => void; onBack?: () => void; onCodes: (codes: string[]) => void }) {
  const [setup, setSetup] = useState<TotpSetup | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [showSecret, setShowSecret] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .post<TotpSetup>('/api/auth/2fa/setup', {})
      .then((s) => !cancelled && setSetup(s))
      .catch((e) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [])

  const enable = useMutation({
    mutationFn: () => api.post<{ recovery_codes: string[] }>('/api/auth/2fa/enable', { code: code.replace(/\s+/g, '') }),
    onSuccess: (r) => {
      onCodes(r.recovery_codes)
      onDone()
    },
    onError: (e) => {
      setError(errorMessage(e) || 'That code is not valid — try the current one.')
      setCode('')
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    enable.mutate()
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <ol className="list-decimal space-y-1 pl-4 text-[12.5px] text-ink-muted">
        <li>Open your authenticator app and scan the code (or enter the key manually).</li>
        <li>Enter the 6-digit code the app shows to confirm.</li>
      </ol>
      <div className="flex items-center justify-center rounded-lg border border-line bg-white p-3" data-testid="totp-qr">
        {setup ? (
          <div className="size-44 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: setup.qr_svg }} />
        ) : error ? (
          <span className="text-danger">{error}</span>
        ) : (
          <span className="text-ink-faint">Generating…</span>
        )}
      </div>
      {setup && (
        <div className="text-[12px] text-ink-muted">
          {showSecret ? (
            <span className="mono select-all break-all text-ink">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</span>
          ) : (
            <button type="button" className="text-accent hover:underline" onClick={() => setShowSecret(true)}>
              Can’t scan? Show the setup key
            </button>
          )}
        </div>
      )}
      <Field label="Code from the app">
        <Input
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,7}"
          placeholder="123 456"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="mono tracking-widest"
          data-testid="totp-code"
          disabled={!setup}
        />
      </Field>
      {error && setup && (
        <div role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
          {error}
        </div>
      )}
      <div className="flex gap-2">
        {onBack && (
          <Button type="button" onClick={onBack}>
            Back
          </Button>
        )}
        <Button type="submit" variant="primary" loading={enable.isPending} disabled={!setup} className="ml-auto">
          Turn on
        </Button>
      </div>
    </form>
  )
}

/** One-time display of recovery codes with a confirmation checkbox. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false)
  const text = codes.join('\n')
  const download = () => {
    const url = URL.createObjectURL(new Blob([`Remote console recovery codes\n\n${text}\n`], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'recovery-codes.txt'
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] text-ink-muted">
        Save these recovery codes somewhere safe. Each works once if you lose access to your authenticator. <b>They are shown only now.</b>
      </p>
      <div className="mono grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-line bg-raised p-3 text-[13px]" data-testid="recovery-codes">
        {codes.map((c) => (
          <span key={c} className="select-all">
            {c}
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Button size="sm" icon={<Copy size={13} />} onClick={() => navigator.clipboard?.writeText(text).then(() => toast.success('Copied'))}>
          Copy
        </Button>
        <Button size="sm" icon={<Download size={13} />} onClick={download}>
          Download
        </Button>
      </div>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} data-testid="codes-saved" />I have saved my recovery codes
      </label>
      <Button variant="primary" disabled={!saved} onClick={onDone} icon={<Check size={14} />} data-testid="codes-done">
        Continue
      </Button>
    </div>
  )
}

/** Name + WebAuthn create ceremony. Reused by the account security page. */
export function PasskeyEnroll({ onDone, onBack, onRegistered }: { onDone: () => void; onBack?: () => void; onRegistered?: (p: Passkey) => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const register = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const options = await api.post<JsonCreationOptions>('/api/auth/passkeys/register/start', { name: name.trim() || 'Security key' })
      const credential = await createCredential(options)
      const pk = await api.post<Passkey>('/api/auth/passkeys/register/finish', { name: name.trim() || 'Security key', credential })
      onRegistered?.(pk)
      toast.success(`“${pk.name}” registered`)
      onDone()
    } catch (err) {
      setError(err instanceof Error && err.name === 'ApiError' ? errorMessage(err) : friendlyWebAuthnError(err).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={register} className="flex flex-col gap-3">
      <p className="text-[12.5px] text-ink-muted">
        Give the key a name you will recognise later, then follow your browser’s prompt: touch the security key (enter its PIN if it has one) or confirm with Touch ID / Windows Hello.
      </p>
      <Field label="Name">
        <Input autoFocus placeholder="YubiKey 5C · MacBook Touch ID" value={name} onChange={(e) => setName(e.target.value)} data-testid="passkey-name" maxLength={60} />
      </Field>
      {error && (
        <div role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
          {error}
        </div>
      )}
      <div className="flex gap-2">
        {onBack && (
          <Button type="button" onClick={onBack}>
            Back
          </Button>
        )}
        <Button type="submit" variant="primary" loading={busy} icon={<Fingerprint size={14} />} className="ml-auto" data-testid="passkey-register">
          Register
        </Button>
      </div>
    </form>
  )
}
