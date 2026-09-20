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
  featureId: "codex.execution",
  schemaVersion: 1,
} as const);

const sandboxModes = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;
const networkAccessValues = ["disabled", "enabled"] as const;
const approvalPolicies = ["untrusted", "on-request", "never"] as const;
const approvalReviewers = ["user", "auto_review"] as const;

type SandboxMode = (typeof sandboxModes)[number];
type NetworkAccess = (typeof networkAccessValues)[number];
type ApprovalPolicy = (typeof approvalPolicies)[number];
type ApprovalReviewer = (typeof approvalReviewers)[number];

type DesiredExecutionTuple = {
  readonly sandboxMode: SandboxMode;
  readonly networkAccess: NetworkAccess;
  readonly approvalPolicy: ApprovalPolicy;
  readonly approvalReviewer: ApprovalReviewer;
};

type EffectiveExecutionTuple = {
  readonly sandboxMode: SandboxMode | null;
  readonly networkAccess: NetworkAccess | null;
  readonly approvalPolicy: ApprovalPolicy | null;
  readonly approvalReviewer: ApprovalReviewer | null;
};

type ExecutionState = {
  readonly desired: DesiredExecutionTuple | null;
  readonly effective: EffectiveExecutionTuple | null;
};

const sandboxLabels: Readonly<Record<SandboxMode, string>> = Object.freeze({
  "read-only": "Read only",
  "workspace-write": "Workspace",
  "danger-full-access": "Unrestricted",
});

const networkLabels: Readonly<Record<NetworkAccess, string>> = Object.freeze({
  disabled: "Disabled",
  enabled: "Enabled",
});

const approvalLabels: Readonly<Record<ApprovalPolicy, string>> = Object.freeze({
  untrusted: "Untrusted",
  "on-request": "On request",
  never: "Never",
});

const reviewerLabels: Readonly<Record<ApprovalReviewer, string>> =
  Object.freeze({
    user: "User",
    auto_review: "Auto-review",
  });

const sandboxActions: Readonly<Record<SandboxMode, string>> = Object.freeze({
  "read-only": "set_sandbox_read_only",
  "workspace-write": "set_sandbox_workspace",
  "danger-full-access": "set_sandbox_unrestricted",
});

const networkActions: Readonly<Record<NetworkAccess, string>> = Object.freeze({
  disabled: "set_network_disabled",
  enabled: "set_network_enabled",
});

const approvalActions: Readonly<Record<ApprovalPolicy, string>> = Object.freeze(
  {
    untrusted: "set_approval_untrusted",
    "on-request": "set_approval_on_request",
    never: "set_approval_never",
  },
);

const reviewerActions: Readonly<Record<ApprovalReviewer, string>> =
  Object.freeze({
    user: "set_reviewer_user",
    auto_review: "set_reviewer_auto_review",
  });

export const codexExecutionClientFeature: ClientProviderFeatureModule = {
  ref,
  renderThreadDetails(input) {
    return <CodexExecutionControls {...input} />;
  },
};

function CodexExecutionControls({
  store,
  capability,
  featureState,
  disabled,
}: Parameters<
  ClientProviderFeatureModule["renderThreadDetails"]
>[0]): React.JSX.Element {
  const state = decodeExecutionState(featureState);
  const operation = (actionId: string) =>
    capability.operations.find(
      (candidate) =>
        candidate.actionId === actionId &&
        capability.availability === "available",
    );
  const apply = async (actionId: string): Promise<void> => {
    if (!operation(actionId) || !featureState) return;
    await store.perform({
      action: "perform_provider_feature",
      feature: ref,
      actionId,
      arguments: null,
      expectedFeatureRevision: featureState.revision,
    });
  };

  if (!state || !featureState) {
    return <></>;
  }

  const desired = state.desired;
  const forceNetworkEnabled = desired?.sandboxMode === "danger-full-access";
  const networkValue = forceNetworkEnabled
    ? "enabled"
    : (desired?.networkAccess ?? "");
  const reviewerNotApplicable = desired?.approvalPolicy === "never";
  const unavailable = disabled || capability.availability !== "available";
  return (
    <div className="codex-execution" aria-label="Codex execution settings">
      <p className="codex-execution-label">Codex execution</p>
      <ExecutionSelect
        label="Sandbox"
        value={desired?.sandboxMode ?? ""}
        values={sandboxModes}
        labels={sandboxLabels}
        disabled={unavailable}
        operationAvailable={(value) =>
          Boolean(operation(sandboxActions[value]))
        }
        onChange={(value) => apply(sandboxActions[value])}
      />
      <ExecutionSelect
        label="Network"
        value={networkValue}
        values={networkAccessValues}
        labels={networkLabels}
        disabled={unavailable || forceNetworkEnabled}
        operationAvailable={(value) =>
          Boolean(operation(networkActions[value]))
        }
        onChange={(value) => apply(networkActions[value])}
      />
      <ExecutionSelect
        label="Approval policy"
        value={desired?.approvalPolicy ?? ""}
        values={approvalPolicies}
        labels={approvalLabels}
        disabled={unavailable}
        operationAvailable={(value) =>
          Boolean(operation(approvalActions[value]))
        }
        onChange={(value) => apply(approvalActions[value])}
      />
      <ExecutionSelect
        label="Approval reviewer"
        value={desired?.approvalReviewer ?? ""}
        values={approvalReviewers}
        labels={reviewerLabels}
        disabled={unavailable || reviewerNotApplicable}
        operationAvailable={(value) =>
          Boolean(operation(reviewerActions[value]))
        }
        onChange={(value) => apply(reviewerActions[value])}
      />
    </div>
  );
}

