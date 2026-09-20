import { useState } from "react";
import { Zap } from "lucide-react";
import { Tooltip } from "radix-ui";
import type {
  BoundedValue,
  ProviderFeatureStateEnvelope,
} from "../../shared/index.js";
import type { ClientProviderFeatureModule } from "./registry.js";

const ref = Object.freeze({
  featureId: "codex.fast_mode",
  schemaVersion: 1,
} as const);

type FastModeSelection = "standard" | "fast";
type FastModeApplicationState = "applied" | "pending" | "unknown";

type FastModeState = {
  readonly desired: FastModeSelection | null;
  readonly effective: FastModeSelection | null;
  readonly applicationState: FastModeApplicationState;
};

export const codexFastModeClientFeature: ClientProviderFeatureModule = {
  ref,
  renderThreadDetails() {
    return null;
  },
  renderComposerAction(input) {
    return <CodexFastModeComposerControl {...input} />;
  },
};

function CodexFastModeComposerControl({
  store,
  capability,
  featureState,
  disabled,
}: Parameters<
  NonNullable<ClientProviderFeatureModule["renderComposerAction"]>
>[0]): React.JSX.Element | null {
  const [pending, setPending] = useState(false);
  const state = decodeFastModeState(featureState);
  if (!state || !featureState) return null;

  const pressed = state.desired === "fast";
  const actionId = pressed ? "disable" : "enable";
  const operation = capability.operations.find(
    (candidate) => candidate.actionId === actionId,
  );
  const unavailable =
    disabled ||
    pending ||
    state.desired === null ||
    capability.availability !== "available" ||
    operation === undefined;
  const label = accessibleLabel(state, pending);
  const tooltip =
    unavailable && capability.unavailableReason
      ? capability.unavailableReason.text
      : (capability.description?.text ??
        "Fast mode: about 1.5x speed, higher usage");

  const toggle = (): void => {
    if (unavailable || !operation) return;
    setPending(true);
    void store
      .perform({
        action: "perform_provider_feature",
        feature: ref,
        actionId,
        arguments: null,
        expectedFeatureRevision: featureState.revision,
      })
      .catch(() => undefined)
      .finally(() => setPending(false));
  };

  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className="codex-fast-mode-toggle"
            data-application-state={state.applicationState}
            aria-label={label}
            aria-pressed={pressed}
            aria-disabled={unavailable}
            aria-busy={pending || undefined}
            onClick={toggle}
          >
            <Zap
              className="codex-fast-mode-icon"
              size={15}
              strokeWidth={1.9}
              fill={pressed ? "currentColor" : "none"}
              aria-hidden="true"
            />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="codex-fast-mode-tooltip"
            side="top"
            align="end"
            sideOffset={6}
          >
            {tooltip}
            <Tooltip.Arrow className="codex-fast-mode-tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

function accessibleLabel(state: FastModeState, pending: boolean): string {
  if (state.desired === null) return "Fast mode, unavailable";
  const selection = state.desired === "fast" ? "on" : "off";
  if (pending || state.applicationState === "pending") {
    return `Fast mode, ${selection}, pending`;
  }
  if (state.applicationState === "unknown") {
    return `Fast mode, ${selection}, application unknown`;
  }
  return `Fast mode, ${selection}`;
}

function decodeFastModeState(
  envelope: ProviderFeatureStateEnvelope | undefined,
): FastModeState | undefined {
  if (
    !envelope ||
    envelope.ref.featureId !== ref.featureId ||
    envelope.ref.schemaVersion !== ref.schemaVersion
  ) {
    return undefined;
  }
  const state = decodeObject(envelope.state);
  if (
    !state ||
    !hasExactKeys(state, ["desired", "effective", "applicationState"])
  ) {
    return undefined;
  }
  const desiredValue = state.desired;
  const effectiveValue = state.effective;
  const applicationStateValue = state.applicationState;
  if (
    desiredValue === undefined ||
    effectiveValue === undefined ||
    applicationStateValue === undefined
  ) {
    return undefined;
  }
  const desired = decodeSelection(desiredValue);
  const effective = decodeSelection(effectiveValue);
  const applicationState = decodeText(applicationStateValue);
  if (
    desired === undefined ||
    effective === undefined ||
    (applicationState !== "applied" &&
      applicationState !== "pending" &&
      applicationState !== "unknown")
  ) {
    return undefined;
  }
  return { desired, effective, applicationState };
}

function decodeSelection(
  value: BoundedValue,
): FastModeSelection | null | undefined {
  if (value === null) return null;
  const text = decodeText(value);
  return text === "standard" || text === "fast" ? text : undefined;
}

function decodeText(value: BoundedValue): string | undefined {
  return typeof value === "object" && value !== null && "text" in value
    ? value.text
    : undefined;
}

function decodeObject(
  value: BoundedValue,
): Readonly<Record<string, BoundedValue>> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "object"
  ) {
    return undefined;
  }
  const entries = value.entries.map(
    ({ key, value: entry }) => [key.text, entry] as const,
  );
  if (new Set(entries.map(([key]) => key)).size !== entries.length) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function hasExactKeys(
  value: Readonly<Record<string, BoundedValue>>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
