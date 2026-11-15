// Group policy: a partial agent config written to every device of a group (`PATCH /api/groups/:id/config`).
import type { AgentConfig } from '@/protocol'

/** Starting values of the policy form (mirrors `AgentConfig::default()`); only changed keys are sent. */
export const AGENT_CONFIG_DEFAULTS: AgentConfig = {
  display_name: '',
  mode: 'unattended',
  heartbeat_interval_s: 15,
  ice_servers: [],
  max_fps: 60,
  max_bitrate_kbps: 8000,
  preferred_codec: 'h265',
  allow_input: true,
  allow_clipboard: true,
  approval_timeout_s: 60,
  allow_file_transfer: true,
  allow_audio: true,
  allow_annotations: true,
  allow_privacy_screen: false,
}

export type PolicyPatch = Partial<AgentConfig>

/** Short labels for the "changed" summary. */
export const POLICY_LABEL: Partial<Record<keyof AgentConfig, string>> = {
  mode: 'Access mode',
  approval_timeout_s: 'Approval timeout',
  allow_input: 'Mouse & keyboard',
  allow_clipboard: 'Clipboard',
  allow_file_transfer: 'File transfer',
  transfer_dir: 'Upload folder',
  allow_audio: 'Audio',
  allow_annotations: 'Annotations',
  allow_privacy_screen: 'Privacy screen',
  max_fps: 'Frame rate',
  max_bitrate_kbps: 'Bitrate',
  preferred_codec: 'Codec',
  heartbeat_interval_s: 'Heartbeat',
}

/** Request body: changed keys only; a cleared upload folder is sent as `""` (back to the agent default). */
export function policyPayload(patch: PolicyPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'display_name') continue
    out[k] = k === 'transfer_dir' && v === undefined ? '' : v
  }
  return out
}

export function changedLabels(patch: PolicyPatch): string[] {
  return (Object.keys(patch) as (keyof AgentConfig)[]).filter((k) => k !== 'display_name').map((k) => POLICY_LABEL[k] ?? k)
}
