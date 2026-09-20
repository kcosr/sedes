import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  type DirectoryBrowseRequest,
  type DirectoryBrowseResult,
  type NormalizedEnvironmentSummary,
} from "../../shared/index.js";
import { environmentDisplayLabel } from "../app/sidebar-scope-presentation.js";
import { messageFrom } from "../stores/ApplicationClientStore.js";
import { useKeyboardInset } from "../app/use-keyboard-inset.js";
import { Button } from "./ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { SearchableSelect } from "./ui/searchable-select.js";
import { EnvironmentScopeIcon } from "./scope-selector-icons.js";
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";

const DIRECTORY_PAGE_SIZE = 100;

interface BrowseLocation {
  readonly request: DirectoryBrowseRequest["location"];
  readonly label: string;
}

interface LoadOptions {
  readonly append?: boolean;
  readonly cursor?: string;
  readonly history?: readonly BrowseLocation[];
  readonly focusFirst?: boolean;
}

interface RetryRequest {
  readonly location: DirectoryBrowseRequest["location"];
  readonly options: LoadOptions;
}

export interface DirectoryPickerApi {
  browseExecutionEnvironmentDirectories(
    environmentId: string,
    request: DirectoryBrowseRequest,
    signal?: AbortSignal,
  ): Promise<DirectoryBrowseResult>;
}

