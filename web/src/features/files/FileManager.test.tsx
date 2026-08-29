import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { FileMessage } from '@/protocol'
import type { FilesChannel } from './channel'
import { transferManager, useFiles } from './store'
import { FileManager } from './FileManager'
import { LOCAL_DRAG_TYPE, REMOTE_DRAG_TYPE } from './managerModel'

class FakeChannel implements FilesChannel {
  open = true
  bufferedAmount = 0
  texts: FileMessage[] = []
  private listeners = new Set<(m: FileMessage | ArrayBuffer) => void>()
  sendText(msg: FileMessage) {
    this.texts.push(JSON.parse(JSON.stringify(msg, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))) as FileMessage)
    return true
  }
  sendBinary() {
    return true
  }
  waitForDrain() {
    return Promise.resolve()
  }
  onMessage(cb: (m: FileMessage | ArrayBuffer) => void) {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  onClose() {
    return () => undefined
  }
  recv(m: FileMessage) {
    for (const l of this.listeners) l(m)
  }
  last<T extends FileMessage['t']>(t: T) {
    return [...this.texts].reverse().find((m) => m.t === t) as Extract<FileMessage, { t: T }> | undefined
  }
  all<T extends FileMessage['t']>(t: T) {
    return this.texts.filter((m) => m.t === t) as Extract<FileMessage, { t: T }>[]
  }
}

/* A fake File System Access directory: enough of the handle API for the local pane. */
type FakeDir = { kind: 'directory'; name: string; children: Map<string, FakeDir | FakeFile>; values(): AsyncIterable<FakeDir | FakeFile>; getDirectoryHandle(n: string): Promise<FakeDir>; getFileHandle(n: string, o?: { create?: boolean }): Promise<FakeFile>; queryPermission(): Promise<'granted'> }
type FakeFile = { kind: 'file'; name: string; file: File; getFile(): Promise<File> }

function fakeFile(name: string, size = 10): FakeFile {
  const file = new File([new Uint8Array(size)], name, { lastModified: 1_700_000_000_000 })
  return { kind: 'file', name, file, getFile: async () => file }
}
function fakeDir(name: string, children: (FakeDir | FakeFile)[]): FakeDir {
  const map = new Map(children.map((c) => [c.name, c]))
  return {
    kind: 'directory',
    name,
    children: map,
    async *values() {
      for (const c of map.values()) yield c
    },
    async getDirectoryHandle(n) {
      const c = map.get(n)
      if (!c || c.kind !== 'directory') throw new Error('NotFoundError')
      return c
    },
    async getFileHandle(n, o) {
      const c = map.get(n)
      if (c && c.kind === 'file') return c
      if (!o?.create) throw new Error('NotFoundError')
      const f = fakeFile(n, 0)
      map.set(n, f)
      return f
    },
    queryPermission: async () => 'granted',
  }
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 120)))

const dt = (types: string[], extra: Partial<DataTransfer> = {}) => ({ types, setData: vi.fn(), getData: vi.fn(), effectAllowed: 'all', dropEffect: 'none', items: [], files: [], ...extra })

function mount(ch: FakeChannel, opts: { connected?: boolean; enabled?: boolean } = {}) {
  transferManager.deviceId = 'dev1'
  transferManager.callbacks = { onListing: (l) => useFiles.getState().setListing({ path: l.path, entries: l.entries, error: l.error }) }
  transferManager.attach(ch)
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <FileManager deviceId="dev1" deviceName="Office PC" enabled={opts.enabled ?? true} connected={opts.connected ?? true} onClose={() => undefined} />
    </QueryClientProvider>,
  )
}

function listHome(ch: FakeChannel) {
  act(() =>
    ch.recv({
      t: 'listing',
      path: '/home/u',
      entries: [
        { name: 'notes.txt', is_dir: false, size: 10n, hidden: false },
        { name: 'photos', is_dir: true, size: 0n, hidden: false },
        { name: 'big.zip', is_dir: false, size: 5000n, hidden: false },
      ],
    }),
  )
}

