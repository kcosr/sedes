import type {
  BoundedValue,
  ProviderFeatureStateEnvelope,
} from "../../shared/index.js";
import type { ClientProviderFeatureModule } from "./registry.js";
import {
  Bot,
  FastForward,
  FolderLock,
  Hand,
  Lock,
  LockOpen,
  Shield,
  ShieldAlert,
  User,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@client/components/ui/dropdown-menu";
import { menuDescriptionClass } from "@client/components/ui/floating";
import { cn } from "@client/lib/utils";

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

const sandboxIcons: Readonly<Record<SandboxMode, LucideIcon>> = Object.freeze({
  "read-only": Lock,
  "workspace-write": FolderLock,
  "danger-full-access": LockOpen,
});

const networkIcons: Readonly<Record<NetworkAccess, LucideIcon>> = Object.freeze({
  disabled: WifiOff,
  enabled: Wifi,
});

const approvalIcons: Readonly<Record<ApprovalPolicy, LucideIcon>> = Object.freeze({
  untrusted: ShieldAlert,
  "on-request": Hand,
  never: FastForward,
});

const reviewerIcons: Readonly<Record<ApprovalReviewer, LucideIcon>> =
  Object.freeze({
    user: User,
    auto_review: Bot,
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
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={unavailable}>
        <Shield aria-hidden="true" />
        Codex execution
        {unavailable && (
          <DropdownMenuShortcut aria-hidden="true">Unavailable</DropdownMenuShortcut>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <ExecutionChoices
          label="Sandbox"
          value={desired?.sandboxMode ?? ""}
          values={sandboxModes}
          labels={sandboxLabels}
          icons={sandboxIcons}
          operationAvailable={(value) =>
            Boolean(operation(sandboxActions[value]))
          }
          onChange={(value) => apply(sandboxActions[value])}
        />
        <DropdownMenuSeparator />
        <ExecutionChoices
          label="Network"
          note={
            forceNetworkEnabled
              ? "Always enabled with an unrestricted sandbox"
              : undefined
          }
          value={networkValue}
          values={networkAccessValues}
          labels={networkLabels}
          icons={networkIcons}
          disabled={forceNetworkEnabled}
          operationAvailable={(value) =>
            Boolean(operation(networkActions[value]))
          }
          onChange={(value) => apply(networkActions[value])}
        />
        <DropdownMenuSeparator />
        <ExecutionChoices
          label="Approval policy"
          value={desired?.approvalPolicy ?? ""}
          values={approvalPolicies}
          labels={approvalLabels}
          icons={approvalIcons}
          operationAvailable={(value) =>
            Boolean(operation(approvalActions[value]))
          }
          onChange={(value) => apply(approvalActions[value])}
        />
        <DropdownMenuSeparator />
        <ExecutionChoices
          label="Approval reviewer"
          note={
            reviewerNotApplicable
              ? "Not used when approval is never requested"
              : undefined
          }
          value={desired?.approvalReviewer ?? ""}
          values={approvalReviewers}
          labels={reviewerLabels}
          icons={reviewerIcons}
          disabled={reviewerNotApplicable}
          operationAvailable={(value) =>
            Boolean(operation(reviewerActions[value]))
          }
          onChange={(value) => apply(reviewerActions[value])}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * One execution setting as a labelled group of radio rows. A row whose
 * operation the capability does not offer is disabled; a group that does
 * not apply right now is disabled with its reason under the label.
 */
function ExecutionChoices<Value extends string>({
  label,
  note,
  value,
  values,
  labels,
  icons,
  disabled = false,
  operationAvailable,
  onChange,
}: {
  readonly label: string;
  readonly note?: string;
  readonly value: Value | "";
  readonly values: readonly Value[];
  readonly labels: Readonly<Record<Value, string>>;
  readonly icons: Readonly<Record<Value, LucideIcon>>;
  readonly disabled?: boolean;
  readonly operationAvailable: (value: Value) => boolean;
  readonly onChange: (value: Value) => Promise<void>;
}): React.JSX.Element {
  return (
    <DropdownMenuRadioGroup
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        const candidate = values.find((entry) => entry === next);
        if (candidate && candidate !== value) {
          void onChange(candidate).catch(() => undefined);
        }
      }}
    >
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      {note && (
        <p className={cn(menuDescriptionClass, "m-0 px-2 pb-1")}>{note}</p>
      )}
      {values.map((candidate) => {
        const Icon: LucideIcon = icons[candidate];
        return (
          <DropdownMenuRadioItem
            key={candidate}
            value={candidate}
            disabled={disabled || !operationAvailable(candidate)}
          >
            <Icon aria-hidden="true" />
            {labels[candidate]}
          </DropdownMenuRadioItem>
        );
      })}
    </DropdownMenuRadioGroup>
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
