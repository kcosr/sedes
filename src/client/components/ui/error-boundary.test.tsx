// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ErrorBoundary } from "@client/components/ui/error-boundary"

let failing = true
function Fragile({ label = "Content" }: { label?: string }) {
  if (failing) throw new Error(`${label} broke`)
  return <p>{label}</p>
}

const fallback = ({ error, reset }: { error: Error; reset: () => void }) => (
  <div role="alert">
    {error.message}
    <button type="button" onClick={reset}>
      Retry
    </button>
  </div>
)

beforeEach(() => {
  failing = true
  // React reports caught render errors to the console.
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("ErrorBoundary", () => {
  it("renders its children's markup unchanged while they render", () => {
    failing = false
    const { container } = render(
      <ErrorBoundary fallback={fallback}>
        <Fragile />
      </ErrorBoundary>,
    )
    expect(container.innerHTML).toBe("<p>Content</p>")
  })

  it("contains a render failure in its fallback and reports it once", () => {
    const onError = vi.fn()
    render(
      <>
        <p>Outside</p>
        <ErrorBoundary fallback={fallback} onError={onError}>
          <Fragile />
        </ErrorBoundary>
      </>,
    )
    expect(screen.getByRole("alert")).toHaveTextContent("Content broke")
    expect(screen.getByText("Outside")).toBeInTheDocument()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error)
    expect(onError.mock.calls[0]![1]).toHaveProperty("componentStack")
  })

  it("wraps a thrown non-Error value", () => {
    function ThrowsString(): React.ReactNode {
      throw "plain failure"
    }
    render(
      <ErrorBoundary fallback={fallback}>
        <ThrowsString />
      </ErrorBoundary>,
    )
    expect(screen.getByRole("alert")).toHaveTextContent("plain failure")
  })

  it("renders the children again on reset", () => {
    render(
      <ErrorBoundary fallback={fallback}>
        <Fragile />
      </ErrorBoundary>,
    )
    failing = false
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByText("Content")).toBeInTheDocument()
  })

  it("retries when a reset key changes after the failure", () => {
    const { rerender } = render(
      <ErrorBoundary fallback={fallback} resetKeys={["first"]}>
        <Fragile label="First" />
      </ErrorBoundary>,
    )
    expect(screen.getByRole("alert")).toHaveTextContent("First broke")
    // The same keys keep the fallback.
    failing = false
    rerender(
      <ErrorBoundary fallback={fallback} resetKeys={["first"]}>
        <Fragile label="First" />
      </ErrorBoundary>,
    )
    expect(screen.getByRole("alert")).toBeInTheDocument()
    rerender(
      <ErrorBoundary fallback={fallback} resetKeys={["second"]}>
        <Fragile label="Second" />
      </ErrorBoundary>,
    )
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByText("Second")).toBeInTheDocument()
  })

  it("retries once per reset key change when the children still fail", () => {
    let attempts = 0
    function Broken({ label }: { label: string }): React.ReactNode {
      attempts++
      throw new Error(`${label} broke`)
    }
    const view = (label: string) => (
      <ErrorBoundary fallback={fallback} resetKeys={[label]}>
        <Broken label={label} />
      </ErrorBoundary>
    )
    const { rerender } = render(view("First"))
    expect(screen.getByRole("alert")).toHaveTextContent("First broke")
    const perAttempt = attempts
    rerender(view("Second"))
    // The change retried, failed again, and settled on the fallback.
    expect(screen.getByRole("alert")).toHaveTextContent("Second broke")
    expect(attempts).toBe(perAttempt * 2)
    rerender(view("Second"))
    expect(attempts).toBe(perAttempt * 2)
  })
})
