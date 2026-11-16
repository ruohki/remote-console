import { useId, useState } from 'react'
import { Dices, Eye, EyeOff } from 'lucide-react'
import { generatePassword } from '@/lib/password'
import { Button, CopyButton, Input } from './ui'

/**
 * A password an admin sets for someone else. Visible by default (what is handed over is what was
 * typed — a masked field hides typos), ignored by browsers and password managers (they would
 * fill in the admin's own password), with a generator and a copy button.
 */
export function PasswordSetField({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const id = useId()
  const [shown, setShown] = useState(true)
  const edgeSpace = value.length > 0 && value.trim() !== value
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[12px] font-medium text-ink-muted">
        Password
      </label>
      <div className="flex gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Input
            id={id}
            type={shown ? 'text' : 'password'}
            required
            minLength={10}
            autoFocus={autoFocus}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="mono pr-8"
            aria-describedby={`${id}-hint`}
          />
          <button
            type="button"
            onClick={() => setShown((s) => !s)}
            className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-ink-faint hover:text-ink"
            title={shown ? 'Hide' : 'Show'}
            aria-label={shown ? 'Hide password' : 'Show password'}
          >
            {shown ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <Button
          type="button"
          icon={<Dices size={14} />}
          onClick={() => {
            onChange(generatePassword())
            setShown(true)
          }}
          title="Generate a strong password"
        >
          Generate
        </Button>
        <CopyButton text={value} size="md" />
      </div>
      <span id={`${id}-hint`} className={edgeSpace ? 'mt-1 block text-[11.5px] text-warn' : 'mt-1 block text-[11.5px] text-ink-faint'}>
        {edgeSpace ? 'The space at the start or end is removed.' : 'At least 10 characters.'}
      </span>
    </div>
  )
}
