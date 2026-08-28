import type { IceCandidate, IceServer } from '@/protocol'

export interface CodecLike {
  mimeType: string
  clockRate?: number
  sdpFmtpLine?: string
  channels?: number
}

/**
 * Order receive codecs: every H.265 entry first, then H.264, then everything else,
 * preserving the browser's relative order inside each group. RTX/RED/ULPFEC helpers
 * stay behind the codecs they belong to.
 */
export function preferCodecs<T extends CodecLike>(codecs: T[]): T[] {
  const rank = (c: T) => {
    const m = c.mimeType.toLowerCase()
    if (m === 'video/h265' || m === 'video/hevc') return 0
    if (m === 'video/h264') return 1
    if (m === 'video/rtx' || m === 'video/red' || m === 'video/ulpfec' || m === 'video/flexfec-03') return 3
    return 2
  }
  return codecs
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c)
}

/** Whether this browser can receive H.265 over WebRTC. */
export function browserSupportsH265(): boolean {
  const caps = typeof RTCRtpReceiver !== 'undefined' ? RTCRtpReceiver.getCapabilities?.('video') : null
  return !!caps?.codecs.some((c) => /^video\/(h265|hevc)$/i.test(c.mimeType))
}

/** Apply the H.265-first preference to a transceiver where supported (no-op otherwise). */
export function applyCodecPreferences(transceiver: RTCRtpTransceiver): 'h265' | 'h264' | 'unknown' {
  if (typeof RTCRtpReceiver === 'undefined' || !RTCRtpReceiver.getCapabilities) return 'unknown'
  const caps = RTCRtpReceiver.getCapabilities('video')
  if (!caps || typeof transceiver.setCodecPreferences !== 'function') return 'unknown'
  const ordered = preferCodecs(caps.codecs)
  try {
    transceiver.setCodecPreferences(ordered)
  } catch {
    return 'unknown'
  }
  const first = ordered[0]?.mimeType.toLowerCase()
  return first === 'video/h265' || first === 'video/hevc' ? 'h265' : 'h264'
}

export function toRtcIceServers(servers: IceServer[]): RTCIceServer[] {
  return servers.map((s) => ({
    urls: s.urls,
    username: s.username ?? undefined,
    credential: s.credential ?? undefined,
  }))
}

export function toRtcCandidate(c: IceCandidate): RTCIceCandidateInit {
  return {
    candidate: c.candidate,
    sdpMid: c.sdpMid ?? null,
    sdpMLineIndex: c.sdpMLineIndex ?? null,
    usernameFragment: c.usernameFragment ?? null,
  }
}

export function fromRtcCandidate(c: RTCIceCandidate): IceCandidate {
  return {
    candidate: c.candidate,
    sdpMid: c.sdpMid ?? undefined,
    sdpMLineIndex: c.sdpMLineIndex ?? undefined,
    usernameFragment: c.usernameFragment ?? undefined,
  }
}

export interface RtcStatsSnapshot {
  rttMs?: number
  fps?: number
  bitrateKbps?: number
  width?: number
  height?: number
  packetsLost?: number
  jitterMs?: number
  codec?: string
  candidateType?: string
}

/** Pick the interesting numbers out of `getStats()`; bitrate is derived from the previous sample. */
export async function readStats(
  pc: RTCPeerConnection,
  prev?: { bytes: number; at: number },
): Promise<{ snapshot: RtcStatsSnapshot; sample: { bytes: number; at: number } }> {
  const report = await pc.getStats()
  const snapshot: RtcStatsSnapshot = {}
  let bytes = prev?.bytes ?? 0
  const at = performance.now()
  const codecs = new Map<string, string>()
  report.forEach((s) => {
    if (s.type === 'codec') codecs.set(s.id, (s as { mimeType: string }).mimeType)
  })
  report.forEach((s) => {
    if (s.type === 'inbound-rtp' && (s as { kind?: string }).kind === 'video') {
      const r = s as {
        bytesReceived?: number
        framesPerSecond?: number
        frameWidth?: number
        frameHeight?: number
        packetsLost?: number
        jitter?: number
        codecId?: string
      }
      bytes = r.bytesReceived ?? bytes
      snapshot.fps = r.framesPerSecond
      snapshot.width = r.frameWidth
      snapshot.height = r.frameHeight
      snapshot.packetsLost = r.packetsLost
      snapshot.jitterMs = r.jitter !== undefined ? r.jitter * 1000 : undefined
      snapshot.codec = r.codecId ? codecs.get(r.codecId) : undefined
    }
    if (s.type === 'candidate-pair' && (s as { nominated?: boolean; state?: string }).nominated) {
      const p = s as { currentRoundTripTime?: number; localCandidateId?: string }
      if (p.currentRoundTripTime !== undefined) snapshot.rttMs = p.currentRoundTripTime * 1000
      if (p.localCandidateId) {
        const local = report.get(p.localCandidateId) as { candidateType?: string } | undefined
        snapshot.candidateType = local?.candidateType
      }
    }
  })
  if (prev && at > prev.at) {
    snapshot.bitrateKbps = ((bytes - prev.bytes) * 8) / ((at - prev.at) / 1000) / 1000
  }
  return { snapshot, sample: { bytes, at } }
}
