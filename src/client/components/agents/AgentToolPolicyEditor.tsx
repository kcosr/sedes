import type {
  AgentToolBootstrapDescriptor,
  AgentToolBootstrapPolicy,
  AgentToolPresentationMode,
  AgentToolPresentationSurface,
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
import { SettingsSection, SettingsSubgroup } from "../settings/SettingsSection.js";
import { ExactToolSelector } from "./ExactToolSelector.js";

export function AgentToolPolicyEditor({
  id,
  catalog,
  value,
  disabled = false,
  onChange,
}: {
  /** The section's id, a target for the editor's section anchors. */
  readonly id?: string;
  readonly catalog: AgentToolBootstrapDescriptor;
  readonly value?: AgentToolBootstrapPolicy;
  readonly disabled?: boolean;
  readonly onChange: (value: AgentToolBootstrapPolicy | undefined) => void;
}): React.JSX.Element {
  const knownToolIds = catalog.groups.flatMap(({ tools }) =>
    tools.map(({ id }) => id),
  );
  const selected = new Set(value?.enabledToolIds ?? []);
  const unavailableIds = [...selected].filter(
    (id) => !knownToolIds.includes(id),
  );
  const groups = catalog.groups.map((group) => ({
    id: group.id,
    label: group.label.text,
    description: group.description.text,
    tools: group.tools.map((tool) => ({
      id: tool.id,
      label: tool.label.text,
      description: tool.description?.text ?? "",
      effects: tool.effects,
      available: tool.available,
      unavailableReason: tool.unavailableReason?.text,
    })),
  }));
  const presentation =
    value?.presentation ?? catalog.resolvedPolicy.presentation;
  const selectedPresentationOption =
    catalog.presentationOptions.find(
      ({ surface }) => surface === presentation.surface,
    ) ?? catalog.presentationOptions[0]!;

  return (
    <SettingsSection
      id={id}
      title="Sedes tools"
      description="Choose whether new threads inherit the ordinary tool policy."
      card
    >
      <SwitchField
        label="Use default tool policy"
        description="Use the selected target’s ordinary new-thread settings."
        checked={value === undefined}
        disabled={disabled}
        onCheckedChange={(checked) => {
          if (checked) {
            onChange(undefined);
            return;
          }
          onChange({
            enabled: catalog.defaultPolicy.enabled,
            enabledToolIds: catalog.defaultPolicy.enabledToolIds,
            presentation: catalog.defaultPolicy.presentation,
            accessBoundary: catalog.defaultPolicy.accessBoundary,
          });
        }}
      />
      {value && (
        <>
          <SwitchField
            label="Enable Sedes tools"
            description="Expose the selected tools on new threads."
            checked={value.enabled}
            disabled={disabled}
            onCheckedChange={(enabled) => onChange({ ...value, enabled })}
          />
          {catalog.presentationOptions.length > 1 && (
            <SettingsField
              label="Surface"
              description="Expose Sedes operations as native tools or CLI commands."
            >
              <Select
                value={presentation.surface}
                disabled={disabled}
                onValueChange={(nextSurface) => {
                  const option = catalog.presentationOptions.find(
                    ({ surface }) => surface === nextSurface,
                  );
                  if (!option) return;
                  onChange({
                    ...value,
                    presentation: {
                      surface: nextSurface as AgentToolPresentationSurface,
                      mode: option.modes.includes(presentation.mode)
                        ? presentation.mode
                        : option.modes[0]!,
                    },
                  });
                }}
              >
                <SelectTrigger className="w-full" aria-label="Sedes tool surface">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {catalog.presentationOptions.map((option) => (
                    <SelectItem key={option.surface} value={option.surface}>
                      {surfaceLabel(option.surface)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsField>
          )}
          {selectedPresentationOption.modes.length > 1 && (
            <SettingsField
              label="Presentation"
              description="Choose progressive discovery or individual operations."
            >
              <Select
                value={presentation.mode}
                disabled={disabled}
                onValueChange={(nextMode) =>
                  onChange({
                    ...value,
                    presentation: {
                      ...presentation,
                      mode: nextMode as AgentToolPresentationMode,
                    },
                  })
                }
              >
                <SelectTrigger className="w-full" aria-label="Sedes tool presentation">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {selectedPresentationOption.modes.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {modeLabel(mode)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsField>
          )}
          <SettingsField
            label="Access boundary"
            description="For each thread created from this Agent, that thread’s execution environment is treated as its current environment. Thread access asks before accessing project, global, or other-thread resources."
          >
            <Select
              value={value.accessBoundary}
              disabled={disabled}
              onValueChange={(next) =>
                onChange({
                  ...value,
                  accessBoundary: next as AgentToolBootstrapPolicy["accessBoundary"],
                })
              }
            >
              <SelectTrigger className="w-full" aria-label="Access boundary">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="thread">Ask outside this thread</SelectItem>
                <SelectItem value="environment">Ask outside this environment</SelectItem>
                <SelectItem value="unrestricted">Allow without asking</SelectItem>
              </SelectContent>
            </Select>
          </SettingsField>
          {value.accessBoundary === "unrestricted" && (
            <Callout tone="warning" role="status">
              Threads created from this Agent may use enabled Sedes tools in
              other environments without asking. Existing threads are not
              changed when this Agent is edited.
            </Callout>
          )}
          <SettingsSubgroup
            title="Tools"
            description="The tools new threads expose when Sedes tools are enabled."
          >
            <ExactToolSelector
              groups={groups}
              selectedToolIds={value.enabledToolIds}
              unavailableToolIds={unavailableIds}
              disabled={disabled}
              onChange={(toolIds) =>
                onChange({
                  enabled: value.enabled,
                  enabledToolIds: [...toolIds],
                  presentation,
                  accessBoundary: value.accessBoundary,
                })
              }
            />
          </SettingsSubgroup>
        </>
      )}
    </SettingsSection>
  );
}

function surfaceLabel(surface: AgentToolPresentationSurface): string {
  return surface === "native" ? "Native tools" : "Sedes CLI";
}

function modeLabel(mode: AgentToolPresentationMode): string {
  return mode === "progressive"
    ? "Progressive discovery (recommended)"
    : "Individual operations";
}
