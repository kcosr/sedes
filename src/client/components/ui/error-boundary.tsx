import * as React from "react"

type ErrorBoundaryFallbackProps = {
  error: Error
  /** Renders the children again, as a fresh mount. */
  reset: () => void
}

type ErrorBoundaryProps = {
  children?: React.ReactNode
  /** What renders in place of children that threw while rendering. */
  fallback: (props: ErrorBoundaryFallbackProps) => React.ReactNode
  /** A change to any of these after a failure renders the children again. */
  resetKeys?: readonly unknown[]
  onError?: (error: Error, info: React.ErrorInfo) => void
}

type ErrorBoundaryState = { error: Error | null }

function asError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(typeof value === "string" && value ? value : "Something went wrong.")
}

function keysChanged(previous: readonly unknown[] = [], next: readonly unknown[] = []): boolean {
  return previous.length !== next.length || previous.some((key, index) => !Object.is(key, next[index]))
}

/**
 * Contains a render failure: the children are replaced by `fallback`, and
 * everything outside the boundary keeps working. Renders nothing of its own
 * while the children render, so it never changes their markup. React still
 * reports the caught error to the console.
 */
class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: asError(error) }
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    this.props.onError?.(asError(error), info)
  }

  override componentDidUpdate(previous: ErrorBoundaryProps, previousState: ErrorBoundaryState): void {
    // Only a change after the failure retries; the update that failed keeps its fallback.
    if (previousState.error && this.state.error && keysChanged(previous.resetKeys, this.props.resetKeys)) {
      this.reset()
    }
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  override render(): React.ReactNode {
    const { error } = this.state
    return error ? this.props.fallback({ error, reset: this.reset }) : this.props.children
  }
}

export { ErrorBoundary }
export type { ErrorBoundaryFallbackProps, ErrorBoundaryProps }
