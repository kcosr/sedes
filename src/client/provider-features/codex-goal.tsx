import * as Popover from "@radix-ui/react-popover";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type {
  BoundedValue,
  ProviderFeatureStateEnvelope,
} from "../../shared/index.js";
import type { ClientProviderFeatureModule } from "./registry.js";
import { Button } from "@client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@client/components/ui/dialog";

const ref = Object.freeze({
  featureId: "codex.goal",
  schemaVersion: 1,
} as const);

const CODEX_GOAL_OBJECTIVE_MAX_SCALARS = 4_000;
const CODEX_GOAL_OBJECTIVE_MAX_UTF8_BYTES = 16 * 1_024;

type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete";

type GoalState =
  | { readonly state: "unset" }
  | {
      readonly state: "set";
      readonly objective: string;
      readonly status: GoalStatus;
    };

const statusLabels: Readonly<Record<GoalStatus, string>> = Object.freeze({
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usage_limited: "Usage limited",
  budget_limited: "Budget limited",
  complete: "Complete",
});

export const codexGoalClientFeature: ClientProviderFeatureModule = {
  ref,
  renderThreadDetails() {
    return null;
  },
  renderComposerAction(input) {
    return <CodexGoalComposerControl {...input} />;
  },
};

function CodexGoalComposerControl({
  store,
  capability,
  featureState,
  disabled,
  mobile,
}: Parameters<
  NonNullable<ClientProviderFeatureModule["renderComposerAction"]>
>[0]): React.JSX.Element {
  const state = decodeGoalState(featureState);
  const [open, setOpen] = useState(false);
  const [objective, setObjective] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const objectiveId = useId();
  const errorId = useId();
  const objectiveRef = useRef<HTMLTextAreaElement | null>(null);
  const keyboardInset = useKeyboardInset(mobile && open);

  useEffect(() => {
    if (open && state?.state === "unset") {
      objectiveRef.current?.focus();
    }
  }, [open, state?.state]);

  if (!state || !featureState) {
    return <></>;
  }

  const operation = (actionId: string) =>
    capability.operations.find(
      (candidate) =>
        candidate.actionId === actionId &&
        capability.availability === "available",
    );
  const unavailable =
    disabled ||
    capability.availability !== "available" ||
    pendingAction !== null;
  const indicatorLabel = accessibleIndicatorName(state);
  const indicatorClass =
    state.state === "unset"
      ? "codex-goal-indicator unset"
      : `codex-goal-indicator set status-${state.status}`;

  const run = async (
    actionId: string,
    argumentsValue: BoundedValue,
  ): Promise<void> => {
    if (!operation(actionId) || !featureState) return;
    setPendingAction(actionId);
    setError("");
    try {
      const result = await store.perform({
        action: "perform_provider_feature",
        feature: ref,
        actionId,
        arguments: argumentsValue,
        expectedFeatureRevision: featureState.revision,
      });
      if (result.status === "recovery_required") {
        // Keep the popover open with an explicit uncertain state — Goal
        // receipts are not tracked by the global recovery callout.
        setError(
          "The Goal change could not be confirmed. Refresh the thread or try again after the connection settles.",
        );
        return;
      }
      setOpen(false);
      setObjective("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The Goal action could not be completed.",
      );
    } finally {
      setPendingAction(null);
    }
  };

  const submitCreate = (): void => {
    const normalized = objective.trim();
    const validation = validateObjective(normalized);
    if (!validation.ok) {
      setError(validation.reason);
      return;
    }
    void run("create", objectValue({ objective: { text: normalized } }));
  };

  const indicatorTitle =
    state.state === "unset"
      ? "Set goal"
      : `Goal: ${statusLabels[state.status]}`;

  const setPresentationOpen = (nextOpen: boolean): void => {
    if (!nextOpen && pendingAction !== null) return;
    setOpen(nextOpen);
  };

  const trigger = (
    <button
      type="button"
      className={indicatorClass}
      aria-label={indicatorLabel}
      title={indicatorTitle}
      disabled={disabled && capability.availability !== "available"}
    >
      <svg
        className="codex-goal-icon"
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="3.5" />
      </svg>
    </button>
  );

  const body = (
    <>
      <p className="codex-goal-popover-title" aria-hidden="true">
        Goal
      </p>
      {state.state === "unset" ? (
        <form
          className="codex-goal-create"
          onSubmit={(event) => {
            event.preventDefault();
            submitCreate();
          }}
        >
          <label htmlFor={objectiveId}>Objective</label>
          <textarea
            id={objectiveId}
            ref={objectiveRef}
            rows={4}
            value={objective}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            disabled={unavailable || !operation("create")}
            onChange={(event) => {
              setObjective(event.target.value);
              if (error) setError("");
            }}
            onKeyDown={(event) => {
              // Cmd/Ctrl+Enter submits, mirroring the composer's
              // modifier-key convention (e.g. Ctrl/⌘+S to stash).
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                if (unavailable || !operation("create")) return;
                submitCreate();
              }
            }}
          />
          <div className="codex-goal-actions">
            <Button
              type="submit"
              size="sm"
              disabled={
                unavailable ||
                !operation("create") ||
                objective.trim().length === 0
              }
            >
              {pendingAction === "create" ? "Starting…" : "Start goal"}
            </Button>
          </div>
        </form>
      ) : (
        <div className="codex-goal-details">
          <p className="codex-goal-status-line">
            Status: {statusLabels[state.status]}
          </p>
          <p className="codex-goal-full-objective">{state.objective}</p>
          <div className="codex-goal-actions">
            {operation("clear") && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={unavailable}
                onClick={() => void run("clear", emptyObjectValue())}
              >
                {pendingAction === "clear" ? "Clearing…" : "Clear"}
              </Button>
            )}
            {operation("pause") && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={unavailable}
                onClick={() => void run("pause", emptyObjectValue())}
              >
                {pendingAction === "pause" ? "Pausing…" : "Pause"}
              </Button>
            )}
            {operation("resume") && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={unavailable}
                onClick={() => void run("resume", emptyObjectValue())}
              >
                {pendingAction === "resume" ? "Resuming…" : "Resume"}
              </Button>
            )}
          </div>
        </div>
      )}
      {pendingAction && (
        <p className="codex-goal-pending" role="status">
          Updating Goal…
        </p>
      )}
      {error && (
        <p className="codex-goal-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </>
  );

  return (
    <div className="codex-goal-composer">
      {mobile ? (
        <Dialog open={open} onOpenChange={setPresentationOpen}>
          <DialogTrigger asChild>{trigger}</DialogTrigger>
          <DialogContent
            className="codex-goal-mobile-card"
            aria-describedby={undefined}
            showCloseButton={pendingAction === null}
            style={
              {
                "--codex-goal-keyboard-inset": `${keyboardInset}px`,
              } as CSSProperties
            }
            onOpenAutoFocus={(event) => {
              if (state.state !== "unset") return;
              event.preventDefault();
              objectiveRef.current?.focus();
            }}
            onEscapeKeyDown={(event) => {
              if (pendingAction !== null) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (pendingAction !== null) event.preventDefault();
            }}
          >
            <DialogTitle className="sr-only">Goal</DialogTitle>
            {body}
          </DialogContent>
        </Dialog>
      ) : (
        <Popover.Root open={open} onOpenChange={setPresentationOpen}>
          <Popover.Trigger asChild>{trigger}</Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              className="codex-goal-popover"
              role="dialog"
              aria-label="Goal"
              side="top"
              align="end"
              sideOffset={8}
              onEscapeKeyDown={(event) => {
                if (pendingAction !== null) event.preventDefault();
              }}
              onPointerDownOutside={(event) => {
                if (pendingAction !== null) event.preventDefault();
              }}
            >
              {body}
              <Popover.Arrow className="popover-arrow" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
    </div>
  );
}

/** Lift the inset mobile card above Android's resized visual viewport. */
function useKeyboardInset(enabled: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const update = () => {
      setInset(
        Math.max(
          0,
          Math.round(window.innerHeight - viewport.height - viewport.offsetTop),
        ),
      );
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [enabled]);
  return enabled ? inset : 0;
}

function accessibleIndicatorName(state: GoalState): string {
  if (state.state === "unset") return "Goal, unset";
  return `Goal, ${statusLabels[state.status]}: ${state.objective}`;
}

function decodeGoalState(
  envelope: ProviderFeatureStateEnvelope | undefined,
): GoalState | undefined {
  if (
    !envelope ||
    envelope.ref.featureId !== ref.featureId ||
    envelope.ref.schemaVersion !== ref.schemaVersion
  ) {
    return undefined;
  }
  const state = decodeObject(envelope.state);
  if (!state) return undefined;
  const kind = decodeText(state.state);
  if (kind === "unset") {
    return Object.keys(state).length === 1 ? { state: "unset" } : undefined;
  }
  if (kind !== "set") return undefined;
  const objective = decodeText(state.objective);
  const status = decodeText(state.status) as GoalStatus | undefined;
  if (
    !objective ||
    !status ||
    !(status in statusLabels) ||
    Object.keys(state).length !== 3
  ) {
    return undefined;
  }
  return { state: "set", objective, status };
}

function decodeObject(
  value: BoundedValue | undefined,
): Readonly<Record<string, BoundedValue>> | undefined {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    !("kind" in value) ||
    value.kind !== "object"
  ) {
    return undefined;
  }
  return Object.fromEntries(
    value.entries.map(({ key, value: entry }) => [key.text, entry]),
  );
}

function decodeText(value: BoundedValue | undefined): string | undefined {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    !("text" in value) ||
    typeof value.text !== "string"
  ) {
    return undefined;
  }
  return value.text;
}

function emptyObjectValue(): BoundedValue {
  return { kind: "object", entries: [] };
}

function objectValue(
  value: Readonly<Record<string, BoundedValue>>,
): BoundedValue {
  return {
    kind: "object",
    entries: Object.entries(value).map(([key, entry]) => ({
      key: { text: key },
      value: entry,
    })),
  };
}

function validateObjective(
  objective: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (objective.length === 0) {
    return { ok: false, reason: "Goal objective must not be empty." };
  }
  if ([...objective].length > CODEX_GOAL_OBJECTIVE_MAX_SCALARS) {
    return {
      ok: false,
      reason: `Goal objective must be at most ${CODEX_GOAL_OBJECTIVE_MAX_SCALARS} characters.`,
    };
  }
  if (
    new TextEncoder().encode(objective).byteLength >
    CODEX_GOAL_OBJECTIVE_MAX_UTF8_BYTES
  ) {
    return {
      ok: false,
      reason: "Goal objective is too large.",
    };
  }
  return { ok: true };
}
