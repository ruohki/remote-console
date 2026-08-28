import { describe, expect, it } from 'vitest'
import { classifyPasteItems, clipboardImageName, type PasteItemLike } from './clipboard'

function item(kind: string, type: string, file: File | null): PasteItemLike {
  return { kind, type, getAsFile: () => file }
}

describe('classifyPasteItems', () => {
  it('treats a copied screenshot as an image, not a file', () => {
    const shot = new File([new Uint8Array(10)], 'image.png', { type: 'image/png' })
    const r = classifyPasteItems([item('string', 'text/html', null), item('file', 'image/png', shot)])
    expect(r.images).toEqual([shot])
    expect(r.files).toEqual([])
    expect(r.hasText).toBe(false)
  })

  it('treats files copied from a file manager as files even when they are pictures', () => {
    const photo = new File([new Uint8Array(10)], 'holiday.jpg', { type: 'image/jpeg', lastModified: Date.parse('2024-01-01') })
    const doc = new File([new Uint8Array(10)], 'report.pdf', { type: 'application/pdf', lastModified: Date.parse('2024-01-01') })
    const r = classifyPasteItems([item('file', 'image/jpeg', photo), item('file', 'application/pdf', doc)])
    expect(r.images).toEqual([])
    expect(r.files).toEqual([photo, doc])
  })

  it('flags plain text and skips items without a file', () => {
    const r = classifyPasteItems([item('string', 'text/plain', null), item('file', 'image/png', null)])
    expect(r).toEqual({ images: [], files: [], hasText: true })
  })

  it('names clipboard images by timestamp', () => {
    expect(clipboardImageName(Date.UTC(2026, 0, 2, 3, 4, 5) + new Date(Date.UTC(2026, 0, 2, 3, 4, 5)).getTimezoneOffset() * 60_000)).toBe('clipboard-20260102-030405.png')
  })
})
