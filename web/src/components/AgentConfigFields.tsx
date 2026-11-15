import type { AgentConfig } from '@/protocol'
import { Field, Input, Select, Toggle, cx } from './ui'

export type SetConfig = <K extends keyof AgentConfig>(k: K, v: AgentConfig[K]) => void

/** The agent settings controls, shared by a device's settings and a group policy. */
export function AgentConfigFields({ cfg, set, hideDisplayName }: { cfg: AgentConfig; set: SetConfig; hideDisplayName?: boolean }) {
  return (
    <>
      <div className="eyebrow">Access</div>
      <div className="rounded-md border border-line bg-raised p-2.5">
        <div className="mb-1.5 font-medium">Access mode</div>
        <div className="flex gap-1">
          {(['unattended', 'help_me'] as const).map((m) => (
            <button
              type="button"
              key={m}
              onClick={() => set('mode', m)}
              className={cx(
                'flex-1 rounded-md border px-2 py-1.5 text-left',
                cfg.mode === m ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-raised',
              )}
            >
              <div className="text-[12.5px] font-medium">{m === 'unattended' ? 'Unattended' : 'Help me'}</div>
              <div className="text-[11.5px] text-ink-muted">{m === 'unattended' ? 'Connect any time' : 'User approves each session'}</div>
            </button>
          ))}
        </div>
      </div>
      {cfg.mode === 'help_me' && (
        <Field label="Approval timeout (seconds)">
          <Input type="number" min={10} max={600} value={cfg.approval_timeout_s} onChange={(e) => set('approval_timeout_s', Number(e.target.value))} />
        </Field>
      )}
      <div className="eyebrow pt-2">Permissions</div>
      <div className="flex flex-col gap-2">
        <Toggle checked={cfg.allow_input} onChange={(v) => set('allow_input', v)} label="Allow mouse & keyboard" />
        <Toggle checked={cfg.allow_clipboard} onChange={(v) => set('allow_clipboard', v)} label="Allow clipboard sync" />
        <Toggle checked={cfg.allow_file_transfer} onChange={(v) => set('allow_file_transfer', v)} label="Allow file transfer" />
        <Toggle checked={cfg.allow_audio} onChange={(v) => set('allow_audio', v)} label="Allow audio" />
        <Toggle checked={cfg.allow_annotations ?? true} onChange={(v) => set('allow_annotations', v)} label="Allow on-screen annotations" tip="Works even while input control is off" />
        <Toggle
          checked={cfg.allow_privacy_screen ?? false}
          onChange={(v) => set('allow_privacy_screen', v)}
          label="Allow privacy screen"
          tip="Operators with manage permission can hide the device's displays during a session. The person at the device can always lift it."
        />
      </div>
      {cfg.allow_file_transfer && (
        <Field label="Upload folder">
          <Input value={cfg.transfer_dir ?? ''} placeholder="~/Downloads/RemoteAgent" onChange={(e) => set('transfer_dir', e.target.value.trim() ? e.target.value : undefined)} />
        </Field>
      )}
      <div className="eyebrow pt-2">Video</div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Max frame rate">
          <Select value={cfg.max_fps} onChange={(v) => set('max_fps', v)} options={[15, 30, 60].map((v) => ({ value: v, label: `${v} fps` }))} />
        </Field>
        <Field label="Max bitrate">
          <Select
            value={cfg.max_bitrate_kbps}
            onChange={(v) => set('max_bitrate_kbps', v)}
            options={[2000, 4000, 8000, 15000, 30000].map((v) => ({ value: v, label: `${v / 1000} Mb/s` }))}
          />
        </Field>
      </div>
      <Field label="Preferred codec" tip="H.265 needs hardware support on both ends; H.264 is the fallback">
        <Select
          value={cfg.preferred_codec}
          onChange={(v) => set('preferred_codec', v)}
          options={[
            { value: 'h265', label: 'H.265 (HEVC)' },
            { value: 'h264', label: 'H.264' },
          ]}
        />
      </Field>
      <div className="eyebrow pt-2">Agent</div>
      <Field label="Heartbeat (seconds)">
        <Input type="number" min={5} max={300} value={cfg.heartbeat_interval_s} onChange={(e) => set('heartbeat_interval_s', Number(e.target.value))} />
      </Field>
      {!hideDisplayName && (
        <Field label="Display name" tip="Shown on the device">
          <Input value={cfg.display_name} onChange={(e) => set('display_name', e.target.value)} />
        </Field>
      )}
    </>
  )
}