describe('FileManager', () => {
  let ch: FakeChannel
  let picker: FakeDir
  beforeEach(() => {
    ch = new FakeChannel()
    useFiles.setState({ listing: null, listingPath: null, listingLoading: false, transfers: [] })
    localStorage.clear()
    picker = fakeDir('Projects', [fakeFile('readme.md', 20), fakeDir('site', [fakeFile('index.html', 30), fakeDir('img', [fakeFile('logo.png', 40)])]), fakeFile('.env', 5)])
    Object.assign(window, { showDirectoryPicker: async () => picker })
  })
  afterEach(() => {
    transferManager.cancelAll()
    transferManager.clearFinished()
    transferManager.detach()
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker
  })

  it('shows both panes, the queue, and browses the device on the right', async () => {
    mount(ch)
    expect(screen.getByTestId('local-pane')).toBeInTheDocument()
    expect(screen.getByTestId('remote-pane')).toHaveTextContent('Office PC')
    expect(screen.getByTestId('transfer-queue')).toHaveTextContent('Transfers')
    expect(screen.getByText('No transfers')).toBeInTheDocument()
    expect(ch.last('list')).toEqual({ t: 'list' })
    listHome(ch)
    await settle()
    const remote = within(screen.getByTestId('remote-list'))
    expect(remote.getAllByRole('option').map((r) => r.getAttribute('data-name'))).toEqual(['photos', 'big.zip', 'notes.txt'])
    fireEvent.doubleClick(remote.getByText('photos'))
    expect(ch.last('list')).toEqual({ t: 'list', path: '/home/u/photos' })
    // The destination follows the folder on screen.
    expect(localStorage.getItem('remote.destDir.dev1')).toBe('/home/u')
    expect(screen.getByTestId('transfer-queue')).toHaveTextContent('Compression')
  })

  it('opens a remembered device folder first instead of the roots', () => {
    localStorage.setItem('remote.destDir.dev1', '/srv/drop')
    mount(ch)
    expect(ch.all('list')).toEqual([{ t: 'list', path: '/srv/drop' }])
  })

  it('opens a local folder, navigates it and sends the selection with the button', async () => {
    mount(ch)
    listHome(ch)
    fireEvent.click(screen.getByTestId('local-open'))
    await settle()
    const local = within(screen.getByTestId('local-list'))
    expect(local.getAllByRole('option').map((r) => r.getAttribute('data-name'))).toEqual(['site', 'readme.md'])
    expect(screen.getByTestId('local-path')).toHaveTextContent('Projects')

    fireEvent.doubleClick(local.getByText('site'))
    await settle()
    expect(screen.getByTestId('local-path')).toHaveTextContent('site')
    expect(within(screen.getByTestId('local-list')).getAllByRole('option').map((r) => r.getAttribute('data-name'))).toEqual(['img', 'index.html'])

    fireEvent.click(within(screen.getByTestId('local-list')).getByText('index.html'))
    expect(screen.getByTestId('local-bulk-bar')).toHaveTextContent('1 selected')
    fireEvent.click(screen.getByTestId('send-button'))
    await settle()
    const offer = ch.last('offer')!
    expect(offer.name).toBe('index.html')
    expect(offer.dest_dir).toBe('/home/u')
  })

  it('keyboard: arrows move the local focus, Enter opens, Backspace goes up', async () => {
    mount(ch)
    listHome(ch)
    fireEvent.click(screen.getByTestId('local-open'))
    await settle()
    const list = screen.getByTestId('local-list')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(within(list).getByText('site').closest('[role=option]')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(list, { key: 'ArrowDown', shiftKey: true })
    expect(screen.getByTestId('local-bulk-bar')).toHaveTextContent('2 selected')
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    fireEvent.keyDown(list, { key: 'Enter' })
    await settle()
    expect(screen.getByTestId('local-path')).toHaveTextContent('site')
    fireEvent.keyDown(screen.getByTestId('local-list'), { key: 'Backspace' })
    await settle()
    expect(screen.getByTestId('local-path')).not.toHaveTextContent('site')
  })

  it('drags a local folder onto a device folder row: folders are created and files uploaded there', async () => {
    mount(ch)
    listHome(ch)
    fireEvent.click(screen.getByTestId('local-open'))
    await settle()
    const siteRow = within(screen.getByTestId('local-list')).getByText('site').closest('[role=option]')!
    const transfer = dt([LOCAL_DRAG_TYPE])
    fireEvent.dragStart(siteRow, { dataTransfer: transfer })
    expect(transfer.setData).toHaveBeenCalledWith(LOCAL_DRAG_TYPE, '1')

    const photosRow = within(screen.getByTestId('remote-list')).getByText('photos').closest('[role=option]')!
    fireEvent.dragOver(photosRow, { dataTransfer: transfer })
    expect(photosRow.className).toContain('ring-[#6cb6ff]')
    fireEvent.drop(photosRow, { dataTransfer: transfer })
    await settle()
    expect(ch.all('mkdir').map((m) => m.path)).toEqual(['/home/u/photos/site', '/home/u/photos/site/img'])
    const offers = ch.all('offer')
    expect(offers.map((o) => [o.name, o.dest_dir])).toEqual([
      ['index.html', '/home/u/photos/site'],
      ['logo.png', '/home/u/photos/site/img'],
    ])
    // A drop into a folder row is one-off; the remembered destination stays the folder on screen.
    expect(localStorage.getItem('remote.destDir.dev1')).toBe('/home/u')
  })

  it('drops a local file on empty space of the device pane: it goes to the folder on screen', async () => {
    mount(ch)
    listHome(ch)
    fireEvent.click(screen.getByTestId('local-open'))
    await settle()
    const row = within(screen.getByTestId('local-list')).getByText('readme.md').closest('[role=option]')!
    const transfer = dt([LOCAL_DRAG_TYPE])
    fireEvent.dragStart(row, { dataTransfer: transfer })
    const remote = screen.getByTestId('remote-list')
    fireEvent.dragEnter(remote, { dataTransfer: transfer })
    fireEvent.dragOver(remote, { dataTransfer: transfer })
    expect(remote.className).toContain('ring-[#6cb6ff]')
    fireEvent.drop(remote, { dataTransfer: transfer })
    await settle()
    expect(ch.last('offer')).toMatchObject({ name: 'readme.md', dest_dir: '/home/u' })
    expect(remote.className).not.toContain('ring-[#6cb6ff]')
  })

  it('drags device files into the local folder: the download is written there without a picker', async () => {
    mount(ch)
    listHome(ch)
    fireEvent.click(screen.getByTestId('local-open'))
    await settle()
    const remote = within(screen.getByTestId('remote-list'))
    const row = remote.getByText('notes.txt').closest('[role=option]')!
    const transfer = dt([REMOTE_DRAG_TYPE])
    fireEvent.dragStart(row, { dataTransfer: transfer })
    expect(transfer.setData).toHaveBeenCalledWith(REMOTE_DRAG_TYPE, '1')
    const siteRow = within(screen.getByTestId('local-list')).getByText('site').closest('[role=option]')!
    fireEvent.dragOver(siteRow, { dataTransfer: transfer })
    expect(siteRow.className).toContain('ring-[#34d399]')
    fireEvent.drop(siteRow, { dataTransfer: transfer })
    await settle()
    expect(ch.last('request')).toMatchObject({ path: '/home/u/notes.txt' })
  })

  it('OS file drops on the device pane still upload', async () => {
    mount(ch)
    listHome(ch)
    const file = new File([new Uint8Array(3)], 'drop.bin')
    const remote = screen.getByTestId('remote-list')
    fireEvent.drop(remote, { dataTransfer: dt(['Files'], { files: [file] as unknown as FileList }) })
    await settle()
    expect(ch.last('offer')).toMatchObject({ name: 'drop.bin', dest_dir: '/home/u' })
  })

  it('Fetch button pulls the selected device files', async () => {
    mount(ch)
    listHome(ch)
    fireEvent.click(screen.getByTestId('local-open'))
    await settle()
    expect(screen.getByTestId('fetch-button')).toBeDisabled()
    fireEvent.click(within(screen.getByTestId('remote-list')).getByText('big.zip'))
    expect(screen.getByTestId('fetch-button')).toBeEnabled()
    fireEvent.click(screen.getByTestId('fetch-button'))
    await settle()
    expect(ch.last('request')).toMatchObject({ path: '/home/u/big.zip' })
  })

  it('falls back to a pick list without the File System Access API', () => {
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker
    mount(ch)
    expect(screen.getByTestId('local-pick-pane')).toBeInTheDocument()
  })

  it('explains when transfers are disabled', () => {
    mount(ch, { enabled: false })
    expect(screen.getByText(/File transfer is disabled/)).toBeInTheDocument()
    expect(screen.queryByTestId('transfer-queue')).toBeNull()
  })
})
