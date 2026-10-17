import type {
  AgentToolBootstrapDescriptor,
  AgentToolPresentation,
  ToolPolicySelection,
  ToolPolicySet,
} from "../../../shared/index.js";
import { Callout } from "@client/components/ui/callout";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";
import { SettingsField, SwitchField } from "../settings/SettingsField.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import { missingToolPolicyMessage, toolPolicySourceLabel } from "../tool-policies/tool-policy-messages.js";
import { ToolPolicySelector } from "../tool-policies/ToolPolicySelector.js";

export function AgentToolPolicyEditor({
  id,
  catalog,
  value,
  policySets,
  toolPresentation,
  disabled = false,
  updating = false,
  catalogState = "ready",
  onChange,
  onPresentationChange,
}: {
  readonly id?: string;
  readonly catalog?: AgentToolBootstrapDescriptor;
  readonly value: ToolPolicySelection;
  readonly policySets: readonly ToolPolicySet[];
  readonly toolPresentation?: AgentToolPresentation;
  readonly disabled?: boolean;
  readonly updating?: boolean;
  readonly catalogState?: "loading" | "ready" | "error";
  readonly onChange: (value: ToolPolicySelection) => void;
  readonly onPresentationChange: (value: AgentToolPresentation | undefined) => void;
}): React.JSX.Element {
  const presentation = toolPresentation ?? catalog?.defaultPresentation;
  const selectedOption = catalog?.presentationOptions.find(
    ({ surface }) => surface === presentation?.surface,
  );
  return (
    <SettingsSection
      id={id}
      title="Sedes tools"
      description="Choose a reusable policy for new threads. Inherited policies resolve through account, environment, and backend defaults."
      card
    >
      {updating && <p className="agent-configuration-resolved" role="status">Updating available settings…</p>}
      <ToolPolicySelector
        value={value}
        policySets={policySets}
        disabled={disabled}
        catalogState={catalogState}
        inheritedLabel={catalog?.defaultPolicy ? toolPolicySourceLabel(catalog.defaultPolicy.source) : "backend, environment, or account defaults"}
        inheritedPolicy={catalog?.defaultPolicy ?? undefined}
        hidePreview={Boolean(catalog?.defaultIssue && value.kind === "inherit")}
        suppressMissingMessage={Boolean(catalog?.resolvedIssue)}
        onChange={onChange}
      />
      {catalog?.resolvedIssue && (
        <Callout tone="warning">{missingToolPolicyMessage(catalog.resolvedIssue, "agent")}</Callout>
      )}
      {catalog && presentation && (
        <>
          <SwitchField
            label="Use backend presentation"
            description="Let each compatible backend choose how to expose the selected tools."
            checked={toolPresentation === undefined}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onPresentationChange(checked ? undefined : presentation)
            }
          />
          {toolPresentation && (
            <>
              {catalog.presentationOptions.length > 1 && (
                <SettingsField
                  label="Surface"
                  description="Expose Sedes operations as native tools or CLI commands."
                >
                  <Select
                    value={presentation.surface}
                    disabled={disabled}
                    onValueChange={(surface) => {
                      const option = catalog.presentationOptions.find(
                        (item) => item.surface === surface,
                      );
                      if (!option) return;
                      onPresentationChange({
                        surface: option.surface,
                        mode: option.modes.includes(presentation.mode)
                          ? presentation.mode
                          : option.modes[0]!,
                      });
                    }}
                  >
                    <SelectTrigger className="w-full" aria-label="Sedes tool surface">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {catalog.presentationOptions.map(({ surface }) => (
                        <SelectItem key={surface} value={surface}>
                          {surface === "native" ? "Native tools" : "Sedes CLI"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsField>
              )}
              {selectedOption && selectedOption.modes.length > 1 && (
                <SettingsField
                  label="Presentation"
                  description="Choose progressive discovery or individual operations."
                >
                  <Select
                    value={presentation.mode}
                    disabled={disabled}
                    onValueChange={(mode) => {
                      if (mode === "progressive" || mode === "individual") {
                        onPresentationChange({ ...presentation, mode });
                      }
                    }}
                  >
                    <SelectTrigger className="w-full" aria-label="Sedes tool presentation">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {selectedOption.modes.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {mode === "progressive"
                            ? "Progressive discovery (recommended)"
                            : "Individual operations"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsField>
              )}
            </>
          )}
        </>
      )}
      <p className="agent-configuration-resolved">
        Policy changes affect future threads. Existing threads keep their saved settings.
      </p>
    </SettingsSection>
  );
}
