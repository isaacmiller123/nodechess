import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

// Catches render-time exceptions anywhere in the tree so a single bad screen
// degrades to a recoverable message instead of a blank white window.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('Renderer error:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="app-error" role="alert" aria-labelledby="app-error-title">
          <div className="panel">
            <h2 id="app-error-title">Something went wrong</h2>
            <p className="muted">A screen hit an unexpected error. Your data is safe.</p>
            <pre className="app-error-detail">{this.state.error.message}</pre>
            <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
