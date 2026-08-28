import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, Check, ChevronDown, ChevronRight, ChevronUp, CornerLeftUp, Eye, EyeOff, FolderInput, FolderPlus, HardDrive, Pencil, RefreshCw, Search, Square, SquareCheck, SquareMinus, Trash2, Upload, X } from 'lucide-react'
import type { FileEntry } from '@/protocol'
import { Button, ConfirmDialog, Input, cx } from '@/components/ui'
import { bytes, relativeTime } from '@/lib/format'
import { toast } from '@/lib/toast'
import { transferManager, useFiles } from './store'
import { BlobSink, FileSystemSink, MEMORY_SINK_WARN_BYTES, directoryPickerAvailable, fileSystemAccessAvailable, guessMime, pickDirectory, pickSaveFile } from './sinks'
import { flattenDrop, isFileDrag, snapshotDrop } from './dnd'
import { FileTypeIcon } from './fileIcons'
import { crumbsFor, joinPath, parentPath } from './paths'
import { filterEntries, moveFocus, rangeSelect, sortEntries, toggleSort, type SortDir, type SortKey } from './browseModel'

export interface PickMode {
  onPick: (path: string) => void
  onCancel: () => void
}

/* Promise-based confirmation for large in-memory downloads (replaces window.confirm). */
type LargeAsk = { label: string; size: number; resolve: (ok: boolean) => void }
let largeAskListener: ((a: LargeAsk | null) => void) | null = null
function askLargeDownload(label: string, size: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!largeAskListener) return resolve(true)
    largeAskListener({ label, size, resolve })
  })
}

function LargeDownloadDialog() {
  const [ask, setAsk] = useState<LargeAsk | null>(null)
  useEffect(() => {
    largeAskListener = setAsk
    return () => {
      largeAskListener = null
    }
  }, [])
  const answer = (ok: boolean) => {
    ask?.resolve(ok)
    setAsk(null)
  }
  return (
    <ConfirmDialog
      open={!!ask}
      onClose={() => answer(false)}
      onConfirm={() => answer(true)}
      title="Large download"
      body={
        <>
          <b>{ask?.label}</b> is {ask ? bytes(ask.size) : ''}. This browser cannot stream to disk, so the whole content is held in memory before it is saved. Continue?
        </>
      }
      confirmLabel="Download anyway"
    />
  )
}

