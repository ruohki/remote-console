import { describe, expect, it } from 'vitest'
import { appendPage, firstPage, goNext, goPrev, idCursor, isLastPage, pageNumber, reset, slicePage, timeCursor } from './paging'

describe('cursor page state', () => {
  it('starts on page 1 without a cursor and walks forward/back', () => {
    let s = firstPage<string>()
    expect(pageNumber(s)).toBe(1)
    expect(s.current).toBeUndefined()

    s = goNext(s, 'c1')
    expect(pageNumber(s)).toBe(2)
    expect(s.current).toBe('c1')

    s = goNext(s, 'c2')
    expect(pageNumber(s)).toBe(3)

    s = goPrev(s)
    expect(pageNumber(s)).toBe(2)
    expect(s.current).toBe('c1')

    s = goPrev(s)
    expect(pageNumber(s)).toBe(1)
    expect(s.current).toBeUndefined()

    // going back from page 1 is a no-op
    expect(goPrev(s)).toEqual(s)
    expect(reset()).toEqual(firstPage())
  })

  it('detects the last page from a short result', () => {
    expect(isLastPage(25, 25)).toBe(false)
    expect(isLastPage(24, 25)).toBe(true)
    expect(isLastPage(0, 25)).toBe(true)
  })
})

describe('cursors', () => {
  it('derive from the last row', () => {
    expect(timeCursor([{ started_at: '2026-01-01T00:00:00Z' }, { started_at: '2025-12-31T00:00:00Z' }])).toBe('2025-12-31T00:00:00Z')
    expect(timeCursor([])).toBeUndefined()
    expect(idCursor([{ id: 10 }, { id: 9 }])).toBe('9')
    expect(idCursor([{ id: 'a' }])).toBe('a')
    expect(idCursor([])).toBeUndefined()
  })
})

describe('appendPage', () => {
  it('appends only rows that are not already shown and keeps identity when nothing is new', () => {
    const shown = [{ id: 'a' }, { id: 'b' }]
    expect(appendPage(shown, [{ id: 'b' }, { id: 'c' }])).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    expect(appendPage(shown, [{ id: 'a' }])).toBe(shown)
  })
})

describe('slicePage', () => {
  it('clamps the page number and reports the page count', () => {
    const rows = Array.from({ length: 230 }, (_, i) => i)
    expect(slicePage(rows, 1, 100)).toMatchObject({ page: 1, pages: 3 })
    expect(slicePage(rows, 3, 100).rows).toHaveLength(30)
    expect(slicePage(rows, 9, 100)).toMatchObject({ page: 3 })
    expect(slicePage(rows, 0, 100)).toMatchObject({ page: 1 })
    expect(slicePage([], 1, 100)).toMatchObject({ page: 1, pages: 1, rows: [] })
  })
})
