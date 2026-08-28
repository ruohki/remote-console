import { describe, expect, it } from 'vitest'
import { collectEntry, describeDrop, flattenDrop, isFileDrag, type EntryLike } from './dnd'

const fileEntry = (name: string): EntryLike => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (ok) => ok(new File([name], name)),
})

const dirEntry = (name: string, children: EntryLike[], batch = 2): EntryLike => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let i = 0
    return {
      readEntries: (ok) => {
        const slice = children.slice(i, i + batch)
        i += batch
        ok(slice)
      },
    }
  },
})

describe('drag-and-drop flattening', () => {
  it('flattens nested folders with relative paths, reading readEntries in batches', async () => {
    const tree = dirEntry('docs', [fileEntry('a.txt'), dirEntry('sub', [fileEntry('b.txt'), fileEntry('c.txt')]), fileEntry('d.txt')], 2)
    const out = await collectEntry(tree)
    expect(out.map((f) => f.relativePath)).toEqual(['docs/a.txt', 'docs/sub/b.txt', 'docs/sub/c.txt', 'docs/d.txt'])
    expect(out.every((f) => f.file instanceof File)).toBe(true)
  })

  it('prefers entries over the flat file list, falling back when entries are empty', async () => {
    const withEntries = await flattenDrop({ entries: [fileEntry('x.bin')], files: [new File(['ignored'], 'y.bin')] })
    expect(withEntries.map((f) => f.relativePath)).toEqual(['x.bin'])
    const fallback = await flattenDrop({ entries: [], files: [new File(['1'], 'y.bin'), new File(['2'], 'z.bin')] })
    expect(fallback.map((f) => f.relativePath)).toEqual(['y.bin', 'z.bin'])
  })

  it('detects file drags from the transfer types', () => {
    expect(isFileDrag({ types: ['Files'] } as unknown as DataTransfer)).toBe(true)
    expect(isFileDrag({ types: ['text/plain', 'text/uri-list'] } as unknown as DataTransfer)).toBe(false)
    expect(isFileDrag(null)).toBe(false)
  })

  it('describes drops for humans', () => {
    const f = (p: string) => ({ file: new File([], p.split('/').pop()!), relativePath: p })
    expect(describeDrop([f('a.txt')])).toBe('1 file')
    expect(describeDrop([f('docs/a.txt'), f('docs/b.txt'), f('c.txt')])).toBe('3 files in 1 folder')
  })
})
