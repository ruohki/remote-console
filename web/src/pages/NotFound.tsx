import { Link, useLocation } from 'react-router'
import { Button } from '@/components/ui'

export function NotFound() {
  const { pathname } = useLocation()
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="mono mb-3 inline-flex items-center gap-2 rounded-md border border-line bg-raised px-2 py-1 text-ink-muted">
          <span className="led led-off" />
          404 · no route
        </div>
        <h1 className="text-[22px] font-semibold tracking-tight">This page doesn't exist</h1>
        <p className="mt-2 text-ink-muted">
          Nothing lives at <span className="mono text-ink">{pathname}</span>. The link may be old, or a device or session it pointed to was
          removed.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Link to="/devices">
            <Button variant="primary">Go to devices</Button>
          </Link>
          <Button onClick={() => history.back()}>Go back</Button>
        </div>
      </div>
    </div>
  )
}
