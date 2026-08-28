import { describe, expect, it } from 'vitest'
import { LOCAL_DRAG_TYPE, REMOTE_DRAG_TYPE, chooseFetchTarget, dragKind, initialLocalState, localPathLabel, localReducer, peekDragPayload, resolveDropTarget, setDragPayload, takeDragPayload, visibleLocal, type LocalAction, type LocalEntry, type LocalState } from './managerModel'

const entry = (name: string, isDir = false, size = 0, modifiedMs = 0): LocalEntry => ({ name, isDir, size, modifiedMs })

function run(actions: LocalAction[], from: LocalState = initialLocalState()): LocalState {
  return actions.reduce(localReducer, from)
}

/** A pane with a granted root and a listed folder. */
function listed(entries: LocalEntry[]): LocalState {
  const s = run([{ type: 'root', name: 'Projects', access: 'granted' }])
  return localReducer(s, { type: 'listed', generation: s.generation, entries })
}

describe('resolveDropTarget', () => {
  it('lands in a folder row when the pointer is over one', () => {
    expect(resolveDropTarget('/home/u', { name: 'docs', isDir: true, path: '/home/u/docs' })).toEqual({ dir: '/home/u/docs', into: 'row' })
  })
  it('falls through to the pane folder over a file row or empty space', () => {
    expect(resolveDropTarget('/home/u', { name: 'a.txt', isDir: false, path: '/home/u/a.txt' })).toEqual({ dir: '/home/u', into: 'pane' })
    expect(resolveDropTarget('/home/u', null)).toEqual({ dir: '/home/u', into: 'pane' })
  })
  it('has nowhere to drop at the roots view / without a local folder', () => {
    expect(resolveDropTarget(null, null)).toBeNull()
    expect(resolveDropTarget(null, { name: 'a.txt', isDir: false, path: 'a.txt' })).toBeNull()
    // A folder row still works there (a volume root, say).
    expect(resolveDropTarget(null, { name: 'Data', isDir: true, path: 'D:\\' })).toEqual({ dir: 'D:\\', into: 'row' })
  })
})

describe('chooseFetchTarget', () => {
  it('prefers the open local folder', () => {
    expect(chooseFetchTarget({ localFolderOpen: true, fileSystemAccess: true, directoryPicker: true, count: 1 })).toBe('local-folder')
    expect(chooseFetchTarget({ localFolderOpen: true, fileSystemAccess: false, directoryPicker: false, count: 3 })).toBe('local-folder')
  })
  it('uses the save picker for one file and the directory picker for several', () => {
    expect(chooseFetchTarget({ localFolderOpen: false, fileSystemAccess: true, directoryPicker: true, count: 1 })).toBe('save-picker')
    expect(chooseFetchTarget({ localFolderOpen: false, fileSystemAccess: true, directoryPicker: true, count: 2 })).toBe('directory-picker')
  })
  it('falls back to browser downloads without the File System Access API', () => {
    expect(chooseFetchTarget({ localFolderOpen: false, fileSystemAccess: false, directoryPicker: false, count: 1 })).toBe('browser-download')
    expect(chooseFetchTarget({ localFolderOpen: false, fileSystemAccess: true, directoryPicker: false, count: 2 })).toBe('browser-download')
  })
})

describe('dragKind and the drag payload', () => {
  it('tells internal drags from OS file drags', () => {
    expect(dragKind([LOCAL_DRAG_TYPE])).toBe('local')
    expect(dragKind([REMOTE_DRAG_TYPE, 'text/plain'])).toBe('remote')
    expect(dragKind(['Files'])).toBe('os')
    expect(dragKind(['text/plain'])).toBeNull()
    expect(dragKind(null)).toBeNull()
  })
  it('hands the payload over exactly once', () => {
    setDragPayload({ kind: 'local', names: ['a.txt'] })
    expect(peekDragPayload()).toEqual({ kind: 'local', names: ['a.txt'] })
    expect(takeDragPayload()).toEqual({ kind: 'local', names: ['a.txt'] })
    expect(takeDragPayload()).toBeNull()
  })
})

