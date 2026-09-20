import type {
  BoundedValue,
  ProviderFeatureStateEnvelope,
} from "../../shared/index.js";
import type { ClientProviderFeatureModule } from "./registry.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";

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

  return (
    <div className="claude-permissions" aria-label="Claude permission settings">
      <p className="claude-permissions-label">Claude permissions</p>
      <div className="claude-permissions-select">
        <span className="claude-permissions-row-label">Permission mode</span>
        <Select
          value={state.desired ?? ""}
          onValueChange={(next) => {
            const mode = permissionModes.find(
              (candidate) => candidate === next,
            );
            if (mode) void apply(mode).catch(() => undefined);
          }}
        >
          <SelectTrigger
            aria-label="Permission mode"
            className="w-full min-w-0"
            size="sm"
            disabled={unavailable}
          >
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {permissionModes.map((mode) => {
              const available = Boolean(operation(mode));
              return (
                <SelectItem key={mode} value={mode} disabled={!available}>
                  {labels[mode]}
                  {!available && state.desired === mode ? " (unavailable)" : ""}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
    </div>
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
