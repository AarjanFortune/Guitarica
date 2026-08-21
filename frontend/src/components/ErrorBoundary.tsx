import { Component, ErrorInfo, ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Guitarica crashed:', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="route-empty" role="alert">
        <strong>Something went wrong.</strong>
        <p className="dashboard-muted">Reloading usually fixes this.</p>
        <button type="button" className="primary-action" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
