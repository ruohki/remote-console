/**
 * WebAuthn helpers: the server speaks the JSON encoding of `webauthn-rs` (all binary fields
 * base64url without padding). The browser API wants `ArrayBuffer`s, so options are decoded on
 * the way in and credentials encoded on the way out. Works for platform passkeys and roaming
 * FIDO2 keys (YubiKey etc.) alike — we never restrict `authenticatorAttachment`.
 */

export function base64urlToBuffer(s: string): ArrayBuffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

export function bufferToBase64url(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** True when the browser can run WebAuthn ceremonies at all (secure context + API present). */
export function webauthnSupported(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials && window.isSecureContext !== false
}

/** Platform authenticator (Touch ID, Windows Hello…) available — affects wording only. */
export async function platformAuthenticatorAvailable(): Promise<boolean> {
  try {
    return webauthnSupported() && (await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
  } catch {
    return false
  }
}

/* ───────────── option decoding (server JSON → browser) ───────────── */

interface JsonCredentialDescriptor {
  type: string
  id: string
  transports?: string[]
}

export interface JsonCreationOptions {
  publicKey: {
    rp: PublicKeyCredentialRpEntity
    user: { id: string; name: string; displayName: string }
    challenge: string
    pubKeyCredParams: PublicKeyCredentialParameters[]
    timeout?: number
    excludeCredentials?: JsonCredentialDescriptor[]
    authenticatorSelection?: AuthenticatorSelectionCriteria
    attestation?: AttestationConveyancePreference
    extensions?: Record<string, unknown>
  }
}

export interface JsonRequestOptions {
  publicKey: {
    challenge: string
    timeout?: number
    rpId?: string
    allowCredentials?: JsonCredentialDescriptor[]
    userVerification?: UserVerificationRequirement
    extensions?: Record<string, unknown>
  }
  mediation?: CredentialMediationRequirement
}

function descriptors(list?: JsonCredentialDescriptor[]): PublicKeyCredentialDescriptor[] | undefined {
  return list?.map((d) => ({
    type: 'public-key',
    id: base64urlToBuffer(d.id),
    transports: d.transports as AuthenticatorTransport[] | undefined,
  }))
}

export function prepareCreationOptions(json: JsonCreationOptions): CredentialCreationOptions {
  const pk = json.publicKey
  return {
    publicKey: {
      rp: pk.rp,
      user: { id: base64urlToBuffer(pk.user.id), name: pk.user.name, displayName: pk.user.displayName },
      challenge: base64urlToBuffer(pk.challenge),
      pubKeyCredParams: pk.pubKeyCredParams,
      timeout: pk.timeout,
      excludeCredentials: descriptors(pk.excludeCredentials),
      authenticatorSelection: pk.authenticatorSelection,
      attestation: pk.attestation,
      extensions: pk.extensions as AuthenticationExtensionsClientInputs | undefined,
    },
  }
}

export function prepareRequestOptions(json: JsonRequestOptions): CredentialRequestOptions {
  const pk = json.publicKey
  return {
    publicKey: {
      challenge: base64urlToBuffer(pk.challenge),
      timeout: pk.timeout,
      rpId: pk.rpId,
      allowCredentials: descriptors(pk.allowCredentials),
      userVerification: pk.userVerification,
      extensions: pk.extensions as AuthenticationExtensionsClientInputs | undefined,
    },
    mediation: json.mediation,
  }
}

/* ───────────── credential encoding (browser → server JSON) ───────────── */

export interface JsonPublicKeyCredential {
  id: string
  rawId: string
  type: string
  authenticatorAttachment?: string | null
  clientExtensionResults: Record<string, unknown>
  response: Record<string, unknown>
}

export function serializeCredential(cred: PublicKeyCredential): JsonPublicKeyCredential {
  const r = cred.response
  const response: Record<string, unknown> = { clientDataJSON: bufferToBase64url(r.clientDataJSON) }
  if ('attestationObject' in r) {
    const a = r as AuthenticatorAttestationResponse
    response.attestationObject = bufferToBase64url(a.attestationObject)
    // Optional helpers (Safari lacks some of them).
    if (typeof a.getTransports === 'function') response.transports = a.getTransports()
  } else {
    const a = r as AuthenticatorAssertionResponse
    response.authenticatorData = bufferToBase64url(a.authenticatorData)
    response.signature = bufferToBase64url(a.signature)
    response.userHandle = a.userHandle ? bufferToBase64url(a.userHandle) : null
  }
  return {
    id: cred.id,
    rawId: bufferToBase64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: (cred as PublicKeyCredential & { authenticatorAttachment?: string | null }).authenticatorAttachment ?? null,
    clientExtensionResults: cred.getClientExtensionResults() as Record<string, unknown>,
    response,
  }
}

/* ───────────── ceremonies ───────────── */

export async function createCredential(json: JsonCreationOptions): Promise<JsonPublicKeyCredential> {
  const cred = (await navigator.credentials.create(prepareCreationOptions(json))) as PublicKeyCredential | null
  if (!cred) throw new WebAuthnError('cancelled', 'No credential was created.')
  return serializeCredential(cred)
}

export async function getCredential(json: JsonRequestOptions): Promise<JsonPublicKeyCredential> {
  const cred = (await navigator.credentials.get(prepareRequestOptions(json))) as PublicKeyCredential | null
  if (!cred) throw new WebAuthnError('cancelled', 'No credential was returned.')
  return serializeCredential(cred)
}

/* ───────────── errors ───────────── */

export type WebAuthnErrorKind = 'cancelled' | 'already_registered' | 'unsupported' | 'security' | 'timeout' | 'unknown'

export class WebAuthnError extends Error {
  readonly kind: WebAuthnErrorKind
  constructor(kind: WebAuthnErrorKind, message: string) {
    super(message)
    this.name = 'WebAuthnError'
    this.kind = kind
  }
}

/** Map DOMExceptions from the WebAuthn API to something a person can act on. */
export function friendlyWebAuthnError(err: unknown): WebAuthnError {
  if (err instanceof WebAuthnError) return err
  const name = (err as { name?: string } | null)?.name ?? ''
  switch (name) {
    case 'NotAllowedError':
      return new WebAuthnError('cancelled', 'The request was cancelled or timed out. Touch your security key or confirm with your device when prompted, then try again.')
    case 'InvalidStateError':
      return new WebAuthnError('already_registered', 'This security key or passkey is already registered for your account.')
    case 'NotSupportedError':
      return new WebAuthnError('unsupported', 'This browser or authenticator does not support the requested passkey options.')
    case 'SecurityError':
      return new WebAuthnError('security', 'Passkeys only work on the console’s configured public URL over HTTPS (or localhost).')
    case 'AbortError':
      return new WebAuthnError('cancelled', 'The request was aborted.')
    case 'TimeoutError':
      return new WebAuthnError('timeout', 'The request timed out. Try again.')
    default:
      return new WebAuthnError('unknown', (err as Error | null)?.message || 'The passkey operation failed.')
  }
}
