import { useState } from "react";
import { Rocket, Zap } from "lucide-react";
import { Tooltip } from "radix-ui";
import type {
  BoundedValue,
  ProviderFeatureStateEnvelope,
} from "../../shared/index.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItemDescription,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@client/components/ui/dropdown-menu";
import type { ClientProviderFeatureModule } from "./registry.js";

const ref = Object.freeze({
  featureId: "codex.fast_mode",
  schemaVersion: 2,
} as const);

type SpeedSelection = "standard" | "fast" | "ultrafast";
type AcceleratedSpeed = Exclude<SpeedSelection, "standard">;
type SpeedApplicationState = "applied" | "pending" | "unknown";

type OfferedSpeed = {
  readonly selection: AcceleratedSpeed;
  readonly description?: string;
};

type SpeedState = {
  readonly desired: SpeedSelection | null;
  readonly effective: SpeedSelection | null;
  readonly applicationState: SpeedApplicationState;
  /** Accelerated speeds the desired model offers; Standard is implied. */
  readonly offered: readonly OfferedSpeed[];
};

const SPEED_LABELS: Readonly<Record<SpeedSelection, string>> = {
  standard: "Standard",
  fast: "Fast",
  ultrafast: "Ultrafast",
};

const SPEED_ACTIONS: Readonly<Record<SpeedSelection, string>> = {
  standard: "set_standard",
  fast: "set_fast",
  ultrafast: "set_ultrafast",
};

const ACCELERATED_SPEEDS: readonly AcceleratedSpeed[] = ["fast", "ultrafast"];

export const codexFastModeClientFeature: ClientProviderFeatureModule = {
  ref,
  renderThreadDetails() {
    return null;
  },
  renderComposerAction(input) {
    return <CodexSpeedComposerControl {...input} />;
  },
};

type ComposerActionInput = Parameters<
  NonNullable<ClientProviderFeatureModule["renderComposerAction"]>
>[0];

/**
 * One faster speed: a one-click toggle. Two or more: the same button opens
 * a Speed menu.
 */
