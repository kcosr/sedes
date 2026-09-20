import type {
  AgentToolBootstrapDescriptor,
  AgentToolBootstrapPolicy,
  AgentToolPresentationMode,
  AgentToolPresentationSurface,
} from "../../../shared/index.js";
import { useId } from "react";
import { Checkbox } from "@client/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";
import { ExactToolSelector } from "./ExactToolSelector.js";

export function AgentToolPolicyEditor({
  catalog,
  value,
  disabled = false,
  onChange,
}: {
  readonly catalog: AgentToolBootstrapDescriptor;
  readonly value?: AgentToolBootstrapPolicy;
  readonly disabled?: boolean;
  readonly onChange: (value: AgentToolBootstrapPolicy | undefined) => void;
}): React.JSX.Element {
  const descriptionId = useId();
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
    <section
      className="agent-editor-section"
      aria-labelledby="agent-tools-title"
    >
      <header>
        <h2 id="agent-tools-title">Sedes tools</h2>
        <p>Choose whether new threads inherit the ordinary tool policy.</p>
      </header>
      <label className="agent-editor-toggle">
        <span>
          <strong>Use default tool policy</strong>
          <small id={`${descriptionId}-default-policy`}>
            Use the selected target’s ordinary new-thread settings.
          </small>
        </span>
        <Checkbox
          aria-label="Use default tool policy"
          aria-describedby={`${descriptionId}-default-policy`}
          checked={value === undefined}
          disabled={disabled}
          onCheckedChange={(checked) => {
            if (checked === true) {
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
      </label>
      {value && (
        <div className="agent-tool-policy-editor">
          <div className="agent-tool-policy-global">
            <label className="agent-editor-toggle">
              <span>
                <strong>Enable Sedes tools</strong>
                <small id={`${descriptionId}-enabled`}>
                  Expose the selected tools on new threads.
                </small>
              </span>
              <Checkbox
                aria-label="Enable Sedes tools"
                aria-describedby={`${descriptionId}-enabled`}
                checked={value.enabled}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onChange({
                    ...value,
                    enabled: checked === true,
                  })
                }
              />
            </label>
            {catalog.presentationOptions.length > 1 && (
              <label className="agent-editor-field">
                <span>Surface</span>
                <small id="agent-tool-surface-description">
                  Expose Sedes operations as native tools or CLI commands.
                </small>
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
                        surface:
                          nextSurface as AgentToolPresentationSurface,
                        mode: option.modes.includes(presentation.mode)
                          ? presentation.mode
                          : option.modes[0]!,
                      },
                    });
                  }}
                >
                  <SelectTrigger
                    aria-label="Sedes tool surface"
                    aria-describedby="agent-tool-surface-description"
                  >
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
              </label>
            )}
            {selectedPresentationOption.modes.length > 1 && (
              <label className="agent-editor-field">
                <span>Presentation</span>
                <small id="agent-tool-presentation-description">
                  Choose progressive discovery or individual operations.
                </small>
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
                  <SelectTrigger
                    aria-label="Sedes tool presentation"
                    aria-describedby="agent-tool-presentation-description"
                  >
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
              </label>
            )}
            <label className="agent-editor-field">
              <span>Access boundary</span>
              <small id={`${descriptionId}-environment-access`}>
                For each thread created from this Agent, that thread’s execution
                environment is treated as its current environment.
              </small>
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
                <SelectTrigger
                  aria-label="Access boundary"
                  aria-describedby={`${descriptionId}-environment-access`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="thread">Ask outside this thread</SelectItem>
                  <SelectItem value="environment">Ask outside this environment</SelectItem>
                  <SelectItem value="unrestricted">Allow without asking</SelectItem>
                </SelectContent>
              </Select>
              <small>
                Thread access asks before accessing project, global, or other-thread resources.
              </small>
              {value.accessBoundary === "unrestricted" && (
                <small role="status">
                  Threads created from this Agent may use enabled Sedes tools
                  in other environments without asking. Existing threads are not
                  changed when this Agent is edited.
                </small>
              )}
            </label>
          </div>
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
        </div>
      )}
    </section>
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
