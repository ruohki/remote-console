import { describe, expect, it } from 'vitest'
import { preferCodecs, toRtcCandidate, fromRtcCandidate } from './webrtc'

// A realistic Chrome capability list (order as reported by the browser).
const CHROME = [
  { mimeType: 'video/VP8', clockRate: 90000 },
  { mimeType: 'video/rtx', clockRate: 90000 },
  { mimeType: 'video/VP9', clockRate: 90000, sdpFmtpLine: 'profile-id=0' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
  { mimeType: 'video/H265', clockRate: 90000, sdpFmtpLine: 'level-id=93;profile-id=1;tier-flag=0;tx-mode=SRST' },
  { mimeType: 'video/AV1', clockRate: 90000 },
  { mimeType: 'video/red', clockRate: 90000 },
  { mimeType: 'video/ulpfec', clockRate: 90000 },
]

describe('preferCodecs', () => {
  it('puts H265 first, then H264, then the rest, then helpers', () => {
    const out = preferCodecs(CHROME).map((c) => c.mimeType)
    expect(out.slice(0, 3)).toEqual(['video/H265', 'video/H264', 'video/H264'])
    expect(out.indexOf('video/VP8')).toBeGreaterThan(out.lastIndexOf('video/H264'))
    expect(out.slice(-3)).toEqual(['video/rtx', 'video/red', 'video/ulpfec'])
  })

  it('keeps the relative order of the H264 profiles', () => {
    const out = preferCodecs(CHROME).filter((c) => c.mimeType === 'video/H264')
    expect(out[0]?.sdpFmtpLine).toContain('42001f')
    expect(out[1]?.sdpFmtpLine).toContain('42e01f')
  })

  it('works when H265 is absent', () => {
    const out = preferCodecs(CHROME.filter((c) => c.mimeType !== 'video/H265')).map((c) => c.mimeType)
    expect(out[0]).toBe('video/H264')
  })

  it('is case-insensitive and treats HEVC as H265', () => {
    const out = preferCodecs([{ mimeType: 'video/vp8' }, { mimeType: 'video/HEVC' }, { mimeType: 'video/h264' }]).map((c) => c.mimeType)
    expect(out).toEqual(['video/HEVC', 'video/h264', 'video/vp8'])
  })

  it('returns a new array and does not mutate the input', () => {
    const input = [...CHROME]
    const out = preferCodecs(input)
    expect(out).not.toBe(input)
    expect(input.map((c) => c.mimeType)).toEqual(CHROME.map((c) => c.mimeType))
  })
})

describe('candidate conversion', () => {
  it('round-trips the browser field names', () => {
    const init = toRtcCandidate({ candidate: 'candidate:1 1 udp 2 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 })
    expect(init).toEqual({ candidate: 'candidate:1 1 udp 2 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null })
    const back = fromRtcCandidate({ candidate: init.candidate!, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abc' } as RTCIceCandidate)
    expect(back).toEqual({ candidate: init.candidate, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abc' })
  })
})