function SortHeader({ k, sort, onSort, children, className }: { k: SortKey; sort: { key: SortKey; dir: SortDir }; onSort: (k: SortKey) => void; children: React.ReactNode; className?: string }) {
  const active = sort.key === k
  return (
    <button onClick={() => onSort(k)} className={cx('inline-flex items-center gap-0.5 rounded px-1 hover:text-white', active && 'text-white', className)} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      {children}
      {active && (sort.dir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
    </button>
  )
}

function shortDate(ms: bigint | undefined): string {
  if (ms === undefined) return ''
  return relativeTime(new Date(Number(ms)).toISOString())
}

function longDate(ms: bigint | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(Number(ms)).toLocaleString()
}

/**
 * Remote file browser: breadcrumbs / editable path, sortable columns, filter, multi-select
 * with keyboard navigation, bulk download/delete, rename, new folder, uploads into the
 * current folder or onto a folder row.
 */
/** A folder the Transfers tab asked to show; `nonce` makes repeated requests for the same folder navigate again. */
export interface Reveal {
  path: string
  nonce: number
}

export function BrowseTab({ pickMode, onSetUploadDest, reveal }: { pickMode?: PickMode; onSetUploadDest?: (path: string) => void; reveal?: Reveal | null }) {
  const listing = useFiles((s) => s.listing)
  const loading = useFiles((s) => s.listingLoading)
  const path = useFiles((s) => s.listingPath)
  const requestListing = useFiles((s) => s.requestListing)
  const [showHidden, setShowHidden] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'name', dir: 'asc' })
  const [query, setQuery] = useState('')
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [newDir, setNewDir] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null)
  const [deleting, setDeleting] = useState<string[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const uploadInput = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const revealed = useRef(0)

  useEffect(() => {
    if (!listing && !loading) requestListing(null)
  }, [listing, loading, requestListing])

  // "Show in folder" from the Transfers tab.
  useEffect(() => {
    if (reveal && revealed.current !== reveal.nonce) {
      revealed.current = reveal.nonce
      requestListing(reveal.path)
    }
  }, [reveal, requestListing])

  // A new listing resets selection and filter (state adjusted during render, not in an effect).
  const [listedPath, setListedPath] = useState(listing?.path)
  if (listing?.path !== listedPath) {
    setListedPath(listing?.path)
    setSelected(new Set())
    setAnchor(null)
    setFocus(null)
    setQuery('')
    setRenaming(null)
  }

  const atRoots = listing?.path === '' || path === null
  const entries = useMemo(() => sortEntries(filterEntries(listing?.entries ?? [], query, showHidden), sort.key, sort.dir), [listing, query, showHidden, sort])
  const names = useMemo(() => entries.map((e) => e.name), [entries])
  const crumbs = useMemo(() => crumbsFor(listing?.path ?? ''), [listing?.path])
  const parent = listing?.path ? parentPath(listing.path) : null
  const canGoUp = !atRoots

  const fullPath = useCallback((e: FileEntry) => (atRoots ? (e.path ?? e.name) : joinPath(listing!.path, e.name)), [atRoots, listing])

  const goUp = () => {
    if (!canGoUp) return
    requestListing(parent)
  }

  const open = (e: FileEntry) => {
    if (e.is_dir) requestListing(fullPath(e))
    else void download([e])
  }

  const download = async (files: FileEntry[]) => {
    files = files.filter((f) => !f.is_dir)
    if (!files.length) return
    if (files.length === 1) {
      const e = files[0]!
      const size = Number(e.size)
      if (fileSystemAccessAvailable()) {
        const handle = await pickSaveFile(e.name)
        if (!handle) return
        await transferManager.download(fullPath(e), e.name, size, async (resume) => FileSystemSink.open(handle, resume ? await FileSystemSink.existingSize(handle) : 0))
      } else {
        if (size > MEMORY_SINK_WARN_BYTES && !(await askLargeDownload(e.name, size))) return
        await transferManager.download(fullPath(e), e.name, size, async () => new BlobSink(e.name, guessMime(e.name), true))
      }
      toast.info(`Fetching ${e.name}`, 'Progress is in the Transfers tab.')
      return
    }
    const total = files.reduce((a, f) => a + Number(f.size), 0)
    if (directoryPickerAvailable()) {
      const dir = await pickDirectory()
      if (!dir) return
      for (const e of files) {
        await transferManager.download(fullPath(e), e.name, Number(e.size), async (resume) => {
          const handle = await dir.getFileHandle(e.name, { create: true })
          return FileSystemSink.open(handle, resume ? await FileSystemSink.existingSize(handle) : 0)
        })
      }
    } else {
      if (total > MEMORY_SINK_WARN_BYTES && !(await askLargeDownload(`${files.length} files`, total))) return
      for (const e of files) await transferManager.download(fullPath(e), e.name, Number(e.size), async () => new BlobSink(e.name, guessMime(e.name), true))
    }
    toast.info(`Fetching ${files.length} files (${bytes(total)})`, 'Progress is in the Transfers tab.')
  }

  const uploadTo = (dir: string, files: File[]) => {
    if (!files.length) return
    onSetUploadDest?.(dir)
    for (const f of files) void transferManager.upload(f, { destDir: dir })
    toast.info(`Sending ${files.length} file${files.length === 1 ? '' : 's'}`, dir)
  }

  const uploadHere = (files: FileList | null) => {
    if (!files || atRoots || !listing) return
    uploadTo(listing.path, Array.from(files))
  }

  /* ── selection ── */
  const select = (e: FileEntry, ev: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    const name = e.name
    if (ev.shiftKey) {
      setSelected(new Set(rangeSelect(names, anchor, name)))
    } else if (ev.metaKey || ev.ctrlKey) {
      setSelected((s) => {
        const n = new Set(s)
        if (n.has(name)) n.delete(name)
        else n.add(name)
        return n
      })
      setAnchor(name)
    } else {
      setSelected(new Set([name]))
      setAnchor(name)
    }
    setFocus(name)
  }
  const toggle = (name: string) => {
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(name)) n.delete(name)
      else n.add(name)
      return n
    })
    setAnchor(name)
    setFocus(name)
  }
  const selectAll = () => setSelected(new Set(names))
  const clearSelection = () => {
    setSelected(new Set())
    setAnchor(null)
  }
  const selectedEntries = entries.filter((e) => selected.has(e.name))
  const allSelected = names.length > 0 && selected.size === names.length

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (renaming || newDir !== null || editingPath !== null) return
    const target = ev.target as HTMLElement
    if (target.tagName === 'INPUT') return
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      const next = moveFocus(names, focus, ev.key === 'ArrowDown' ? 1 : -1)
      if (!next) return
      setFocus(next)
      if (ev.shiftKey) setSelected(new Set(rangeSelect(names, anchor ?? focus, next)))
      else {
        setSelected(new Set([next]))
        setAnchor(next)
      }
      listRef.current?.querySelector<HTMLElement>(`[data-name="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' })
    } else if (ev.key === 'Enter') {
      const e = entries.find((x) => x.name === focus)
      if (e) {
        ev.preventDefault()
        open(e)
      }
    } else if (ev.key === 'Backspace' && !ev.metaKey && !ev.ctrlKey) {
      ev.preventDefault()
      goUp()
    } else if (ev.key === 'Delete' || (ev.key === 'Backspace' && (ev.metaKey || ev.ctrlKey))) {
      if (!atRoots && selected.size) {
        ev.preventDefault()
        setDeleting([...selected])
      }
    } else if (ev.key === 'Escape') {
      clearSelection()
    } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'a') {
      ev.preventDefault()
      selectAll()
    } else if (ev.key === 'F2' && focus && !atRoots) {
      ev.preventDefault()
      setRenaming({ name: focus, value: focus })
    }
  }

  const onSort = (k: SortKey) => setSort((s) => toggleSort(s, k))

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      {pickMode && (
        <div className="flex items-center gap-2 border-b border-white/10 bg-[#6cb6ff]/10 px-3 py-2">
          <FolderInput size={14} className="shrink-0 text-[#6cb6ff]" />
          <span className="min-w-0 flex-1 text-[12px] text-[#c8ced8]">{atRoots ? 'Open a folder to use it for uploads' : <span className="mono truncate">{listing?.path}</span>}</span>
          <Button size="sm" variant="primary" icon={<Check size={13} />} disabled={atRoots || !listing} onClick={() => listing && pickMode.onPick(listing.path)}>
            Use this folder
          </Button>
          <button onClick={pickMode.onCancel} className="rounded px-1.5 py-0.5 text-[11.5px] text-[#9aa3b2] hover:bg-white/10 hover:text-white">
            Cancel
          </button>
        </div>
      )}

      {/* location bar */}
      <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1.5">
        <button onClick={() => requestListing(null)} className={cx('rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white', atRoots && 'text-white')} title="Roots (home, volumes, transfer folder)">
          <HardDrive size={13} />
        </button>
        <button onClick={goUp} disabled={!canGoUp} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white disabled:opacity-30" title="Up one level (Backspace)">
          <CornerLeftUp size={13} />
        </button>
        {editingPath !== null ? (
          <form
            className="flex min-w-0 flex-1"
            onSubmit={(e) => {
              e.preventDefault()
              const p = editingPath.trim()
              if (p) requestListing(p)
              setEditingPath(null)
            }}
          >
            <Input
              autoFocus
              value={editingPath}
              onChange={(e) => setEditingPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setEditingPath(null)}
              onBlur={() => setEditingPath(null)}
              className="mono h-6 bg-black/30 text-[11.5px]"
              placeholder="/path/on/the/device"
              aria-label="Path"
            />
          </form>
        ) : (
          <div
            className="mono flex min-w-0 flex-1 cursor-text items-center gap-0.5 overflow-x-auto rounded px-1 py-0.5 text-[11.5px] whitespace-nowrap text-[#9aa3b2] hover:bg-white/5"
            onClick={(e) => e.target === e.currentTarget && setEditingPath(listing?.path ?? '')}
            title="Click to type a path"
          >
            {atRoots && <span className="text-white">Roots</span>}
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex items-center gap-0.5">
                {i > 0 && <ChevronRight size={11} />}
                <button onClick={() => requestListing(c.path)} className={cx('rounded px-1 hover:bg-white/10', i === crumbs.length - 1 && 'text-white')}>
                  {c.label}
                </button>
              </span>
            ))}
            {!atRoots && (
              <button onClick={() => setEditingPath(listing?.path ?? '')} className="ml-1 rounded p-0.5 text-[#6b7381] hover:bg-white/10 hover:text-white" title="Edit path" aria-label="Edit path">
                <Pencil size={10} />
              </button>
            )}
          </div>
        )}
        <button onClick={() => requestListing(path)} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white" title="Refresh">
          <RefreshCw size={13} className={cx(loading && 'animate-spin')} />
        </button>
        <button onClick={() => setShowHidden((v) => !v)} className={cx('rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white', showHidden && 'text-white')} title={showHidden ? 'Hide hidden files' : 'Show hidden files'}>
          {showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
        {!atRoots && (
          <>
            <button onClick={() => setNewDir('')} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white" title="New folder">
              <FolderPlus size={13} />
            </button>
            <button onClick={() => uploadInput.current?.click()} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white" title="Upload into this folder">
              <Upload size={13} />
            </button>
            <input ref={uploadInput} type="file" multiple className="hidden" onChange={(e) => uploadHere(e.target.files)} />
          </>
        )}
        <LargeDownloadDialog />
      </div>

      {/* filter + column headers */}
      <div className="flex items-center gap-2 border-b border-white/5 px-2 py-1">
        <div className="relative min-w-0 flex-1">
          <Search size={11} className="pointer-events-none absolute top-1/2 left-1.5 -translate-y-1/2 text-[#6b7381]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder={atRoots ? 'Filter' : 'Filter this folder'}
            className="h-6 w-full rounded border border-white/10 bg-black/30 pr-5 pl-6 text-[11.5px] text-[#e6e9ef] placeholder:text-[#6b7381] focus:border-[#6cb6ff] focus:outline-none"
            aria-label="Filter entries"
          />
          {query && (
            <button onClick={() => setQuery('')} className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-[#6b7381] hover:text-white" aria-label="Clear filter">
              <X size={10} />
            </button>
          )}
        </div>
        <span className="mono shrink-0 text-[11px] text-[#6b7381]">
          {entries.length} item{entries.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-0.5 text-[10.5px] tracking-wide text-[#6b7381] uppercase select-none">
        {!atRoots && (
          <button onClick={() => (allSelected ? clearSelection() : selectAll())} className="rounded p-0.5 text-[#6b7381] hover:text-white" title={allSelected ? 'Clear selection' : 'Select all'} aria-label={allSelected ? 'Clear selection' : 'Select all'}>
            {allSelected ? <SquareCheck size={12} /> : selected.size ? <SquareMinus size={12} /> : <Square size={12} />}
          </button>
        )}
        <SortHeader k="name" sort={sort} onSort={onSort} className="min-w-0 flex-1 justify-start">
          Name
        </SortHeader>
        <SortHeader k="size" sort={sort} onSort={onSort} className="w-16 justify-end">
          Size
        </SortHeader>
        <SortHeader k="modified" sort={sort} onSort={onSort} className="hidden w-20 justify-end xl:inline-flex">
          Modified
        </SortHeader>
        <span className="w-14" />
      </div>

      {newDir !== null && (
        <form
          className="flex items-center gap-2 border-b border-white/10 px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (newDir.trim() && listing) transferManager.mkdir(joinPath(listing.path, newDir.trim()))
            setNewDir(null)
          }}
        >
          <FolderPlus size={13} className="text-[#9aa3b2]" />
          <Input autoFocus value={newDir} onChange={(e) => setNewDir(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setNewDir(null)} placeholder="New folder name" className="h-7 bg-black/30" />
          <Button size="sm" type="submit" variant="primary">
            Create
          </Button>
          <Button size="sm" type="button" onClick={() => setNewDir(null)}>
            Cancel
          </Button>
        </form>
      )}

      {/* list */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto outline-none" tabIndex={0} role="listbox" aria-multiselectable aria-label="Files on the device">
        {listing?.error && <div className="px-3 py-2 text-[#f87171]">{listing.error}</div>}
        {!listing && loading && <div className="px-3 py-2 text-[#6b7381]">Loading…</div>}
        {listing && entries.length === 0 && !listing.error && <div className="px-3 py-6 text-center text-[#6b7381]">{query ? 'Nothing matches the filter' : 'Empty folder'}</div>}
        {entries.map((e) => {
          const isSel = selected.has(e.name)
          const isFocus = focus === e.name
          const root = atRoots ? (e.name.toLowerCase() === 'home' ? 'home' : 'root') : undefined
          return (
            <div
              key={e.name}
              data-name={e.name}
              role="option"
              aria-selected={isSel}
              className={cx(
                'group flex cursor-default items-center gap-2 px-3 py-1.5 select-none',
                isSel ? 'bg-[#6cb6ff]/15' : 'hover:bg-white/5',
                isFocus && 'ring-1 ring-inset ring-[#6cb6ff]/50',
                dropTarget === e.name && 'bg-[#6cb6ff]/25 ring-1 ring-inset ring-[#6cb6ff]',
              )}
              onClick={(ev) => select(e, ev)}
              onDoubleClick={() => open(e)}
              title={e.is_dir ? 'Double-click to open' : 'Double-click to download'}
              onDragOver={(ev) => {
                if (!e.is_dir || !isFileDrag(ev.dataTransfer)) return
                ev.preventDefault()
                ev.stopPropagation()
                ev.dataTransfer.dropEffect = 'copy'
                if (dropTarget !== e.name) setDropTarget(e.name)
              }}
              onDragLeave={() => dropTarget === e.name && setDropTarget(null)}
              onDrop={(ev) => {
                if (!e.is_dir || !isFileDrag(ev.dataTransfer)) return
                ev.preventDefault()
                ev.stopPropagation()
                setDropTarget(null)
                const snap = snapshotDrop(ev.dataTransfer)
                const dir = fullPath(e)
                void flattenDrop(snap).then((files) => uploadTo(dir, files.map((f) => f.file)))
              }}
            >
              {!atRoots && (
                <button
                  onClick={(ev) => {
                    ev.stopPropagation()
                    toggle(e.name)
                  }}
                  className={cx('shrink-0 rounded p-0.5 text-[#6b7381] hover:text-white', isSel ? 'text-[#6cb6ff] opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100')}
                  aria-label={isSel ? `Deselect ${e.name}` : `Select ${e.name}`}
                >
                  {isSel ? <SquareCheck size={13} /> : <Square size={13} />}
                </button>
              )}
              <FileTypeIcon name={e.name} isDir={e.is_dir} root={root} />
              {renaming?.name === e.name ? (
                <form
                  className="flex flex-1 items-center gap-1"
                  onSubmit={(ev) => {
                    ev.preventDefault()
                    const v = renaming.value.trim()
                    if (v && v !== e.name && listing) transferManager.rename(joinPath(listing.path, e.name), joinPath(listing.path, v))
                    setRenaming(null)
                  }}
                  onClick={(ev) => ev.stopPropagation()}
                >
                  <Input
                    autoFocus
                    value={renaming.value}
                    onChange={(ev) => setRenaming({ name: e.name, value: ev.target.value })}
                    onKeyDown={(ev) => ev.key === 'Escape' && setRenaming(null)}
                    onFocus={(ev) => {
                      const dot = e.is_dir ? -1 : e.name.lastIndexOf('.')
                      ev.target.setSelectionRange(0, dot > 0 ? dot : e.name.length)
                    }}
                    className="h-6 bg-black/30 text-[12px]"
                    onBlur={() => setRenaming(null)}
                    aria-label="New name"
                  />
                </form>
              ) : (
                <span className={cx('min-w-0 flex-1 truncate', e.hidden && 'text-[#6b7381]')}>
                  {e.name}
                  {atRoots && e.path && <span className="mono ml-2 text-[10.5px] text-[#6b7381]">{e.path}</span>}
                </span>
              )}
              <span className="mono w-16 shrink-0 text-right text-[11px] text-[#6b7381]">{e.is_dir ? '' : bytes(Number(e.size))}</span>
              <span className="mono hidden w-20 shrink-0 text-right text-[11px] text-[#6b7381] xl:inline" title={longDate(e.modified_ms)}>
                {shortDate(e.modified_ms)}
              </span>
              <span className={cx('flex w-14 shrink-0 items-center justify-end gap-0.5', atRoots ? 'invisible' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100')}>
                {!e.is_dir && (
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation()
                      void download([e])
                    }}
                    className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white"
                    title="Download"
                    aria-label={`Download ${e.name}`}
                  >
                    <ArrowDownToLine size={12} />
                  </button>
                )}
                <button
                  onClick={(ev) => {
                    ev.stopPropagation()
                    setRenaming({ name: e.name, value: e.name })
                  }}
                  className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white"
                  title="Rename (F2)"
                  aria-label={`Rename ${e.name}`}
                >
                  <Pencil size={12} />
                </button>
                <button
                  onClick={(ev) => {
                    ev.stopPropagation()
                    setDeleting([e.name])
                  }}
                  className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-[#f87171]"
                  title="Delete"
                  aria-label={`Delete ${e.name}`}
                >
                  <Trash2 size={12} />
                </button>
              </span>
            </div>
          )
        })}
      </div>

      {/* bulk actions */}
      {selected.size > 0 && !atRoots && (
        <div className="flex items-center gap-2 border-t border-white/10 bg-[#6cb6ff]/10 px-3 py-1.5 text-[12px]" data-testid="bulk-bar">
          <span className="min-w-0 flex-1 truncate text-[#c8ced8]">
            {selected.size} selected
            {selectedEntries.some((e) => !e.is_dir) && <span className="mono ml-1 text-[#6b7381]">({bytes(selectedEntries.filter((e) => !e.is_dir).reduce((a, e) => a + Number(e.size), 0))})</span>}
          </span>
          {selectedEntries.some((e) => !e.is_dir) && (
            <Button size="sm" icon={<ArrowDownToLine size={12} />} onClick={() => void download(selectedEntries)} title="Download the selected files">
              Download
            </Button>
          )}
          <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={() => setDeleting([...selected])}>
            Delete
          </Button>
          <button onClick={clearSelection} className="rounded p-1 text-[#9aa3b2] hover:bg-white/10 hover:text-white" title="Clear selection (Esc)" aria-label="Clear selection">
            <X size={13} />
          </button>
        </div>
      )}

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting && listing) for (const n of deleting) transferManager.delete(joinPath(listing.path, n))
          setDeleting(null)
          clearSelection()
        }}
        title={deleting && deleting.length > 1 ? `Delete ${deleting.length} items?` : entries.find((e) => e.name === deleting?.[0])?.is_dir ? 'Delete folder?' : 'Delete file?'}
        body={
          deleting && deleting.length > 1 ? (
            <>
              <b>{deleting.length} items</b> will be deleted on the device. This cannot be undone.
            </>
          ) : (
            <>
              <b>{deleting?.[0]}</b> will be deleted on the device. This cannot be undone.
            </>
          )
        }
        confirmLabel="Delete"
        danger
      />
    </div>
  )
}