function CodexSpeedComposerControl({
  store,
  capability,
  featureState,
  disabled,
  mobile,
}: ComposerActionInput): React.JSX.Element | null {
  const [pending, setPending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const state = decodeSpeedState(featureState);
  if (!state || !featureState) return null;

  const operationFor = (selection: SpeedSelection) =>
    capability.operations.find(
      (candidate) => candidate.actionId === SPEED_ACTIONS[selection],
    );
  const inert =
    disabled ||
    pending ||
    state.desired === null ||
    capability.availability !== "available";
  // Radix reports no close for a menu whose controlled `open` is already
  // false (a choice's pending state lands first, inside its flushSync), so
  // forget the opening here; otherwise the menu reopens when inertness ends.
  if (inert && menuOpen) setMenuOpen(false);
  const choose = (selection: SpeedSelection): void => {
    if (inert || selection === state.desired || !operationFor(selection)) {
      return;
    }
    setPending(true);
    void store
      .perform({
        action: "perform_provider_feature",
        feature: ref,
        actionId: SPEED_ACTIONS[selection],
        arguments: null,
        expectedFeatureRevision: featureState.revision,
      })
      .catch(() => undefined)
      .finally(() => setPending(false));
  };
  const accelerated =
    state.desired !== null && state.desired !== "standard";
  const unavailableReason =
    inert && capability.unavailableReason
      ? capability.unavailableReason.text
      : undefined;

  if (state.offered.length === 1) {
    const offered = state.offered[0]!;
    const target: SpeedSelection = accelerated ? "standard" : offered.selection;
    // The selected speed when on, even one the catalog no longer offers.
    const shown: AcceleratedSpeed =
      state.desired === "fast" || state.desired === "ultrafast"
        ? state.desired
        : offered.selection;
    const unavailable = inert || operationFor(target) === undefined;
    const tooltip =
      unavailableReason ??
      (offered.description
        ? `${SPEED_LABELS[offered.selection]}: ${offered.description}`
        : (capability.description?.text ?? SPEED_LABELS[offered.selection]));
    return (
      <SpeedTooltip text={tooltip}>
        <button
          type="button"
          className="codex-fast-mode-toggle"
          data-application-state={state.applicationState}
          data-accelerated={accelerated}
          aria-label={toggleLabel(state, shown, pending)}
          aria-pressed={accelerated}
          aria-disabled={unavailable}
          aria-busy={pending || undefined}
          onClick={() => {
            if (!unavailable) choose(target);
          }}
        >
          <SpeedIcon selection={shown} emphasized={accelerated} />
        </button>
      </SpeedTooltip>
    );
  }

  const choices: readonly SpeedSelection[] = [
    "standard",
    ...state.offered.map(({ selection }) => selection),
  ];
  const descriptions = new Map<SpeedSelection, string | undefined>(
    state.offered.map(({ selection, description }) => [selection, description]),
  );
  const trigger = (
    <button
      type="button"
      className="codex-fast-mode-toggle"
      data-application-state={state.applicationState}
      data-accelerated={accelerated}
      aria-label={menuLabel(state, pending)}
      aria-disabled={inert}
      aria-busy={pending || undefined}
      onClick={(event) => {
        // Radix opens on pointer down; keep an inert trigger closed.
        if (inert) event.preventDefault();
      }}
      onPointerDown={(event) => {
        if (inert) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (inert && event.key !== "Tab") event.preventDefault();
      }}
    >
      <SpeedIcon
        selection={state.desired ?? "standard"}
        emphasized={accelerated}
      />
    </button>
  );
  return (
    <DropdownMenu
      open={menuOpen && !inert}
      onOpenChange={setMenuOpen}
      presentation={mobile ? "sheet" : "menu"}
    >
      {mobile ? (
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      ) : (
        <SpeedTooltip
          text={unavailableReason ?? capability.description?.text ?? "Speed"}
        >
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        </SpeedTooltip>
      )}
      <DropdownMenuContent
        side="top"
        align="end"
        aria-label="Speed"
        sheetTitle="Speed"
      >
        <DropdownMenuRadioGroup
          aria-label="Speed"
          value={state.desired ?? ""}
          onValueChange={(value) => {
            const selection = choices.find((candidate) => candidate === value);
            if (selection) choose(selection);
          }}
        >
          {choices.map((selection) => {
            const description = descriptions.get(selection);
            return (
              <DropdownMenuRadioItem
                key={selection}
                value={selection}
                disabled={
                  selection !== state.desired &&
                  operationFor(selection) === undefined
                }
              >
                <SpeedIcon
                  selection={selection}
                  emphasized={selection !== "standard"}
                />
                {description ? (
                  <span className="min-w-0 flex-1">
                    {SPEED_LABELS[selection]}{" "}
                    <DropdownMenuItemDescription>
                      {description}
                    </DropdownMenuItemDescription>
                  </span>
                ) : (
                  SPEED_LABELS[selection]
                )}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SpeedTooltip({
  text,
  children,
}: {
  readonly text: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="codex-fast-mode-tooltip"
            side="top"
            align="end"
            sideOffset={6}
          >
            {text}
            <Tooltip.Arrow className="codex-fast-mode-tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

/** Outline Zap for Standard, filled Zap for Fast, Rocket for Ultrafast. */
function SpeedIcon({
  selection,
  emphasized,
}: {
  readonly selection: SpeedSelection;
  readonly emphasized: boolean;
}): React.JSX.Element {
  if (selection === "ultrafast") {
    return (
      <Rocket
        className="codex-fast-mode-icon"
        data-speed-icon="ultrafast"
        size={15}
        strokeWidth={1.9}
        aria-hidden="true"
      />
    );
  }
  return (
    <Zap
      className="codex-fast-mode-icon"
      data-speed-icon={selection}
      size={15}
      strokeWidth={1.9}
      fill={selection === "fast" && emphasized ? "currentColor" : "none"}
      aria-hidden="true"
    />
  );
}

function applicationSuffix(state: SpeedState, pending: boolean): string {
  if (pending || state.applicationState === "pending") return ", pending";
  if (state.applicationState === "unknown") return ", application unknown";
  return "";
}

function toggleLabel(
  state: SpeedState,
  shown: AcceleratedSpeed,
  pending: boolean,
): string {
  if (state.desired === null) return "Speed, unavailable";
  const selection = state.desired === "standard" ? "off" : "on";
  return `${SPEED_LABELS[shown]} speed, ${selection}${applicationSuffix(state, pending)}`;
}

function menuLabel(state: SpeedState, pending: boolean): string {
  if (state.desired === null) return "Speed, unavailable";
  return `Speed, ${SPEED_LABELS[state.desired]}${applicationSuffix(state, pending)}`;
}

function decodeSpeedState(
  envelope: ProviderFeatureStateEnvelope | undefined,
): SpeedState | undefined {
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
    !hasExactKeys(state, ["desired", "effective", "applicationState", "offered"])
  ) {
    return undefined;
  }
  const desiredValue = state.desired;
  const effectiveValue = state.effective;
  const applicationStateValue = state.applicationState;
  const offeredValue = state.offered;
  if (
    desiredValue === undefined ||
    effectiveValue === undefined ||
    applicationStateValue === undefined ||
    offeredValue === undefined
  ) {
    return undefined;
  }
  const desired = decodeSelection(desiredValue);
  const effective = decodeSelection(effectiveValue);
  const applicationState = decodeText(applicationStateValue);
  const offered = decodeOffered(offeredValue);
  if (
    desired === undefined ||
    effective === undefined ||
    offered === undefined ||
    (applicationState !== "applied" &&
      applicationState !== "pending" &&
      applicationState !== "unknown")
  ) {
    return undefined;
  }
  return { desired, effective, applicationState, offered };
}

/** Non-empty, unique, in Sedes order (Fast, then Ultrafast). */
function decodeOffered(
  value: BoundedValue,
): readonly OfferedSpeed[] | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "array" ||
    value.truncation !== undefined ||
    value.values.length === 0
  ) {
    return undefined;
  }
  const offered: OfferedSpeed[] = [];
  for (const item of value.values) {
    const entry = decodeObject(item);
    if (!entry) return undefined;
    const keys = Object.keys(entry);
    if (
      !keys.includes("selection") ||
      keys.some((key) => key !== "selection" && key !== "description")
    ) {
      return undefined;
    }
    const selection = ACCELERATED_SPEEDS.find(
      (candidate) => candidate === decodeText(entry.selection!),
    );
    const description =
      entry.description === undefined
        ? undefined
        : decodeText(entry.description);
    const previous = offered.at(-1);
    if (
      !selection ||
      (entry.description !== undefined && !description) ||
      (previous &&
        ACCELERATED_SPEEDS.indexOf(previous.selection) >=
          ACCELERATED_SPEEDS.indexOf(selection))
    ) {
      return undefined;
    }
    offered.push({ selection, ...(description ? { description } : {}) });
  }
  return offered;
}

function decodeSelection(
  value: BoundedValue,
): SpeedSelection | null | undefined {
  if (value === null) return null;
  const text = decodeText(value);
  return text === "standard" || text === "fast" || text === "ultrafast"
    ? text
    : undefined;
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
