import { create } from 'zustand'
import type { FileEntry, FileMessage } from '@/protocol'
import { TransferManager, type Transfer } from './manager'

/**
 * One manager for the whole app (a single viewer is open at a time). The zustand store
 * mirrors its snapshots plus the remote file browser state so React can subscribe cheaply.
 */
export const transferManager = new TransferManager()

export interface Listing {
  path: string
  entries: FileEntry[]
  error?: string
}

interface FilesStore {
  transfers: Transfer[]
  listing: Listing | null
  listingPath: string | null
  listingLoading: boolean
  setTransfers: (t: Transfer[]) => void
  setListing: (l: Listing | null) => void
  requestListing: (path: string | null) => void
  opResult: (r: Extract<FileMessage, { t: 'op_result' }>) => void
  lastOp: Extract<FileMessage, { t: 'op_result' }> | null
}

export const useFiles = create<FilesStore>((set, get) => ({
  transfers: [],
  listing: null,
  listingPath: null,
  listingLoading: false,
  lastOp: null,
  setTransfers: (transfers) => set({ transfers }),
  setListing: (listing) => set({ listing, listingLoading: false, listingPath: listing?.path ?? get().listingPath }),
  requestListing: (path) => {
    set({ listingLoading: true, listingPath: path })
    transferManager.list(path ?? undefined)
  },
  opResult: (lastOp) => {
    set({ lastOp })
    // refresh the directory we are looking at
    const p = get().listingPath
    if (p !== null || get().listing) get().requestListing(p)
  },
}))

transferManager.subscribe((t) => useFiles.getState().setTransfers(t))

/** Count of transfers that are still moving (badge on the Files button). */
export function activeTransferCount(transfers: Transfer[]): number {
  return transfers.filter((t) => t.status === 'queued' || t.status === 'offered' || t.status === 'transferring' || t.status === 'verifying' || t.status === 'paused').length
}

export const ROOTS_PATH = null
