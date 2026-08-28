import { describe, expect, it } from 'vitest'
import type { FileEntry } from '@/protocol'
import { filterEntries, moveFocus, rangeSelect, sortEntries, toggleSort } from './browseModel'

const e = (name: string, o: Partial<FileEntry> = {}): FileEntry => ({ name, is_dir: false, size: 0n, hidden: false, ...o })

describe('browse model', () => {
  const entries = [e('b.txt', { size: 5n, modified_ms: 30n }), e('src', { is_dir: true }), e('a10.txt', { size: 50n, modified_ms: 10n }), e('a2.txt', { size: 1n, modified_ms: 20n }), e('.hidden', { hidden: true })]

  it('sorts folders first, then by column with natural names', () => {
    expect(sortEntries(entries, 'name', 'asc').map((x) => x.name)).toEqual(['src', '.hidden', 'a2.txt', 'a10.txt', 'b.txt'])
    expect(sortEntries(entries, 'name', 'desc').map((x) => x.name)).toEqual(['src', 'b.txt', 'a10.txt', 'a2.txt', '.hidden'])
    expect(sortEntries(entries, 'size', 'desc').map((x) => x.name)).toEqual(['src', 'a10.txt', 'b.txt', 'a2.txt', '.hidden'])
    expect(sortEntries(entries, 'modified', 'desc').map((x) => x.name)).toEqual(['src', 'b.txt', 'a2.txt', 'a10.txt', '.hidden'])
  })

  it('filters by substring and hidden flag', () => {
    expect(filterEntries(entries, '', false).map((x) => x.name)).not.toContain('.hidden')
    expect(filterEntries(entries, '', true).map((x) => x.name)).toContain('.hidden')
    expect(filterEntries(entries, 'A1', false).map((x) => x.name)).toEqual(['a10.txt'])
  })

  it('range selection and focus movement', () => {
    const names = ['a', 'b', 'c', 'd']
    expect(rangeSelect(names, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeSelect(names, 'd', 'b')).toEqual(['b', 'c', 'd'])
    expect(rangeSelect(names, null, 'c')).toEqual(['c'])
    expect(rangeSelect(names, 'zz', 'c')).toEqual(['c'])
    expect(rangeSelect(names, 'a', 'zz')).toEqual([])
    expect(moveFocus(names, null, 1)).toBe('a')
    expect(moveFocus(names, null, -1)).toBe('d')
    expect(moveFocus(names, 'c', 1)).toBe('d')
    expect(moveFocus(names, 'd', 1)).toBe('d')
    expect(moveFocus(names, 'a', -1)).toBe('a')
    expect(moveFocus([], 'a', 1)).toBeNull()
  })

  it('toggles sort direction on the same column and picks a sensible default otherwise', () => {
    expect(toggleSort({ key: 'name', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'desc' })
    expect(toggleSort({ key: 'name', dir: 'asc' }, 'size')).toEqual({ key: 'size', dir: 'desc' })
    expect(toggleSort({ key: 'size', dir: 'desc' }, 'name')).toEqual({ key: 'name', dir: 'asc' })
  })
})
