import { create } from 'zustand'
import type { ControlMessage } from '@/protocol'
import {
  ANNOTATE_COLORS,
  type AnnotateColorId,
  type AnnotateTool,
  type AnnotationLayer,
  type Point,
  type StrokeWidth,
  emptyLayer,
  layerClear,
  layerEnd,
  layerPointer,
  layerPrune,
  layerStroke,
  layerUndo,
  replayMessages,
} from './model'

interface AnnotateStore {
  /** annotate mode is on: pointer events draw instead of controlling */
  enabled: boolean
  tool: AnnotateTool
  color: AnnotateColorId
  width: StrokeWidth
  /** the agent refused annotations (policy or device setting) */
  disabledByDevice: boolean
  layer: AnnotationLayer

  setEnabled: (on: boolean) => void
  setTool: (tool: AnnotateTool) => void
  setColor: (color: AnnotateColorId) => void
  setWidth: (width: StrokeWidth) => void
  setDisabledByDevice: (v: boolean) => void

  /** Apply a message we are sending (or replaying) to the local layer. */
  applyLocal: (msg: ControlMessage, now?: number) => void
  prune: (now?: number) => void
  /** Remove the last stroke; returns the messages to send so the device matches (clear + replay). */
  undo: (now?: number) => ControlMessage[]
  clear: () => void
  /** Reset for a new session (no messages). */
  reset: () => void
}

export const useAnnotate = create<AnnotateStore>((set, get) => ({
  enabled: false,
  tool: 'pen',
  color: 'red',
  width: 'thin',
  disabledByDevice: false,
  layer: emptyLayer,

  setEnabled: (enabled) => set({ enabled }),
  setTool: (tool) => set({ tool }),
  setColor: (color) => set({ color }),
  setWidth: (width) => set({ width }),
  setDisabledByDevice: (disabledByDevice) => set(disabledByDevice ? { disabledByDevice, enabled: false } : { disabledByDevice }),

  applyLocal: (msg, now = Date.now()) => {
    const layer = get().layer
    switch (msg.t) {
      case 'annotate_stroke':
        set({ layer: layerStroke(layer, msg) })
        break
      case 'annotate_end':
        set({ layer: layerEnd(layer, msg.id, now) })
        break
      case 'annotate_pointer':
        set({ layer: layerPointer(layer, msg.display, (msg.point as Point | undefined) ?? null, msg.color, now) })
        break
      case 'annotate_clear':
        set({ layer: layerClear() })
        break
      default:
        break
    }
  },
  prune: (now = Date.now()) => {
    const layer = get().layer
    const next = layerPrune(layer, now)
    if (next !== layer) set({ layer: next })
  },
  undo: (now = Date.now()) => {
    const { layer } = get()
    const { layer: next, removed } = layerUndo(layer, now)
    if (!removed) return []
    set({ layer: next })
    // The protocol has no per-stroke delete: clear everything and replay what is left.
    return [{ t: 'annotate_clear' }, ...replayMessages(next, now)]
  },
  clear: () => set({ layer: layerClear() }),
  reset: () => set({ layer: layerClear(), enabled: false, disabledByDevice: false }),
}))

export function colorValue(id: AnnotateColorId): string {
  return ANNOTATE_COLORS.find((c) => c.id === id)?.value ?? ANNOTATE_COLORS[0].value
}
