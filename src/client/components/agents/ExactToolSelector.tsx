import { useId } from "react";
import "./agents.css";
import { Checkbox } from "@client/components/ui/checkbox";

export interface ExactToolEffects {
  readonly application: "read" | "write" | "destructive";
  readonly modelUsage: "none" | "agent_execution";
  readonly external: "none" | "durable_side_effect";
}

export interface ExactToolOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly effects?: ExactToolEffects;
  readonly available?: boolean;
  readonly unavailableReason?: string;
}

export interface ExactToolGroup {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly tools: readonly ExactToolOption[];
}

export function ExactToolSelector({
  groups,
  selectedToolIds,
  unavailableToolIds = [],
  disabled = false,
  showEffects = false,
  onChange,
}: {
  readonly groups: readonly ExactToolGroup[];
  readonly selectedToolIds: readonly string[];
  readonly unavailableToolIds?: readonly string[];
  readonly disabled?: boolean;
  readonly showEffects?: boolean;
  readonly onChange: (toolIds: readonly string[]) => void;
}): React.JSX.Element {
  const descriptionPrefix = useId();
  const selected = new Set(selectedToolIds);
  const orderedKnownIds = groups.flatMap(({ tools }) =>
    tools.map(({ id }) => id),
  );

  const replace = (next: ReadonlySet<string>): void => {
    onChange([
      ...orderedKnownIds.filter((id) => next.has(id)),
      ...unavailableToolIds.filter((id) => next.has(id)),
    ]);
  };
  const toggleTool = (toolId: string, checked: boolean): void => {
    const next = new Set(selected);
    if (checked) next.add(toolId);
    else next.delete(toolId);
    replace(next);
  };
  const groupState = (
    group: ExactToolGroup,
  ): boolean | "indeterminate" => {
    const selectable = group.tools.filter(
      ({ available }) => available !== false,
    );
    const count = selectable.filter(({ id }) => selected.has(id)).length;
    if (count === 0) return false;
    if (count === selectable.length) return true;
    return "indeterminate";
  };
  const toggleGroup = (group: ExactToolGroup): void => {
    const next = new Set(selected);
    const remove = groupState(group) === true;
    for (const { id, available } of group.tools) {
      if (available === false) continue;
      if (remove) next.delete(id);
      else next.add(id);
    }
    replace(next);
  };

  return (
    <div className="exact-tool-selector">
      {groups.map((group) => (
        <div
          className="exact-tool-group"
          role="group"
          aria-labelledby={`${descriptionPrefix}-group-${group.id}-title`}
          key={group.id}
        >
          <label className="exact-tool-row" data-kind="group">
            <Checkbox
              aria-label={`Select all ${group.label} tools`}
              aria-describedby={`${descriptionPrefix}-group-${group.id}`}
              checked={groupState(group)}
              disabled={
                disabled ||
                group.tools.every(({ available }) => available === false)
              }
              onCheckedChange={() => toggleGroup(group)}
            />
            <span className="exact-tool-text">
              <strong id={`${descriptionPrefix}-group-${group.id}-title`}>
                {group.label}
              </strong>
              <small id={`${descriptionPrefix}-group-${group.id}`}>
                {group.description}
              </small>
            </span>
          </label>
          <div className="exact-tool-list">
            {group.tools.map((tool) => {
              const descriptionId = `${descriptionPrefix}-${tool.id}-description`;
              const effectId = `${descriptionPrefix}-${tool.id}-effect`;
              return (
                <label
                  key={tool.id}
                  className="exact-tool-row"
                  data-unavailable={tool.available === false || undefined}
                >
                  <Checkbox
                    aria-label={tool.label}
                    aria-describedby={`${descriptionId}${showEffects && tool.effects ? ` ${effectId}` : ""}`}
                    checked={selected.has(tool.id)}
                    disabled={disabled || tool.available === false}
                    onCheckedChange={(checked) =>
                      toggleTool(tool.id, checked === true)
                    }
                  />
                  <span className="exact-tool-text">
                    <strong>{tool.label}</strong>
                    <small id={descriptionId}>{tool.description}</small>
                    {tool.available === false ? (
                      <small className="exact-tool-unavailable">
                        {tool.unavailableReason ?? "Currently unavailable."}
                      </small>
                    ) : null}
                    {showEffects && tool.effects ? (
                      <small
                        id={effectId}
                        className="exact-tool-effect"
                        data-risk={toolRisk(tool.effects) || undefined}
                      >
                        {effectSummary(tool.effects)}
                      </small>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
      {unavailableToolIds.length > 0 ? (
        <div
          className="exact-tool-group"
          data-kind="unavailable"
          role="group"
          aria-labelledby={`${descriptionPrefix}-unavailable-title`}
        >
          <div className="exact-tool-row" data-kind="group">
            <span className="exact-tool-text">
              <strong id={`${descriptionPrefix}-unavailable-title`}>
                Unavailable selections
              </strong>
              <small>Remove tools that are no longer offered.</small>
            </span>
          </div>
          <div className="exact-tool-list">
            {unavailableToolIds.map((toolId) => (
              <label key={toolId} className="exact-tool-row">
                <Checkbox
                  aria-label={`Remove unavailable tool ${toolId}`}
                  checked={selected.has(toolId)}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    toggleTool(toolId, checked === true)
                  }
                />
                <span className="exact-tool-text">
                  <strong>{toolId}</strong>
                  <small>This tool is unavailable in the current catalog.</small>
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Effects that deserve a second look before granting the tool. */
function toolRisk(effects: ExactToolEffects): boolean {
  return (
    effects.modelUsage === "agent_execution" ||
    effects.external === "durable_side_effect" ||
    effects.application === "destructive"
  );
}

function effectSummary(effects: ExactToolEffects): string {
  if (effects.modelUsage === "agent_execution") return "Starts model execution";
  if (effects.external === "durable_side_effect") {
    return "Has a durable external side effect";
  }
  if (effects.application === "destructive") return "Destructive change";
  if (effects.application === "write") return "Changes Sedes data";
  return "Reads Sedes data";
}
