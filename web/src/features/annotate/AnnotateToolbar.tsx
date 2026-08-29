import { Eraser, Pencil, Radio, Undo2, X } from 'lucide-react'
import { cx } from '@/components/ui'
import { ANNOTATE_COLORS, type StrokeWidth } from './model'
import { useAnnotate } from './store'

/**
 * Floating tool strip shown while annotate mode is on. Sits at the top of the surface so it
 * never covers the HUD; every control is keyboard reachable.
 */
export function AnnotateToolbar({ onUndo, onClear, onExit }: { onUndo: () => void; onClear: () => void; onExit: () => void }) {
  const tool = useAnnotate((s) => s.tool)
  const color = useAnnotate((s) => s.color)
  const width = useAnnotate((s) => s.width)
  const setTool = useAnnotate((s) => s.setTool)
  const setColor = useAnnotate((s) => s.setColor)
  const setWidth = useAnnotate((s) => s.setWidth)

  return (
    <div className="pointer-events-auto flex items-center gap-1 rounded-lg border border-white/10 bg-[#0e1116]/95 px-1.5 py-1 text-[#e6e9ef] shadow-pop backdrop-blur" role="toolbar" aria-label="Annotation tools" data-testid="annotate-toolbar">
      <span className="mono px-1.5 text-[10.5px] tracking-wide text-[#9aa3b2] uppercase">Annotate</span>
      <ToolButton active={tool === 'pen'} onClick={() => setTool('pen')} title="Pen">
        <Pencil size={14} />
      </ToolButton>
      <ToolButton active={tool === 'laser'} onClick={() => setTool('laser')} title="Laser pointer">
        <Radio size={14} />
      </ToolButton>
      <span className="mx-1 h-5 w-px bg-white/10" />
      <div className="flex items-center gap-1" role="radiogroup" aria-label="Colour">
        {ANNOTATE_COLORS.map((c) => (
          <button
            key={c.id}
            role="radio"
            aria-checked={color === c.id}
            aria-label={c.label}
            title={c.label}
            onClick={() => setColor(c.id)}
            className={cx('size-5 rounded-full border-2 transition-transform', color === c.id ? 'scale-110 border-white' : 'border-transparent hover:scale-105')}
            style={{ backgroundColor: c.value }}
          />
        ))}
      </div>
      <span className="mx-1 h-5 w-px bg-white/10" />
      <div className="flex items-center gap-0.5" role="radiogroup" aria-label="Line width">
        {(['thin', 'thick'] as StrokeWidth[]).map((w) => (
          <button
            key={w}
            role="radio"
            aria-checked={width === w}
            aria-label={w === 'thin' ? 'Thin line' : 'Thick line'}
            title={w === 'thin' ? 'Thin line' : 'Thick line'}
            onClick={() => setWidth(w)}
            disabled={tool === 'laser'}
            className={cx('flex h-7 w-7 items-center justify-center rounded-md disabled:opacity-40', width === w ? 'bg-[#6cb6ff]/20' : 'hover:bg-white/10')}
          >
            <span className="block rounded-full bg-current" style={{ width: 14, height: w === 'thin' ? 2 : 5 }} />
          </button>
        ))}
      </div>
      <span className="mx-1 h-5 w-px bg-white/10" />
      <ToolButton onClick={onUndo} title="Undo">
        <Undo2 size={14} />
      </ToolButton>
      <ToolButton onClick={onClear} title="Clear all annotations">
        <Eraser size={14} />
      </ToolButton>
      <ToolButton onClick={onExit} title="Leave annotate mode (Esc)">
        <X size={14} />
      </ToolButton>
    </div>
  )
}

function ToolButton({ children, onClick, title, active }: { children: React.ReactNode; onClick: () => void; title: string; active?: boolean }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} aria-pressed={active} className={cx('rounded-md p-1.5 transition-colors', active ? 'bg-[#6cb6ff]/20 text-[#6cb6ff]' : 'text-[#c8ced8] hover:bg-white/10 hover:text-white')}>
      {children}
    </button>
  )
}
