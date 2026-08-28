import { useCallback, useEffect, useReducer, useRef } from 'react'
import { toast } from '@/lib/toast'
import { directoryPickerAvailable, pickDirectory } from './sinks'
import { initialLocalState, localReducer, type LocalAction, type LocalState } from './managerModel'
import { listLocal, localRootStore, queryAccess, requestAccess, resolveLocalDir } from './localFs'

export interface LocalFolder {
  /** False where the File System Access API is missing (Firefox, Safari): the pane falls back to a pick list. */
  supported: boolean
  state: LocalState
  dispatch: React.Dispatch<LocalAction>
  /** Handle of the folder currently shown (`null` until it has been listed). */
  currentDir: () => FileSystemDirectoryHandle | null
  /** Handle of a folder inside the current one. */
  subDir: (name: string) => Promise<FileSystemDirectoryHandle | null>
  /** Show the directory picker (needs a user gesture). */
  open: () => Promise<void>
  /** Re-request permission on a remembered folder (needs a user gesture). */
  grant: () => Promise<void>
  close: () => Promise<void>
  refresh: () => void
}

/**
 * State and handle plumbing of the local pane: remembers the chosen root per device in
 * IndexedDB, re-checks its permission on mount and lists the folder the pane navigates to.
 */
export function useLocalFolder(deviceId: string): LocalFolder {
  const supported = directoryPickerAvailable()
  const [state, dispatch] = useReducer(localReducer, undefined, initialLocalState)
  const rootRef = useRef<FileSystemDirectoryHandle | null>(null)
  const dirRef = useRef<FileSystemDirectoryHandle | null>(null)

  useEffect(() => {
    if (!supported) return
    let alive = true
    void localRootStore.get(deviceId).then(async (h) => {
      if (!alive || !h) return
      rootRef.current = h
      const perm = await queryAccess(h)
      if (alive) dispatch({ type: 'root', name: h.name, access: perm === 'granted' ? 'granted' : 'prompt' })
    })
    return () => {
      alive = false
    }
  }, [deviceId, supported])

  const { access, generation, segments } = state
  useEffect(() => {
    const root = rootRef.current
    if (access !== 'granted' || !root) return
    let alive = true
    void (async () => {
      try {
        const dir = await resolveLocalDir(root, segments)
        if (!alive) return
        dirRef.current = dir
        const entries = await listLocal(dir)
        if (alive) dispatch({ type: 'listed', generation, entries })
      } catch (e) {
        if (alive) dispatch({ type: 'error', generation, message: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => {
      alive = false
    }
  }, [access, generation, segments])

  const open = useCallback(async () => {
    const h = await pickDirectory()
    if (!h) return
    rootRef.current = h
    dirRef.current = null
    await localRootStore.put(deviceId, h)
    dispatch({ type: 'root', name: h.name, access: 'granted' })
  }, [deviceId])

  const grant = useCallback(async () => {
    const h = rootRef.current
    if (!h) return
    if (await requestAccess(h)) dispatch(access === 'prompt' ? { type: 'granted' } : { type: 'refresh' })
    else toast.error('Access to the folder was not granted')
  }, [access])

  const close = useCallback(async () => {
    rootRef.current = null
    dirRef.current = null
    await localRootStore.clear(deviceId)
    dispatch({ type: 'close' })
  }, [deviceId])

  const refresh = useCallback(() => dispatch({ type: 'refresh' }), [])
  const currentDir = useCallback(() => dirRef.current, [])
  const subDir = useCallback(async (name: string) => {
    const d = dirRef.current
    if (!d) return null
    try {
      return await d.getDirectoryHandle(name)
    } catch {
      return null
    }
  }, [])

  return { supported, state, dispatch, currentDir, subDir, open, grant, close, refresh }
}
