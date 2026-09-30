import type {
  BoundedValue,
  ProviderFeatureStateEnvelope,
} from "../../shared/index.js";
import type { ClientProviderFeatureModule } from "./registry.js";
import { ShieldCheck } from "lucide-react";
import { menuDescriptionClass } from "@client/components/ui/floating";
import { cn } from "@client/lib/utils";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuValue,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@client/components/ui/dropdown-menu";

const ref = Object.freeze({
  featureId: "claude.permissions",
  schemaVersion: 1,
} as const);

const permissionModes = [
  "default",
  "acceptEdits",
  "dontAsk",
  "auto",
  "bypassPermissions",
] as const;
type PermissionMode = (typeof permissionModes)[number];
type EffectiveState = "unconfirmed" | "confirmed" | "unknown";

type PermissionsState = {
  readonly desired: PermissionMode | null;
  readonly effective: PermissionMode | null;
  readonly effectiveState: EffectiveState;
};

const labels: Readonly<Record<PermissionMode, string>> = Object.freeze({
  default: "Default",
  acceptEdits: "Accept edits",
  dontAsk: "Don't ask",
  auto: "Auto",
  bypassPermissions: "Bypass permissions",
});

const actions: Readonly<Record<PermissionMode, string>> = Object.freeze({
  default: "set_permission_default",
  acceptEdits: "set_permission_accept_edits",
  dontAsk: "set_permission_dont_ask",
  auto: "set_permission_auto",
  bypassPermissions: "set_permission_bypass",
});

export const claudePermissionsClientFeature: ClientProviderFeatureModule = {
  ref,
  renderThreadDetails(input) {
    return <ClaudePermissionControls {...input} />;
  },
};

function ClaudePermissionControls({
  store,
  capability,
  featureState,
  disabled,
}: Parameters<
  ClientProviderFeatureModule["renderThreadDetails"]
>[0]): React.JSX.Element {
  const state = decodePermissionsState(featureState);
  if (!state || !featureState) return <></>;

  const operation = (mode: PermissionMode) =>
    capability.availability === "available"
      ? capability.operations.find(
          (candidate) => candidate.actionId === actions[mode],
        )
      : undefined;
  const unavailable = disabled || capability.availability !== "available";
  const apply = async (mode: PermissionMode): Promise<void> => {
    if (!operation(mode)) return;
    await store.perform({
      action: "perform_provider_feature",
      feature: ref,
      actionId: actions[mode],
      arguments: null,
      expectedFeatureRevision: featureState.revision,
    });
  };

  const valueId = `claude-permission-mode-${featureState.revision}`;
  return (
    <DropdownMenuSub>
      {/* Openable even when the mode cannot change, so it stays visible. */}
      <DropdownMenuSubTrigger aria-describedby={valueId}>
        <ShieldCheck aria-hidden="true" />
        Permission mode
        <DropdownMenuValue id={valueId} aria-hidden="true">
          {state.desired ? labels[state.desired] : "Choose…"}
        </DropdownMenuValue>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {unavailable && (
          <p role="status" className={cn(menuDescriptionClass, "m-0 px-2 py-1.5")}>
            {capability.availability !== "available"
              ? (capability.unavailableReason?.text ?? "Can't be changed right now")
              : "Can't be changed right now"}
          </p>
        )}
        <DropdownMenuRadioGroup
          aria-label="Permission mode"
          value={state.desired ?? ""}
          onValueChange={(next) => {
            const mode = permissionModes.find(
              (candidate) => candidate === next,
            );
            if (mode && mode !== state.desired) {
              void apply(mode).catch(() => undefined);
            }
          }}
        >
          {permissionModes.map((mode) => {
            const available = Boolean(operation(mode));
            return (
              <DropdownMenuRadioItem
                key={mode}
                value={mode}
                disabled={unavailable || !available}
              >
                {labels[mode]}
                {!unavailable && !available && state.desired === mode && (
                  <DropdownMenuValue aria-hidden="true">
                    Not allowed
                  </DropdownMenuValue>
                )}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function decodePermissionsState(
  envelope: ProviderFeatureStateEnvelope | undefined,
): PermissionsState | undefined {
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
    !hasExactKeys(state, ["desired", "effective", "effectiveState"])
  ) {
    return undefined;
  }
  const desired = decodeEnum(state.desired, permissionModes, true);
  const effective = decodeEnum(state.effective, permissionModes, true);
  const effectiveState = decodeEnum(
    state.effectiveState,
    ["unconfirmed", "confirmed", "unknown"] as const,
    false,
  );
  if (
    desired === undefined ||
    effective === undefined ||
    effectiveState === undefined ||
    effectiveState === null
  ) {
    return undefined;
  }
  return { desired, effective, effectiveState };
}

function decodeObject(
  value: BoundedValue | undefined,
): Record<string, BoundedValue> | undefined {
  if (
    value === null ||
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

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function decodeEnum<Value extends string>(
  value: BoundedValue | undefined,
  allowed: readonly Value[],
  nullable: boolean,
): Value | null | undefined {
  if (value === null) return nullable ? null : undefined;
  if (
    typeof value !== "object" ||
    !("text" in value) ||
    !allowed.some((candidate) => candidate === value.text)
  ) {
    return undefined;
  }
  return value.text as Value;
}