describe('localReducer', () => {
  it('opens a root, lists it and navigates into folders and back', () => {
    let s = run([{ type: 'root', name: 'Projects', access: 'granted' }])
    expect(s.access).toBe('granted')
    expect(s.loading).toBe(true)
    const gen = s.generation
    s = localReducer(s, { type: 'listed', generation: gen, entries: [entry('site', true), entry('a.txt', false, 5)] })
    expect(s.loading).toBe(false)
    expect(visibleLocal(s).map((e) => e.name)).toEqual(['site', 'a.txt'])

    s = localReducer(s, { type: 'enter', name: 'a.txt' })
    expect(s.segments).toEqual([])
    s = localReducer(s, { type: 'enter', name: 'site' })
    expect(s.segments).toEqual(['site'])
    expect(s.loading).toBe(true)
    expect(s.generation).toBe(gen + 1)
    expect(localPathLabel(s)).toBe('Projects/site')

    // A listing of the folder we already left is ignored.
    s = localReducer(s, { type: 'listed', generation: gen, entries: [entry('stale')] })
    expect(s.entries).toEqual([])
    s = localReducer(s, { type: 'listed', generation: s.generation, entries: [entry('index.html')] })
    expect(s.entries.map((e) => e.name)).toEqual(['index.html'])

    s = localReducer(s, { type: 'up' })
    expect(s.segments).toEqual([])
    s = run([{ type: 'enter', name: 'x' }], s)
    expect(s.segments).toEqual([])
  })

  it('goto clamps to the crumb depth and refresh bumps the generation', () => {
    let s = listed([entry('a', true)])
    s = localReducer(s, { type: 'listed', generation: s.generation, entries: [entry('a', true)] })
    s = localReducer(s, { type: 'enter', name: 'a' })
    s = localReducer(s, { type: 'listed', generation: s.generation, entries: [entry('b', true)] })
    s = localReducer(s, { type: 'enter', name: 'b' })
    expect(s.segments).toEqual(['a', 'b'])
    s = localReducer(s, { type: 'goto', depth: 1 })
    expect(s.segments).toEqual(['a'])
    const g = s.generation
    expect(localReducer(s, { type: 'goto', depth: 1 })).toBe(s)
    expect(localReducer(s, { type: 'refresh' }).generation).toBe(g + 1)
    expect(localReducer(s, { type: 'goto', depth: 0 }).segments).toEqual([])
  })

  it('remembers the root but not access when permission must be re-granted', () => {
    let s = run([{ type: 'root', name: 'Docs', access: 'prompt' }])
    expect(s.access).toBe('prompt')
    expect(s.loading).toBe(false)
    expect(localReducer(s, { type: 'refresh' })).toBe(s)
    s = localReducer(s, { type: 'granted' })
    expect(s.access).toBe('granted')
    expect(s.loading).toBe(true)
    s = localReducer(s, { type: 'close' })
    expect(s.access).toBe('closed')
    expect(s.rootName).toBeNull()
  })

  it('selects single, toggle and ranges in visible order', () => {
    let s = listed([entry('c'), entry('a'), entry('b'), entry('.hidden')])
    expect(visibleLocal(s).map((e) => e.name)).toEqual(['a', 'b', 'c'])
    s = localReducer(s, { type: 'select', name: 'a', mode: 'single' })
    s = localReducer(s, { type: 'select', name: 'c', mode: 'range' })
    expect([...s.selected]).toEqual(['a', 'b', 'c'])
    s = localReducer(s, { type: 'select', name: 'b', mode: 'toggle' })
    expect([...s.selected].sort()).toEqual(['a', 'c'])
    expect(localReducer(s, { type: 'select', name: '.hidden', mode: 'single' })).toBe(s)
    s = localReducer(s, { type: 'hidden', show: true })
    s = localReducer(s, { type: 'select-all' })
    expect(s.selected.size).toBe(4)
    s = localReducer(s, { type: 'clear' })
    expect(s.selected.size).toBe(0)
  })

  it('keyboard focus moves, clamps and extends with shift', () => {
    let s = listed([entry('b'), entry('a'), entry('c')])
    s = localReducer(s, { type: 'move', delta: 1, extend: false })
    expect(s.focus).toBe('a')
    expect([...s.selected]).toEqual(['a'])
    s = localReducer(s, { type: 'move', delta: 1, extend: true })
    expect(s.focus).toBe('b')
    expect([...s.selected]).toEqual(['a', 'b'])
    s = localReducer(s, { type: 'move', delta: 1, extend: false })
    s = localReducer(s, { type: 'move', delta: 1, extend: false })
    expect(s.focus).toBe('c')
    s = localReducer(s, { type: 'move', delta: -1, extend: false })
    expect(s.focus).toBe('b')
    // Nothing focused: ↑ starts at the bottom.
    const fresh = listed([entry('x'), entry('y')])
    expect(localReducer(fresh, { type: 'move', delta: -1, extend: false }).focus).toBe('y')
  })

  it('sorts folders first and toggles column direction', () => {
    let s = listed([entry('big', false, 300, 3), entry('dir', true), entry('small', false, 1, 1)])
    s = localReducer(s, { type: 'sort', key: 'size' })
    expect(s.sort).toEqual({ key: 'size', dir: 'desc' })
    expect(visibleLocal(s).map((e) => e.name)).toEqual(['dir', 'big', 'small'])
    s = localReducer(s, { type: 'sort', key: 'size' })
    expect(visibleLocal(s).map((e) => e.name)).toEqual(['dir', 'small', 'big'])
    s = localReducer(s, { type: 'query', value: 'BIG' })
    expect(visibleLocal(s).map((e) => e.name)).toEqual(['big'])
  })

  it('drops the selection of rows that vanished from a relisting', () => {
    let s = listed([entry('a'), entry('b')])
    s = localReducer(s, { type: 'select-all' })
    s = localReducer(s, { type: 'listed', generation: s.generation, entries: [entry('a')] })
    expect([...s.selected]).toEqual(['a'])
  })
})
