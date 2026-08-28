import type { FileMessage } from '@/protocol'
import { BUFFERED_LOW_WATER } from './chunk'

/**
 * Minimal abstraction over the `files` RTCDataChannel so the transfer manager can be
 * unit-tested with a fake. Text frames carry JSON `FileMessage`s, binary frames chunks.
 */
export interface FilesChannel {
  readonly open: boolean
  readonly bufferedAmount: number
  sendText(msg: FileMessage): boolean
  sendBinary(frame: ArrayBuffer): boolean
  /** Resolves once `bufferedAmount` dropped below the low-water mark (or the channel closed). */
  waitForDrain(): Promise<void>
  onMessage(cb: (msg: FileMessage | ArrayBuffer) => void): () => void
  onClose(cb: () => void): () => void
}

/** u64 fields are typed `bigint` by ts-rs; JSON has no bigint, so numbers go on the wire. */
function replacer(_k: string, v: unknown) {
  return typeof v === 'bigint' ? Number(v) : v
}

export class RtcFilesChannel implements FilesChannel {
  private msgListeners = new Set<(m: FileMessage | ArrayBuffer) => void>()
  private closeListeners = new Set<() => void>()
  private drainWaiters: (() => void)[] = []
  private readonly dc: RTCDataChannel

  constructor(dc: RTCDataChannel) {
    this.dc = dc
    dc.binaryType = 'arraybuffer'
    dc.bufferedAmountLowThreshold = BUFFERED_LOW_WATER
    dc.onmessage = (ev) => {
      const data = ev.data as unknown
      if (typeof data === 'string') {
        let msg: FileMessage
        try {
          msg = JSON.parse(data) as FileMessage
        } catch {
          return
        }
        for (const l of this.msgListeners) l(msg)
      } else if (data instanceof ArrayBuffer) {
        for (const l of this.msgListeners) l(data)
      } else if (data instanceof Blob) {
        // Safari may still deliver blobs despite binaryType.
        void data.arrayBuffer().then((buf) => {
          for (const l of this.msgListeners) l(buf)
        })
      }
    }
    dc.onbufferedamountlow = () => this.releaseDrain()
    dc.onclose = () => {
      this.releaseDrain()
      for (const l of this.closeListeners) l()
    }
    dc.onerror = () => {
      /* onclose follows */
    }
  }

  get open() {
    return this.dc.readyState === 'open'
  }

  get bufferedAmount() {
    return this.dc.bufferedAmount
  }

  sendText(msg: FileMessage): boolean {
    if (!this.open) return false
    try {
      this.dc.send(JSON.stringify(msg, replacer))
      return true
    } catch {
      return false
    }
  }

  sendBinary(frame: ArrayBuffer): boolean {
    if (!this.open) return false
    try {
      this.dc.send(frame)
      return true
    } catch {
      return false
    }
  }

  waitForDrain(): Promise<void> {
    if (!this.open || this.dc.bufferedAmount <= BUFFERED_LOW_WATER) return Promise.resolve()
    return new Promise((resolve) => {
      this.drainWaiters.push(resolve)
      // Safety net: some engines fire bufferedamountlow only once per crossing.
      setTimeout(() => this.releaseDrain(), 250)
    })
  }

  onMessage(cb: (msg: FileMessage | ArrayBuffer) => void) {
    this.msgListeners.add(cb)
    return () => this.msgListeners.delete(cb)
  }

  onClose(cb: () => void) {
    this.closeListeners.add(cb)
    return () => this.closeListeners.delete(cb)
  }

  private releaseDrain() {
    const waiters = this.drainWaiters
    this.drainWaiters = []
    for (const w of waiters) w()
  }
}
