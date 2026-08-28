/**
 * Rich clipboard helpers: classifying what a paste event carries and putting a received
 * image onto the local clipboard.
 */

export interface PasteItemLike {
  kind: string
  type: string
  getAsFile(): File | null
}

export interface ClassifiedPaste {
  /** Image items (screenshots, copied pictures) — sent as `clipboard_image`. */
  images: File[]
  /** Real files copied from a file manager — sent as a `clipboard_files` group. */
  files: File[]
  /** Plain text, when present (kept for the existing text clipboard path). */
  hasText: boolean
}

/**
 * Split clipboard items into images and files. Browsers expose a copied screenshot as a
 * `file` item with an `image/*` type *and* often a text/html sibling; a file copied from
 * Finder/Explorer is a `file` item whose type may be empty. Duplicated representations of
 * the same image (png + html) collapse to one image.
 */
export function classifyPasteItems(items: readonly PasteItemLike[]): ClassifiedPaste {
  const images: File[] = []
  const files: File[] = []
  let hasText = false
  for (const it of items) {
    if (it.kind === 'string') {
      if (it.type === 'text/plain') hasText = true
      continue
    }
    if (it.kind !== 'file') continue
    const f = it.getAsFile()
    if (!f) continue
    if (/^image\//i.test(f.type) && looksLikeClipboardImage(f)) images.push(f)
    else files.push(f)
  }
  return { images, files, hasText }
}

/** A copied image usually has no real file name ("image.png") — a *file* copied from disk has one. */
function looksLikeClipboardImage(f: File): boolean {
  return f.name === '' || /^image\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(f.name) || f.lastModified === 0 || Date.now() - f.lastModified < 5000
}

/** Convert any raster blob into PNG (the agent only accepts PNG for `clipboard_image`). */
export async function toPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas unavailable')
    ctx.drawImage(bitmap, 0, 0)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'))
  } finally {
    bitmap.close()
  }
}

/** Must be called from a user gesture in most browsers. */
export async function writeImageToClipboard(png: Blob): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('This browser cannot write images to the clipboard.')
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

export function clipboardImageName(now = Date.now()): string {
  const d = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `clipboard-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`
}