function ExecutionSelect<Value extends string>({
  label,
  value,
  values,
  labels,
  disabled,
  operationAvailable,
  onChange,
}: {
  readonly label: string;
  readonly value: Value | "";
  readonly values: readonly Value[];
  readonly labels: Readonly<Record<Value, string>>;
  readonly disabled: boolean;
  readonly operationAvailable: (value: Value) => boolean;
  readonly onChange: (value: Value) => Promise<void>;
}): React.JSX.Element {
  return (
    <div className="codex-execution-select">
      <span className="codex-execution-row-label">{label}</span>
      <Select
        value={value}
        onValueChange={(next) => {
          const candidate = values.find((entry) => entry === next);
          if (candidate) void onChange(candidate).catch(() => undefined);
        }}
      >
        <SelectTrigger
          aria-label={label}
          className="w-full min-w-0"
          size="sm"
          disabled={disabled}
        >
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {values.map((candidate) => (
            <SelectItem
              key={candidate}
              value={candidate}
              disabled={!operationAvailable(candidate)}
            >
              {labels[candidate]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function decodeExecutionState(
  envelope: ProviderFeatureStateEnvelope | undefined,
): ExecutionState | undefined {
  if (
    !envelope ||
    envelope.ref.featureId !== ref.featureId ||
    envelope.ref.schemaVersion !== ref.schemaVersion
  ) {
    return undefined;
  }
  const state = decodeObject(envelope.state);
  if (!state || !hasExactKeys(state, ["desired", "effective"]))
    return undefined;
  const desired = decodeDesiredTuple(state.desired);
  const effective = decodeEffectiveTuple(state.effective);
  if (desired === undefined || effective === undefined) return undefined;
  return { desired, effective };
}

function decodeDesiredTuple(
  value: BoundedValue | undefined,
): DesiredExecutionTuple | null | undefined {
  const tuple = decodeTupleObject(value);
  if (tuple === null || tuple === undefined) return tuple;
  const sandboxMode = decodeEnum(tuple.sandboxMode, sandboxModes, false);
  const networkAccess = decodeEnum(
    tuple.networkAccess,
    networkAccessValues,
    false,
  );
  const approvalPolicy = decodeEnum(
    tuple.approvalPolicy,
    approvalPolicies,
    false,
  );
  const approvalReviewer = decodeEnum(
    tuple.approvalReviewer,
    approvalReviewers,
    false,
  );
  if (!sandboxMode || !networkAccess || !approvalPolicy || !approvalReviewer) {
    return undefined;
  }
  return { sandboxMode, networkAccess, approvalPolicy, approvalReviewer };
}

function decodeEffectiveTuple(
  value: BoundedValue | undefined,
): EffectiveExecutionTuple | null | undefined {
  const tuple = decodeTupleObject(value);
  if (tuple === null || tuple === undefined) return tuple;
  const sandboxMode = decodeEnum(tuple.sandboxMode, sandboxModes, true);
  const networkAccess = decodeEnum(
    tuple.networkAccess,
    networkAccessValues,
    true,
  );
  const approvalPolicy = decodeEnum(
    tuple.approvalPolicy,
    approvalPolicies,
    true,
  );
  const approvalReviewer = decodeEnum(
    tuple.approvalReviewer,
    approvalReviewers,
    true,
  );
  if (
    sandboxMode === undefined ||
    networkAccess === undefined ||
    approvalPolicy === undefined ||
    approvalReviewer === undefined
  ) {
    return undefined;
  }
  return { sandboxMode, networkAccess, approvalPolicy, approvalReviewer };
}

function decodeTupleObject(
  value: BoundedValue | undefined,
): Record<string, BoundedValue> | null | undefined {
  if (value === null) return null;
  const tuple = decodeObject(value);
  if (
    !tuple ||
    !hasExactKeys(tuple, [
      "sandboxMode",
      "networkAccess",
      "approvalPolicy",
      "approvalReviewer",
    ])
  ) {
    return undefined;
  }
  return tuple;
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
