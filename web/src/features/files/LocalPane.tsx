import { useCallback, useMemo, useRef, useState } from 'react'
import { ArrowUpFromLine, ChevronDown, ChevronRight, ChevronUp, CornerLeftUp, Eye, EyeOff, FolderOpen, FolderSearch, Laptop, RefreshCw, Search, ShieldAlert, Square, SquareCheck, SquareMinus, Upload, X } from 'lucide-react'
import { Button, cx } from '@/components/ui'
import { bytes, relativeTime } from '@/lib/format'
import { FileTypeIcon } from './fileIcons'
import { LOCAL_DRAG_TYPE, dragKind, setDragPayload, visibleLocal, type LocalEntry, type LocalSortKey } from './managerModel'
import type { LocalFolder } from './useLocalFolder'
import { ContextMenu, type MenuAnchor, type MenuItem } from './ContextMenu'
import type { SortDir } from './browseModel'

function SortHeader({ k, sort, onSort, children, className }: { k: LocalSortKey; sort: { key: LocalSortKey; dir: SortDir }; onSort: (k: LocalSortKey) => void; children: React.ReactNode; className?: string }) {
  const active = sort.key === k
  return (
    <button onClick={() => onSort(k)} className={cx('inline-flex items-center gap-0.5 rounded px-1 hover:text-white', active && 'text-white', className)} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      {children}
      {active && (sort.dir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
    </button>
  )
}

export interface LocalPaneProps {
  folder: LocalFolder
  deviceName: string
  /** Whether "Send" can do anything right now (connected and a device folder is open). */
  canSend: boolean
  /** Send entries of the folder shown (files and folders) to the device folder. */
  onSend: (names: string[]) => void
  /** A drag from the device pane was dropped here: into the folder shown, or into `subdir`. */
  onDropRemote: (subdir: string | null) => void
}

/**
 * Left pane of the file manager: a folder on this computer through the File System Access API.
 * Rows drag onto the device pane; device rows drop here (pane or folder row) to be fetched.
 */
export function LocalPane({ folder, deviceName, canSend, onSend, onDropRemote }: LocalPaneProps) {
  const { state, dispatch } = folder
  const entries = useMemo(() => visibleLocal(state), [state])
  const names = useMemo(() => entries.map((e) => e.name), [entries])
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [paneHover, setPaneHover] = useState(false)
  const [menu, setMenu] = useState<{ at: MenuAnchor; items: MenuItem[] } | null>(null)
  const dragDepth = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  const selectedEntries = entries.filter((e) => state.selected.has(e.name))
  const allSelected = names.length > 0 && state.selected.size === names.length
  const ready = state.access === 'granted'

  const activate = (e: LocalEntry) => {
    if (e.isDir) dispatch({ type: 'enter', name: e.name })
    else if (canSend) onSend([e.name])
  }

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (menu || !ready) return
    if ((ev.target as HTMLElement).tagName === 'INPUT') return
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      dispatch({ type: 'move', delta: ev.key === 'ArrowDown' ? 1 : -1, extend: ev.shiftKey })
      // The reducer picked the row; scroll to it once it is rendered.
      queueMicrotask(() => {
        const f = listRef.current?.querySelector<HTMLElement>('[data-focus="true"]')
        f?.scrollIntoView({ block: 'nearest' })
      })
    } else if (ev.key === 'Enter') {
      const e = entries.find((x) => x.name === state.focus)
      if (e) {
        ev.preventDefault()
        activate(e)
      }
    } else if (ev.key === 'Backspace' && !ev.metaKey && !ev.ctrlKey) {
      ev.preventDefault()
      dispatch({ type: 'up' })
    } else if (ev.key === 'Escape') {
      dispatch({ type: 'clear' })
    } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'a') {
      ev.preventDefault()
      dispatch({ type: 'select-all' })
    }
  }

  /* ── drops from the device pane ── */
  const acceptsDrop = (dt: DataTransfer | null) => ready && dragKind(dt?.types) === 'remote'
  const paneDropActive = paneHover && dropTarget === null

  const closeMenu = useCallback(() => setMenu(null), [])
  const openMenu = (ev: React.MouseEvent, entry: LocalEntry | null) => {
    ev.preventDefault()
    ev.stopPropagation()
    const fresh = !!entry && !state.selected.has(entry.name)
    if (fresh) dispatch({ type: 'select', name: entry.name, mode: 'single' })
    setMenu({ at: { x: ev.clientX, y: ev.clientY }, items: menuItemsFor(entry, fresh) })
  }
  const menuItemsFor = (e: LocalEntry | null, fresh: boolean): MenuItem[] => {
    if (!e) {
      return [
        { label: 'Refresh', icon: <RefreshCw size={13} />, onClick: folder.refresh },
        { label: state.showHidden ? 'Hide hidden files' : 'Show hidden files', icon: state.showHidden ? <EyeOff size={13} /> : <Eye size={13} />, onClick: () => dispatch({ type: 'hidden', show: !state.showHidden }) },
        { label: 'Choose another folder…', icon: <FolderSearch size={13} />, onClick: () => void folder.open(), divider: true },
      ]
    }
    const group = !fresh && state.selected.size > 1 ? selectedEntries : [e]
    const items: MenuItem[] = []
    if (e.isDir && group.length === 1) items.push({ label: 'Open', icon: <FolderOpen size={13} />, onClick: () => dispatch({ type: 'enter', name: e.name }) })
    items.push({ label: group.length > 1 ? `Send ${group.length} items to ${deviceName}` : `Send to ${deviceName}`, icon: <ArrowUpFromLine size={13} />, disabled: !canSend, onClick: () => onSend(group.map((x) => x.name)) })
    return items
  }

  if (!ready) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="local-empty">
        {state.access === 'prompt' ? (
          <>
            <ShieldAlert size={28} className="text-[#fbbf24]" />
            <div className="text-[14px] font-medium text-white">{state.rootName}</div>
            <div className="max-w-[300px] text-[12.5px] text-[#9aa3b2]">Allow access again to use this folder.</div>
            <div className="flex gap-2">
              <Button size="sm" variant="primary" onClick={() => void folder.grant()}>
                Allow access
              </Button>
              <Button size="sm" onClick={() => void folder.open()}>
                Choose another folder…
              </Button>
            </div>
          </>
        ) : (
          <>
            <Laptop size={28} className="text-[#3b4250]" />
            <div className="text-[14px] font-medium text-white">Open a local folder</div>
            <Button size="sm" variant="primary" icon={<FolderOpen size={13} />} onClick={() => void folder.open()} data-testid="local-open">
              Open folder…
            </Button>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      {/* location bar */}
      <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1.5">
        <button onClick={() => dispatch({ type: 'goto', depth: 0 })} className={cx('rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white', !state.segments.length && 'text-white')} title="Top of the opened folder">
          <Laptop size={13} />
        </button>
        <button onClick={() => dispatch({ type: 'up' })} disabled={!state.segments.length} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white disabled:opacity-30" title="Up one level (Backspace)">
          <CornerLeftUp size={13} />
        </button>
        <div className="mono flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded px-1 py-0.5 text-[11.5px] whitespace-nowrap text-[#9aa3b2]" data-testid="local-path">
          {[state.rootName ?? '', ...state.segments].map((label, depth, all) => (
            <span key={`${depth}-${label}`} className="flex items-center gap-0.5">
              {depth > 0 && <ChevronRight size={11} />}
              <button onClick={() => dispatch({ type: 'goto', depth })} className={cx('rounded px-1 hover:bg-white/10', depth === all.length - 1 && 'text-white')}>
                {label}
              </button>
            </span>
          ))}
        </div>
        <button onClick={folder.refresh} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white" title="Refresh">
          <RefreshCw size={13} className={cx(state.loading && 'animate-spin')} />
        </button>
        <button onClick={() => dispatch({ type: 'hidden', show: !state.showHidden })} className={cx('rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white', state.showHidden && 'text-white')} title={state.showHidden ? 'Hide hidden files' : 'Show hidden files'}>
          {state.showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
        <button onClick={() => void folder.open()} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white" title="Choose another folder">
          <FolderSearch size={13} />
        </button>
      </div>

      {/* filter + column headers */}
      <div className="flex items-center gap-2 border-b border-white/5 px-2 py-1">
        <div className="relative min-w-0 flex-1">
          <Search size={11} className="pointer-events-none absolute top-1/2 left-1.5 -translate-y-1/2 text-[#6b7381]" />
          <input
            value={state.query}
            onChange={(e) => dispatch({ type: 'query', value: e.target.value })}
            onKeyDown={(e) => e.key === 'Escape' && dispatch({ type: 'query', value: '' })}
            placeholder="Filter this folder"
            className="h-6 w-full rounded border border-white/10 bg-black/30 pr-5 pl-6 text-[11.5px] text-[#e6e9ef] placeholder:text-[#6b7381] focus:border-[#6cb6ff] focus:outline-none"
            aria-label="Filter local entries"
          />
          {state.query && (
            <button onClick={() => dispatch({ type: 'query', value: '' })} className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-[#6b7381] hover:text-white" aria-label="Clear filter">
              <X size={10} />
            </button>
          )}
        </div>
        <span className="mono shrink-0 text-[11px] text-[#6b7381]">
          {entries.length} item{entries.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-0.5 text-[10.5px] tracking-wide text-[#6b7381] uppercase select-none">
        <button onClick={() => dispatch({ type: allSelected ? 'clear' : 'select-all' })} className="rounded p-0.5 text-[#6b7381] hover:text-white" title={allSelected ? 'Clear selection' : 'Select all'} aria-label={allSelected ? 'Clear selection' : 'Select all'}>
          {allSelected ? <SquareCheck size={12} /> : state.selected.size ? <SquareMinus size={12} /> : <Square size={12} />}
        </button>
        <SortHeader k="name" sort={state.sort} onSort={(key) => dispatch({ type: 'sort', key })} className="min-w-0 flex-1 justify-start">
          Name
        </SortHeader>
        <SortHeader k="size" sort={state.sort} onSort={(key) => dispatch({ type: 'sort', key })} className="w-16 justify-end">
          Size
        </SortHeader>
        <SortHeader k="modified" sort={state.sort} onSort={(key) => dispatch({ type: 'sort', key })} className="hidden w-20 justify-end xl:inline-flex">
          Modified
        </SortHeader>
        <span className="w-8" />
      </div>

      {/* list */}
      <div
        ref={listRef}
        className={cx('relative min-h-0 flex-1 overflow-y-auto outline-none', paneDropActive && 'bg-[#34d399]/10 ring-2 ring-[#34d399] ring-inset')}
        tabIndex={0}
        role="listbox"
        aria-multiselectable
        aria-label="Files on this computer"
        data-testid="local-list"
        onContextMenu={(ev) => openMenu(ev, null)}
        onDragEnter={(ev) => {
          if (!acceptsDrop(ev.dataTransfer)) return
          ev.preventDefault()
          dragDepth.current++
          setPaneHover(true)
        }}
        onDragOver={(ev) => {
          const k = dragKind(ev.dataTransfer.types)
          if (k === 'os') {
            // Never let the browser navigate to a dropped file; desktop files go to the device pane.
            ev.preventDefault()
            ev.dataTransfer.dropEffect = 'none'
            return
          }
          if (!acceptsDrop(ev.dataTransfer)) return
          ev.preventDefault()
          ev.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={(ev) => {
          if (!acceptsDrop(ev.dataTransfer)) return
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setPaneHover(false)
        }}
        onDrop={(ev) => {
          if (dragKind(ev.dataTransfer.types) === 'os') {
            ev.preventDefault()
            return
          }
          if (!acceptsDrop(ev.dataTransfer)) return
          ev.preventDefault()
          dragDepth.current = 0
          setPaneHover(false)
          setDropTarget(null)
          onDropRemote(null)
        }}
      >
        {state.error && <div className="px-3 py-2 text-[#f87171]">{state.error}</div>}
        {state.loading && !entries.length && !state.error && <div className="px-3 py-2 text-[#6b7381]">Loading…</div>}
        {!state.loading && entries.length === 0 && !state.error && <div className="px-3 py-6 text-center text-[#6b7381]">{state.query ? 'Nothing matches the filter' : 'Empty folder'}</div>}
        {entries.map((e) => {
          const isSel = state.selected.has(e.name)
          const isFocus = state.focus === e.name
          return (
            <div
              key={e.name}
              data-name={e.name}
              data-focus={isFocus || undefined}
              role="option"
              aria-selected={isSel}
              draggable
              className={cx(
                'group flex cursor-default items-center gap-2 px-3 py-1.5 select-none',
                isSel ? 'bg-[#6cb6ff]/15' : 'hover:bg-white/5',
                isFocus && 'ring-1 ring-inset ring-[#6cb6ff]/50',
                dropTarget === e.name && 'bg-[#34d399]/20 ring-1 ring-inset ring-[#34d399]',
              )}
              onClick={(ev) => dispatch({ type: 'select', name: e.name, mode: ev.shiftKey ? 'range' : ev.metaKey || ev.ctrlKey ? 'toggle' : 'single' })}
              onDoubleClick={() => activate(e)}
              onContextMenu={(ev) => openMenu(ev, e)}
              title={e.isDir ? 'Double-click to open · drag to send' : `Drag to ${deviceName} to send`}
              onDragStart={(ev) => {
                const group = isSel ? selectedEntries : [e]
                setDragPayload({ kind: 'local', names: group.map((x) => x.name) })
                ev.dataTransfer.setData(LOCAL_DRAG_TYPE, String(group.length))
                ev.dataTransfer.effectAllowed = 'copy'
                if (!isSel) dispatch({ type: 'select', name: e.name, mode: 'single' })
              }}
              onDragEnd={() => setDragPayload(null)}
              onDragOver={(ev) => {
                if (!e.isDir || !acceptsDrop(ev.dataTransfer)) return
                ev.preventDefault()
                ev.stopPropagation()
                ev.dataTransfer.dropEffect = 'copy'
                if (dropTarget !== e.name) setDropTarget(e.name)
              }}
              onDragLeave={() => dropTarget === e.name && setDropTarget(null)}
              onDrop={(ev) => {
                if (!e.isDir || !acceptsDrop(ev.dataTransfer)) return
                ev.preventDefault()
                ev.stopPropagation()
                dragDepth.current = 0
                setPaneHover(false)
                setDropTarget(null)
                onDropRemote(e.name)
              }}
            >
              <button
                onClick={(ev) => {
                  ev.stopPropagation()
                  dispatch({ type: 'select', name: e.name, mode: 'toggle' })
                }}
                className={cx('shrink-0 rounded p-0.5 text-[#6b7381] hover:text-white', isSel ? 'text-[#6cb6ff] opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100')}
                aria-label={isSel ? `Deselect ${e.name}` : `Select ${e.name}`}
              >
                {isSel ? <SquareCheck size={13} /> : <Square size={13} />}
              </button>
              <FileTypeIcon name={e.name} isDir={e.isDir} />
              <span className={cx('min-w-0 flex-1 truncate', e.name.startsWith('.') && 'text-[#6b7381]')}>{e.name}</span>
              <span className="mono w-16 shrink-0 text-right text-[11px] text-[#6b7381]">{e.isDir ? '' : bytes(e.size)}</span>
              <span className="mono hidden w-20 shrink-0 text-right text-[11px] text-[#6b7381] xl:inline" title={e.modifiedMs ? new Date(e.modifiedMs).toLocaleString() : undefined}>
                {e.modifiedMs ? relativeTime(new Date(e.modifiedMs).toISOString()) : ''}
              </span>
              <span className="flex w-8 shrink-0 items-center justify-end opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                <button
                  onClick={(ev) => {
                    ev.stopPropagation()
                    onSend([e.name])
                  }}
                  disabled={!canSend}
                  className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white disabled:opacity-30"
                  title={`Send to ${deviceName}`}
                  aria-label={`Send ${e.name}`}
                >
                  <ArrowUpFromLine size={12} />
                </button>
              </span>
            </div>
          )
        })}
        {paneDropActive && (
          <div className="pointer-events-none sticky bottom-2 flex justify-center">
            <span className="mono max-w-[90%] truncate rounded-md bg-[#34d399] px-2.5 py-1 text-[11px] font-medium text-[#0e1116] shadow-lg">Drop to fetch into {[state.rootName, ...state.segments].join('/')}</span>
          </div>
        )}
      </div>

      {/* bulk actions */}
      {state.selected.size > 0 && (
        <div className="flex items-center gap-2 border-t border-white/10 bg-[#6cb6ff]/10 px-3 py-1.5 text-[12px]" data-testid="local-bulk-bar">
          <span className="min-w-0 flex-1 truncate text-[#c8ced8]">
            {state.selected.size} selected
            {selectedEntries.some((e) => !e.isDir) && <span className="mono ml-1 text-[#6b7381]">({bytes(selectedEntries.filter((e) => !e.isDir).reduce((a, e) => a + e.size, 0))})</span>}
          </span>
          <Button size="sm" variant="primary" icon={<Upload size={12} />} disabled={!canSend} onClick={() => onSend(selectedEntries.map((e) => e.name))} title={`Send to ${deviceName}`}>
            Send
          </Button>
          <button onClick={() => dispatch({ type: 'clear' })} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white" title="Clear selection (Esc)" aria-label="Clear selection">
            <X size={13} />
          </button>
        </div>
      )}

      {menu && <ContextMenu at={menu.at} items={menu.items} onClose={closeMenu} />}
    </div>
  )
}

/**
 * Fallback for browsers without the File System Access API: files chosen through the picker or
 * dropped on the pane are listed here and can be sent; fetched files arrive as downloads.
 */
export function LocalPickPane({ deviceName, canSend, onSendFiles }: { deviceName: string; canSend: boolean; onSendFiles: (files: File[]) => void }) {
  const [files, setFiles] = useState<File[]>([])
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [hover, setHover] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const add = (list: FileList | File[] | null) => {
    if (!list) return
    setFiles((f) => [...f, ...Array.from(list)])
  }
  const chosen = files.filter((_, i) => selected.has(i))
  return (
    <div
      className={cx('flex min-h-0 flex-1 flex-col', hover && 'bg-[#6cb6ff]/10 ring-2 ring-[#6cb6ff] ring-inset')}
      onDragOver={(e) => {
        if (dragKind(e.dataTransfer.types) !== 'os') return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setHover(true)
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        setHover(false)
        if (dragKind(e.dataTransfer.types) !== 'os') return
        e.preventDefault()
        add(e.dataTransfer.files)
      }}
      data-testid="local-pick-pane"
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-[12px] text-[#9aa3b2]">
        <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => input.current?.click()}>
          Choose files…
        </Button>
        <input ref={input} type="file" multiple className="hidden" onChange={(e) => add(e.target.files)} />
        <span className="min-w-0 truncate">or drop files here</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Files to send">
        {files.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-[#6b7381]">
            <Laptop size={26} className="text-[#3b4250]" />
            <div className="text-[13px] text-[#9aa3b2]">Folder access unsupported here</div>
            <div className="text-[12px]">Pick or drop files to send to {deviceName}.</div>
          </div>
        )}
        {files.map((f, i) => {
          const isSel = selected.has(i)
          return (
            <div
              key={`${f.name}-${i}`}
              role="option"
              aria-selected={isSel}
              className={cx('group flex cursor-default items-center gap-2 px-3 py-1.5 select-none', isSel ? 'bg-[#6cb6ff]/15' : 'hover:bg-white/5')}
              onClick={() =>
                setSelected((s) => {
                  const n = new Set(s)
                  if (n.has(i)) n.delete(i)
                  else n.add(i)
                  return n
                })
              }
              onDoubleClick={() => canSend && onSendFiles([f])}
            >
              {isSel ? <SquareCheck size={13} className="text-[#6cb6ff]" /> : <Square size={13} className="text-[#6b7381]" />}
              <FileTypeIcon name={f.name} isDir={false} />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="mono w-16 shrink-0 text-right text-[11px] text-[#6b7381]">{bytes(f.size)}</span>
              <button
                onClick={(ev) => {
                  ev.stopPropagation()
                  setFiles((all) => all.filter((_, j) => j !== i))
                  setSelected(new Set())
                }}
                className="rounded p-1 text-[#9aa3b2] opacity-0 group-hover:opacity-100 hover:text-white"
                aria-label={`Remove ${f.name}`}
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>
      {files.length > 0 && (
        <div className="flex items-center gap-2 border-t border-white/10 bg-[#6cb6ff]/10 px-3 py-1.5 text-[12px]">
          <span className="min-w-0 flex-1 truncate text-[#c8ced8]">{chosen.length ? `${chosen.length} selected` : `${files.length} file${files.length === 1 ? '' : 's'}`}</span>
          <Button size="sm" variant="primary" icon={<Upload size={12} />} disabled={!canSend} onClick={() => onSendFiles(chosen.length ? chosen : files)}>
            Send {chosen.length ? 'selected' : 'all'}
          </Button>
        </div>
      )}
    </div>
  )
}
