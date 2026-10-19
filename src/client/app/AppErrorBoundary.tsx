import { useState, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@client/components/ui/button";
import { ErrorBoundary } from "@client/components/ui/error-boundary";

/** The error and where it happened, as copied for a bug report. */
export function crashDetails(error: Error, componentStack?: string | null): string {
  return [
    `${error.name}: ${error.message}`,
    error.stack ?? "",
    componentStack ? `Component stack:${componentStack}` : "",
    `Location: ${window.location.pathname}`,
    `User agent: ${navigator.userAgent}`,
  ].filter(Boolean).join("\n\n");
}

/**
 * The last line of defence: a render failure anywhere the panel and
 * transcript boundaries do not cover replaces the app with a recoverable
 * page instead of a blank screen. Packaged clients have no address bar, so
 * the page offers its own Reload.
 */
export function AppErrorBoundary({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const [componentStack, setComponentStack] = useState<string | null>(null);
  return (
    <ErrorBoundary
      onError={(_error, info: ErrorInfo) => setComponentStack(info.componentStack ?? null)}
      fallback={({ error, reset }) => (
        <AppCrash error={error} componentStack={componentStack} reset={reset} />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

function AppCrash({ error, componentStack, reset }: {
  readonly error: Error;
  readonly componentStack: string | null;
  readonly reset: () => void;
}): React.JSX.Element {
  const [copy, setCopy] = useState<"copied" | "failed">();
  return (
    <main className="launch-state">
      <div className="brand-mark error" aria-hidden="true">!</div>
      <p className="eyebrow">Something went wrong</p>
      <h1>Sedes couldn’t display this page</h1>
      <p className="supporting">
        Try again, or reload Sedes. If it keeps happening, copy the details
        for a bug report.
      </p>
      <div className="thread-fatal-actions">
        {/* The focused element went with the page. */}
        <Button autoFocus onClick={reset}>Try again</Button>
        <Button variant="outline" onClick={() => window.location.reload()}>Reload</Button>
        <Button
          variant="outline"
          onClick={() => {
            void navigator.clipboard
              .writeText(crashDetails(error, componentStack))
              .then(() => setCopy("copied"), () => setCopy("failed"));
          }}
        >
          Copy details
        </Button>
      </div>
      <p className="supporting" role="status">
        {copy === "copied" ? "Details copied." : copy === "failed" ? "Couldn’t copy the details." : ""}
      </p>
    </main>
  );
}