export function DirectoryPickerDialog({
  open,
  onOpenChange,
  title,
  description,
  environments,
  environmentId,
  onEnvironmentChange,
  environmentLocked = false,
  mobileSheet = false,
  path,
  onPathChange,
  pathAriaLabel = "Absolute directory path",
  api,
  submitLabel,
  submitting = false,
  submitError,
  onSubmit,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  readonly environments: readonly NormalizedEnvironmentSummary[];
  readonly environmentId: string;
  readonly onEnvironmentChange: (environmentId: string) => void;
  readonly environmentLocked?: boolean;
  readonly mobileSheet?: boolean;
  readonly path: string;
  readonly onPathChange: (path: string) => void;
  readonly pathAriaLabel?: string;
  readonly api: DirectoryPickerApi;
  readonly submitLabel: string;
  readonly submitting?: boolean;
  readonly submitError?: string;
  readonly onSubmit: () => void | Promise<void>;
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  const keyboardInset = useKeyboardInset(open && mobileSheet);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const requestGenerationRef = useRef(0);
  const firstEntryRef = useRef<HTMLButtonElement>(null);
  const shouldFocusEntryRef = useRef(false);
  const [history, setHistory] = useState<readonly BrowseLocation[]>([]);
  const [result, setResult] = useState<DirectoryBrowseResult>();
  const [entries, setEntries] = useState<DirectoryBrowseResult["entries"]>([]);
  const [loading, setLoading] = useState(false);
  const [browseError, setBrowseError] = useState("");
  const [retryRequest, setRetryRequest] = useState<RetryRequest>();
  const environment = environments.find(({ id }) => id === environmentId);
  const browsingAvailable = environment?.directoryBrowsing === "available";
  const currentLocation = history.at(-1);
  const appendError = Boolean(
    browseError && retryRequest?.options.append && entries.length > 0,
  );

  const resetBrowser = () => {
    requestRef.current?.abort();
    requestGenerationRef.current += 1;
    setHistory([]);
    setResult(undefined);
    setEntries([]);
    setLoading(false);
    setBrowseError("");
    setRetryRequest(undefined);
  };

  const load = async (
    location: DirectoryBrowseRequest["location"],
    options: LoadOptions = {},
  ) => {
    if (!environmentId || !browsingAvailable) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    setBrowseError("");
    setRetryRequest(undefined);
    if (!options.append) setEntries([]);
    try {
      const next = await api.browseExecutionEnvironmentDirectories(
        environmentId,
        {
          location,
          pageSize: DIRECTORY_PAGE_SIZE,
          ...(options.cursor ? { cursor: options.cursor } : {}),
        },
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        generation !== requestGenerationRef.current
      )
        return;
      setResult(next);
      setEntries((current) =>
        options.append ? [...current, ...next.entries] : next.entries,
      );
      if (options.history) setHistory(options.history);
      shouldFocusEntryRef.current = options.focusFirst ?? false;
    } catch (error) {
      if (
        controller.signal.aborted ||
        generation !== requestGenerationRef.current
      )
        return;
      setBrowseError(messageFrom(error));
      setRetryRequest({ location, options });
    } finally {
      if (
        !controller.signal.aborted &&
        generation === requestGenerationRef.current
      )
        setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) {
      resetBrowser();
      return;
    }
    if (!environmentId || !browsingAvailable) {
      resetBrowser();
      return;
    }
    void load(
      { kind: "roots" },
      { history: [{ request: { kind: "roots" }, label: "Roots" }] },
    );
    return () => requestRef.current?.abort();
    // A new dialog session or environment always starts at policy roots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browsingAvailable, environmentId, open]);

  useEffect(() => {
    if (!loading && shouldFocusEntryRef.current && entries.length > 0) {
      shouldFocusEntryRef.current = false;
      firstEntryRef.current?.focus();
    }
  }, [entries, loading]);

  const browseTypedPath = () => {
    const typedPath = path.trim();
    if (!typedPath) return;
    const location = { kind: "directory" as const, path: typedPath };
    void load(location, {
      history: [
        { request: { kind: "roots" }, label: "Roots" },
        { request: location, label: typedPath },
      ],
      focusFirst: true,
    });
  };

  const navigateTo = (entry: DirectoryBrowseResult["entries"][number]) => {
    const location = { kind: "directory" as const, path: entry.path };
    onPathChange(entry.path);
    void load(location, {
      history: [
        ...(history.length > 0
          ? history
          : [{ request: { kind: "roots" as const }, label: "Roots" }]),
        { request: location, label: entry.name },
      ],
      focusFirst: true,
    });
  };

  const navigateHistory = (index: number) => {
    const item = history[index];
    if (!item) return;
    void load(item.request, {
      history: history.slice(0, index + 1),
      focusFirst: true,
    });
  };

  const navigateBack = () => {
    if (result?.location.kind !== "directory") {
      navigateHistory(Math.max(0, history.length - 2));
      return;
    }
    const parentPath = result.location.parentPath;
    if (!parentPath) {
      navigateHistory(0);
      return;
    }
    const previousIndex = history.length - 2;
    const previous = history[previousIndex];
    if (
      previous?.request.kind === "directory" &&
      previous.request.path === parentPath
    ) {
      navigateHistory(previousIndex);
      return;
    }
    const parent = { kind: "directory" as const, path: parentPath };
    void load(parent, {
      history: [
        { request: { kind: "roots" }, label: "Roots" },
        {
          request: parent,
          label: parentPath === "/" ? "/" : parentPath.split("/").at(-1)!,
        },
      ],
      focusFirst: true,
    });
  };

  const environmentLabel = useMemo(
    () =>
      environment
        ? environmentDisplayLabel(environment, environments)
        : "Environment unavailable",
    [environment, environments],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !submitting && onOpenChange(next)}
    >
      <DialogContent
        data-mobile-sheet={mobileSheet || undefined}
        style={mobileSheet ? { "--directory-keyboard-inset": `${keyboardInset}px` } as CSSProperties : undefined}
        showCloseButton={false}
        overlayClassName="z-[110]"
        className="directory-picker-dialog z-[111] max-h-[min(90dvh,44rem)] grid-rows-[auto_auto_minmax(8rem,1fr)_auto] sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <label className="grid gap-1">
            <span>Environment</span>
            {environmentLocked ? (
              <Input
                aria-label="Environment"
                value={environmentLabel}
                readOnly
              />
            ) : (
              <SearchableSelect
                label="Directory environment"
                searchLabel="Search environments"
                emptyLabel="No matching environments"
                placeholder="Choose environment"
                disabled={submitting}
                value={environmentId}
                contentClassName="z-[112]"
                options={environments.map((option) => ({
                  value: option.id,
                  label: `${environmentDisplayLabel(option, environments)}${option.available ? "" : " — Unavailable"}`,
                  icon: <EnvironmentScopeIcon kind={option.kind} />,
                  searchTerms: [option.kind],
                }))}
                onValueChange={(nextEnvironmentId) => {
                  if (nextEnvironmentId === environmentId) return;
                  onPathChange("");
                  onEnvironmentChange(nextEnvironmentId);
                  resetBrowser();
                }}
              />
            )}
          </label>

          <label className="grid gap-1">
            <span>Absolute path</span>
            <div className="flex gap-2">
              <Input
                aria-label={pathAriaLabel}
                disabled={submitting}
                value={path}
                onChange={(event) => onPathChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && browsingAvailable) {
                    event.preventDefault();
                    browseTypedPath();
                  }
                }}
                placeholder="/path/to/directory"
                autoFocus
              />
              {browsingAvailable && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={!path.trim() || loading}
                  onClick={browseTypedPath}
                >
                  Browse
                </Button>
              )}
            </div>
          </label>
          {children}
        </div>

        <section
          className="min-h-0 overflow-hidden rounded-lg border"
          aria-label="Directory browser"
        >
          {!environmentId ? (
            <p className="p-4 text-muted-foreground">
              Choose an environment to browse its directories.
            </p>
          ) : !browsingAvailable ? (
            <p className="p-4 text-muted-foreground">
              Directory browsing is unavailable for this environment. Enter an
              absolute path manually.
            </p>
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex min-h-10 items-center gap-1 border-b px-2">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Back one directory"
                  disabled={loading || history.length <= 1}
                  onClick={navigateBack}
                >
                  <ArrowLeft />
                </Button>
                <nav
                  aria-label="Directory breadcrumbs"
                  className="flex min-w-0 flex-1 items-center overflow-x-auto overscroll-x-contain"
                >
                  {history.map((item, index) => (
                    <span
                      key={`${item.label}-${index}`}
                      className="flex min-w-0 shrink-0 items-center"
                    >
                      {index > 0 && (
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={
                          index === history.length - 1
                            ? "max-w-[min(8rem,35vw)] justify-start truncate sm:max-w-48"
                            : "max-w-14 justify-start truncate sm:max-w-32"
                        }
                        title={item.label}
                        disabled={loading || index === history.length - 1}
                        onClick={() => navigateHistory(index)}
                      >
                        {item.label}
                      </Button>
                    </span>
                  ))}
                </nav>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="ml-auto shrink-0"
                  aria-label="Refresh directory"
                  disabled={loading || !currentLocation}
                  onClick={() =>
                    currentLocation && void load(currentLocation.request)
                  }
                >
                  <RefreshCw />
                </Button>
              </div>
              <div
                className="min-h-0 flex-1 overflow-y-auto p-1"
              >
                {loading && entries.length === 0 ? (
                  <p
                    className="flex items-center gap-2 p-3 text-muted-foreground"
                    role="status"
                  >
                    <LoaderCircle className="size-4 animate-spin" /> Loading
                    directories…
                  </p>
                ) : browseError && entries.length === 0 ? (
                  <div className="grid gap-2 p-3" role="alert">
                    <p>{browseError}</p>
                    {retryRequest && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="justify-self-start"
                        onClick={() =>
                          void load(
                            retryRequest.location,
                            retryRequest.options,
                          )
                        }
                      >
                        Try again
                      </Button>
                    )}
                  </div>
                ) : entries.length === 0 ? (
                  <p className="p-3 text-muted-foreground">
                    No child directories.
                  </p>
                ) : (
                  <div role="list" aria-label="Directories">
                    {entries.map((entry, index) => (
                      <div role="listitem" key={entry.path}>
                        <button
                          ref={index === 0 ? firstEntryRef : undefined}
                          type="button"
                          aria-label={
                            result?.location.kind === "roots"
                              ? `${entry.name} — ${entry.path}`
                              : undefined
                          }
                          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => navigateTo(entry)}
                        >
                          <Folder className="size-4 shrink-0" />
                          <span className="min-w-0">
                            <span className="block truncate">
                              {entry.name}
                            </span>
                            {result?.location.kind === "roots" && (
                              <span className="block truncate text-xs text-muted-foreground">
                                {entry.path}
                              </span>
                            )}
                          </span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {appendError && retryRequest && (
                  <div className="grid gap-2 p-3" role="alert">
                    <p>{browseError}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="justify-self-start"
                      onClick={() =>
                        void load(
                          retryRequest.location,
                          retryRequest.options,
                        )
                      }
                    >
                      Try loading more again
                    </Button>
                  </div>
                )}
                {result?.nextCursor && !appendError && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    disabled={loading || !currentLocation}
                    onClick={() =>
                      currentLocation &&
                      void load(currentLocation.request, {
                        append: true,
                        cursor: result.nextCursor,
                      })
                    }
                  >
                    {loading ? "Loading…" : "Load more"}
                  </Button>
                )}
                {result?.truncated && (
                  <p className="p-3 text-sm text-muted-foreground" role="status">
                    This directory reached the browsing safety limit. Enter a
                    path manually if the directory you need is not shown.
                  </p>
                )}
              </div>
            </div>
          )}
        </section>

        {submitError && (
          <p className="text-destructive" role="alert">
            {submitError}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={submitting || !environment || !path.trim()}
            onClick={() => void onSubmit()}
          >
            {submitting ? `${submitLabel}…` : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
