import { Component, type ErrorInfo, type ReactNode, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { Button, CopyButton } from './ui'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
  info: ErrorInfo | null
}

/** Catches render errors anywhere below and explains them instead of a blank page. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info })
    console.error('Unhandled render error', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return <ErrorScreen error={this.state.error} componentStack={this.state.info?.componentStack ?? undefined} />
  }
}

export function ErrorScreen({ error, componentStack }: { error: Error; componentStack?: string }) {
  const [showStack, setShowStack] = useState(false)
  const details = [
    `Remote Console — client error`,
    `Time: ${new Date().toISOString()}`,
    `URL: ${location.href}`,
    `Browser: ${navigator.userAgent}`,
    ``,
    `${error.name}: ${error.message}`,
    error.stack ?? '',
    componentStack ? `\nComponent stack:${componentStack}` : '',
  ].join('\n')

  return (
    <div className="flex min-h-full items-center justify-center bg-ground p-6">
      <div className="panel w-full max-w-2xl p-6">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-danger-soft p-2 text-danger">
            <AlertTriangle size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-[16px] font-semibold">Something broke in the console</h1>
            <p className="mt-1 text-ink-muted">
              The page hit an error it could not recover from. Reloading usually fixes it. If it keeps happening, copy the details below and
              send them to whoever runs this console.
            </p>
            <div className="mono mt-4 rounded-md border border-line bg-raised p-3 break-words whitespace-pre-wrap text-danger">
              {error.name}: {error.message}
            </div>
            <button className="mt-3 inline-flex items-center gap-1 text-[12.5px] text-ink-muted hover:text-ink" onClick={() => setShowStack((v) => !v)}>
              {showStack ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {showStack ? 'Hide' : 'Show'} technical details
            </button>
            {showStack && (
              <pre className="mono mt-2 max-h-72 overflow-auto rounded-md border border-line bg-raised p-3 text-[11px] leading-relaxed whitespace-pre-wrap text-ink-muted">
                {error.stack}
                {componentStack && `\n\nComponent stack:${componentStack}`}
              </pre>
            )}
            <div className="mt-5 flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => location.reload()}>
                Reload the console
              </Button>
              <Button onClick={() => (location.href = '/')}>Go to devices</Button>
              <CopyButton text={details} label="Copy details" size="md" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
