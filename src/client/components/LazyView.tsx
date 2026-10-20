import {
  Component,
  lazy,
  Suspense,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { Button } from "@client/components/ui/button";

/** A view's code could not be loaded, as distinct from a view that failed. */
class ViewLoadError extends Error {
  constructor(label: string, options: { readonly cause: unknown }) {
    super(`Could not load ${label}.`, options);
    this.name = "ViewLoadError";
  }
}

type ViewFrame = ComponentType<{ readonly children: ReactNode }>;

function PlainFrame({ children }: { readonly children: ReactNode }): ReactNode {
  return children;
}

/**
 * A route-level view whose code loads as its own chunk the first time it
 * renders. Android and Electron load the chunk from the bundled client; a
 * browser fetches it from the server, where a network failure or an update
 * since the page loaded can make it unavailable. While it loads, and after a
 * failure, the view's place (inside `Frame`) shows a quiet status; a failure
 * offers to try again or reload. Errors thrown by the loaded view itself are
 * not caught here.
 */
export function lazyView<Props extends object>(
  label: string,
  load: () => Promise<ComponentType<Props>>,
  Frame: ViewFrame = PlainFrame,
): ComponentType<Props> {
  const loadView = async () => {
    try {
      return { default: await load() };
    } catch (cause) {
      throw new ViewLoadError(label, { cause });
    }
  };
  // React keeps a failed lazy component failed; a retry needs a fresh one.
  let Loaded = lazy(loadView);
  function LazyView(props: Props): React.JSX.Element {
    const [attempt, setAttempt] = useState(0);
    return (
      <ViewLoadBoundary
        key={attempt}
        label={label}
        Frame={Frame}
        onRetry={() => {
          Loaded = lazy(loadView);
          setAttempt((current) => current + 1);
        }}
      >
        <Suspense
          fallback={
            <Frame>
              <div
                className="lazy-view-state"
                data-testid="lazy-view-loading"
                role="status"
                aria-busy="true"
              >
                <div className="loading-line" aria-hidden="true" />
                <span className="sr-only">Loading {label}…</span>
              </div>
            </Frame>
          }
        >
          <Loaded {...props} />
        </Suspense>
      </ViewLoadBoundary>
    );
  }
  LazyView.displayName = `LazyView(${label})`;
  return LazyView;
}

class ViewLoadBoundary extends Component<
  {
    readonly label: string;
    readonly Frame: ViewFrame;
    readonly onRetry: () => void;
    readonly children: ReactNode;
  },
  { readonly error?: unknown }
> {
  override state: { readonly error?: unknown } = {};

  static getDerivedStateFromError(error: unknown): { readonly error: unknown } {
    return { error };
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === undefined) return this.props.children;
    // Leave the view's own failures to the boundaries above.
    if (!(error instanceof ViewLoadError)) throw error;
    const { Frame, label, onRetry } = this.props;
    return (
      <Frame>
        <div className="lazy-view-state" role="alert">
          <h2>Couldn’t load {label}</h2>
          <p>
            Check the connection to Sedes and try again. If Sedes was updated,
            reload it.
          </p>
          <div className="lazy-view-actions">
            <Button onClick={onRetry}>Try again</Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      </Frame>
    );
  }
}
