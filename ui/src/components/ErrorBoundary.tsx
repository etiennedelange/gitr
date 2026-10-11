import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

/** Keeps a rendering failure in one view from blanking the whole window. Give it a `key` that changes with the view so navigating away clears the error. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('View crashed:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="banner error selectable" role="alert">
        <p>
          <strong>This view hit an unexpected error.</strong> Your repositories and files are not affected.
        </p>
        <p className="mono small">{error.message}</p>
        <button onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    )
  }
}
