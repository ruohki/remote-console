/**
 * Pure geometry for the viewer: where the video content sits inside the <video>
 * element (object-fit: contain) and how element coordinates map to the remote
 * display's physical pixels.
 */

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** Content rectangle of an `object-fit: contain` video inside `box`, in the box's coordinate space. */
export function containRect(box: { width: number; height: number }, video: { width: number; height: number }): Rect {
  if (box.width <= 0 || box.height <= 0 || video.width <= 0 || video.height <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 }
  }
  const scale = Math.min(box.width / video.width, box.height / video.height)
  const width = video.width * scale
  const height = video.height * scale
  return {
    left: Math.max(0, (box.width - width) / 2),
    top: Math.max(0, (box.height - height) / 2),
    width,
    height,
  }
}

/**
 * Map a pointer position (relative to the element's top-left, CSS pixels) to the remote
 * display's physical pixel grid. Returns `null` when the point is outside the content
 * (letterbox bars); coordinates are clamped to the last valid pixel and rounded.
 */
export function toRemotePixels(
  point: { x: number; y: number },
  box: { width: number; height: number },
  video: { width: number; height: number },
): { x: number; y: number } | null {
  const rect = containRect(box, video)
  if (rect.width === 0 || rect.height === 0) return null
  const rx = (point.x - rect.left) / rect.width
  const ry = (point.y - rect.top) / rect.height
  if (rx < 0 || ry < 0 || rx > 1 || ry > 1) return null
  return {
    x: Math.min(video.width - 1, Math.max(0, Math.floor(rx * video.width))),
    y: Math.min(video.height - 1, Math.max(0, Math.floor(ry * video.height))),
  }
}

/** Wheel delta → scroll lines. Browsers report pixels (0), lines (1) or pages (2). */
export function wheelToLines(delta: number, deltaMode: number, lineHeightPx = 16, pageLines = 20): number {
  if (delta === 0) return 0
  switch (deltaMode) {
    case 1:
      return delta
    case 2:
      return delta * pageLines
    default:
      return delta / lineHeightPx
  }
}
