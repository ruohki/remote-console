import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { FileMessage } from '@/protocol'
import type { FilesChannel } from './channel'
import { transferManager, useFiles } from './store'
import { FilesDrawer } from './FilesDrawer'

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
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 150)))

function mount(ch: FakeChannel) {
  transferManager.deviceId = 'dev1'
  // The viewer page normally routes listings into the store.
  transferManager.callbacks = { onListing: (l) => useFiles.getState().setListing({ path: l.path, entries: l.entries, error: l.error }) }
  transferManager.attach(ch)
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <FilesDrawer deviceId="dev1" enabled onClose={() => undefined} />
    </QueryClientProvider>,
  )
}

describe('FilesDrawer', () => {
  let ch: FakeChannel
  beforeEach(() => {
    ch = new FakeChannel()
    useFiles.setState({ listing: null, listingPath: null, listingLoading: false, transfers: [] })
  })
  afterEach(() => {
    transferManager.cancelAll()
    transferManager.clearFinished()
    transferManager.detach()
  })

  it('shows the empty state, then a running upload with the summary strip and compression control', async () => {
    mount(ch)
    expect(screen.getByText('No transfers yet')).toBeInTheDocument()
    expect(screen.getByLabelText('Compression')).toBeInTheDocument()

    await act(async () => {
      await transferManager.upload(new File([new Uint8Array(200_000)], 'report.txt'))
    })
    await settle()
    const offer = ch.last('offer')!
    expect(screen.getByText('report.txt')).toBeInTheDocument()
    expect(screen.getByText(/In progress/)).toBeInTheDocument()
    expect(screen.getByText('Waiting for the device')).toBeInTheDocument()

    act(() => ch.recv({ t: 'accept', transfer_id: offer.transfer_id, offset: 0n, codecs: ['deflate'] }))
    await settle()
    expect(screen.getByTestId('transfer-summary')).toBeInTheDocument()
    act(() => ch.recv({ t: 'done', transfer_id: offer.transfer_id, ok: true, path: '/dev/Downloads/report.txt' }))
    await settle()
    expect(screen.getByText(/Completed/)).toBeInTheDocument()
    expect(screen.getByText('/dev/Downloads/report.txt')).toBeInTheDocument()
    // The compression badge appears: zeros compress extremely well.
    expect(screen.getByText(/×$/)).toBeInTheDocument()
  })

  it('browses a listing with selection, sorting and the bulk bar', async () => {
    mount(ch)
    fireEvent.click(screen.getByRole('tab', { name: 'Browse device' }))
    expect(ch.last('list')).toEqual({ t: 'list' })
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
    await settle()
    const rows = screen.getAllByRole('option')
    expect(rows.map((r) => r.getAttribute('data-name'))).toEqual(['photos', 'big.zip', 'notes.txt'])

    fireEvent.click(screen.getByText('big.zip'))
    fireEvent.click(screen.getByText('notes.txt'), { shiftKey: true })
    expect(screen.getByTestId('bulk-bar')).toHaveTextContent('2 selected')

    fireEvent.click(screen.getByText('Size'))
    expect(screen.getAllByRole('option').map((r) => r.getAttribute('data-name'))).toEqual(['photos', 'big.zip', 'notes.txt'])
    fireEvent.click(screen.getByText('Size'))
    expect(screen.getAllByRole('option').map((r) => r.getAttribute('data-name'))).toEqual(['photos', 'notes.txt', 'big.zip'])

    fireEvent.change(screen.getByLabelText('Filter entries'), { target: { value: 'zip' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)

    fireEvent.change(screen.getByLabelText('Filter entries'), { target: { value: '' } })
    fireEvent.doubleClick(screen.getByText('photos'))
    expect(ch.last('list')).toEqual({ t: 'list', path: '/home/u/photos' })
  })
})
