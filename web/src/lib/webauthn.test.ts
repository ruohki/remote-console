import { describe, expect, it } from 'vitest'
import { base64urlToBuffer, bufferToBase64url, friendlyWebAuthnError, prepareCreationOptions, prepareRequestOptions, serializeCredential } from './webauthn'

describe('base64url helpers', () => {
  it('round-trips bytes without padding', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const s = bufferToBase64url(bytes)
    expect(s).not.toMatch(/[+/=]/)
    expect(new Uint8Array(base64urlToBuffer(s))).toEqual(bytes)
  })

  it('decodes padded and unpadded input alike', () => {
    expect(new Uint8Array(base64urlToBuffer('AQID'))).toEqual(new Uint8Array([1, 2, 3]))
    expect(new Uint8Array(base64urlToBuffer('AQI'))).toEqual(new Uint8Array([1, 2]))
    expect(new Uint8Array(base64urlToBuffer('AQI='))).toEqual(new Uint8Array([1, 2]))
  })

  it('uses url-safe characters', () => {
    // 0xfb 0xff → "-_8" in base64url ("+/8=" in base64)
    expect(bufferToBase64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8')
  })
})

describe('option preparation', () => {
  it('decodes creation options into ArrayBuffers and keeps the rest', () => {
    const opts = prepareCreationOptions({
      publicKey: {
        rp: { id: 'console.example', name: 'Remote' },
        user: { id: bufferToBase64url(new Uint8Array([9, 9])), name: 'a@b', displayName: 'A' },
        challenge: bufferToBase64url(new Uint8Array([1, 2, 3])),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        excludeCredentials: [{ type: 'public-key', id: bufferToBase64url(new Uint8Array([7])), transports: ['usb'] }],
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
        attestation: 'none',
      },
    })
    const pk = opts.publicKey!
    expect(new Uint8Array(pk.challenge as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]))
    expect(new Uint8Array(pk.user.id as ArrayBuffer)).toEqual(new Uint8Array([9, 9]))
    expect(new Uint8Array(pk.excludeCredentials![0]!.id as ArrayBuffer)).toEqual(new Uint8Array([7]))
    expect(pk.excludeCredentials![0]!.transports).toEqual(['usb'])
    expect(pk.authenticatorSelection?.residentKey).toBe('preferred')
    // no attachment restriction so roaming security keys keep working
    expect(pk.authenticatorSelection?.authenticatorAttachment).toBeUndefined()
  })

  it('decodes request options and passes mediation through', () => {
    const opts = prepareRequestOptions({
      publicKey: { challenge: 'AQID', rpId: 'console.example', userVerification: 'required', allowCredentials: [] },
      mediation: 'conditional',
    })
    expect(new Uint8Array(opts.publicKey!.challenge as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]))
    expect(opts.publicKey!.allowCredentials).toEqual([])
    expect(opts.mediation).toBe('conditional')
  })
})

describe('credential serialisation', () => {
  it('encodes an assertion response', () => {
    const cred = {
      id: 'abc',
      rawId: new Uint8Array([1]).buffer,
      type: 'public-key',
      authenticatorAttachment: 'cross-platform',
      getClientExtensionResults: () => ({}),
      response: {
        clientDataJSON: new Uint8Array([2]).buffer,
        authenticatorData: new Uint8Array([3]).buffer,
        signature: new Uint8Array([4]).buffer,
        userHandle: null,
      },
    } as unknown as PublicKeyCredential
    const json = serializeCredential(cred)
    expect(json.rawId).toBe('AQ')
    expect(json.response.signature).toBe('BA')
    expect(json.response.userHandle).toBeNull()
    expect(json.authenticatorAttachment).toBe('cross-platform')
  })

  it('encodes an attestation response with transports', () => {
    const cred = {
      id: 'abc',
      rawId: new Uint8Array([1]).buffer,
      type: 'public-key',
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
      response: {
        clientDataJSON: new Uint8Array([2]).buffer,
        attestationObject: new Uint8Array([5, 6]).buffer,
        getTransports: () => ['internal', 'hybrid'],
      },
    } as unknown as PublicKeyCredential
    const json = serializeCredential(cred)
    expect(json.response.attestationObject).toBe('BQY')
    expect(json.response.transports).toEqual(['internal', 'hybrid'])
    expect(json.clientExtensionResults).toEqual({ credProps: { rk: true } })
  })
})

describe('friendly errors', () => {
  it('maps DOMException names', () => {
    expect(friendlyWebAuthnError({ name: 'NotAllowedError' }).kind).toBe('cancelled')
    expect(friendlyWebAuthnError({ name: 'InvalidStateError' }).kind).toBe('already_registered')
    expect(friendlyWebAuthnError({ name: 'SecurityError' }).kind).toBe('security')
    expect(friendlyWebAuthnError(new Error('boom')).message).toBe('boom')
  })
})
