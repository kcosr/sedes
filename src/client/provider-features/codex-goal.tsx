import { useEffect, useId, useRef, useState } from "react";
import type {
  BoundedValue,
  ProviderFeatureStateEnvelope,
} from "../../shared/index.js";
import type { ClientProviderFeatureModule } from "./registry.js";
import { Button } from "@client/components/ui/button";
import { Callout } from "@client/components/ui/callout";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@client/components/ui/dialog";
import { eyebrowClass } from "@client/components/ui/floating";
import { Label } from "@client/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@client/components/ui/popover";
import { Textarea } from "@client/components/ui/textarea";
import { cn } from "@client/lib/utils";

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
      {state.state === "unset" ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submitCreate();
          }}
        >
          <Label htmlFor={objectiveId}>Objective</Label>
          <Textarea
            id={objectiveId}
            ref={objectiveRef}
            rows={4}
            className="max-h-64 min-h-24 resize-y"
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
          <div className="flex flex-wrap justify-end gap-2">
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
        <div className="flex flex-col gap-2">
          <p className="m-0 text-(length:--text-meta) font-medium text-muted-foreground">
            Status: {statusLabels[state.status]}
          </p>
          <p className="m-0 leading-(--leading-normal) whitespace-pre-wrap [overflow-wrap:anywhere]">
            {state.objective}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
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
        <p
          className="m-0 text-(length:--text-meta) text-muted-foreground-2"
          role="status"
        >
          Updating Goal…
        </p>
      )}
      {error && (
        <Callout tone="danger" role="alert" id={errorId}>
          {error}
        </Callout>
      )}
    </>
  );

  return (
    <div className="codex-goal-composer">
      {mobile ? (
        <Dialog open={open} onOpenChange={setPresentationOpen}>
          <DialogTrigger asChild>{trigger}</DialogTrigger>
          {/* The first field takes focus; a set Goal opens without the keyboard. */}
          <DialogContent
            layout="sheet"
            aria-describedby={undefined}
            dismissible={pendingAction === null}
          >
            <DialogHeader>
              <DialogTitle>Goal</DialogTitle>
            </DialogHeader>
            {body}
          </DialogContent>
        </Dialog>
      ) : (
        <Popover open={open} onOpenChange={setPresentationOpen}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent
            role="dialog"
            aria-label="Goal"
            side="top"
            align="end"
            className="w-[min(340px,calc(100vw-16px))] p-3"
            onEscapeKeyDown={(event) => {
              if (pendingAction !== null) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (pendingAction !== null) event.preventDefault();
            }}
          >
            <p className={cn(eyebrowClass, "m-0")} aria-hidden="true">
              Goal
            </p>
            {body}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
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
