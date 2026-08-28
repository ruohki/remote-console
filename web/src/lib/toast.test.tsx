import { afterEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { Toaster, toast, useToasts } from './toast'

function setFullscreen(el: Element | null) {
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => el })
  document.dispatchEvent(new Event('fullscreenchange'))
}

describe('Toaster', () => {
  afterEach(() => {
    useToasts.setState({ toasts: [] })
    setFullscreen(null)
  })

  it('moves the stack into the fullscreen element so it stays visible there', () => {
    const viewer = document.createElement('div')
    viewer.id = 'viewer-root'
    document.body.appendChild(viewer)
    render(<Toaster />)
    act(() => {
      toast.custom({ kind: 'info', title: 'Office PC says', detail: 'hello', group: 'chat' })
    })
    expect(screen.getByTestId('toaster').closest('#viewer-root')).toBeNull()

    act(() => setFullscreen(viewer))
    expect(screen.getByTestId('toaster').closest('#viewer-root')).toBe(viewer)
    expect(viewer).toHaveTextContent('Office PC says')

    act(() => setFullscreen(null))
    expect(screen.getByTestId('toaster').closest('#viewer-root')).toBeNull()
    viewer.remove()
  })
})
