import { useId } from "react";
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
    <div className="agent-tool-policy-editor">
      {groups.map((group) => (
        <fieldset className="agent-tool-policy-group" key={group.id}>
          <legend>
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
            <span>
              <strong>{group.label}</strong>
              <small id={`${descriptionPrefix}-group-${group.id}`}>
                {group.description}
              </small>
            </span>
          </legend>
          {group.tools.map((tool) => {
            const descriptionId = `${descriptionPrefix}-${tool.id}-description`;
            const effectId = `${descriptionPrefix}-${tool.id}-effect`;
            return (
              <label key={tool.id} className="agent-tool-policy-tool">
                <Checkbox
                  aria-label={tool.label}
                  aria-describedby={`${descriptionId}${showEffects && tool.effects ? ` ${effectId}` : ""}`}
                  checked={selected.has(tool.id)}
                  disabled={disabled || tool.available === false}
                  onCheckedChange={(checked) =>
                    toggleTool(tool.id, checked === true)
                  }
                />
                <span>
                  <strong>{tool.label}</strong>
                  <small id={descriptionId}>{tool.description}</small>
                  {tool.available === false ? (
                    <small className="agent-tool-unavailable-reason">
                      {tool.unavailableReason ?? "Currently unavailable."}
                    </small>
                  ) : null}
                  {showEffects && tool.effects ? (
                    <small id={effectId} className="agent-tool-effect">
                      {effectSummary(tool.effects)}
                    </small>
                  ) : null}
                </span>
              </label>
            );
          })}
        </fieldset>
      ))}
      {unavailableToolIds.length > 0 ? (
        <fieldset className="agent-tool-policy-group agent-tool-policy-unavailable">
          <legend>
            <span>
              <strong>Unavailable selections</strong>
              <small>Remove tools that are no longer offered.</small>
            </span>
          </legend>
          {unavailableToolIds.map((toolId) => (
            <label key={toolId} className="agent-tool-policy-tool">
              <Checkbox
                aria-label={`Remove unavailable tool ${toolId}`}
                checked={selected.has(toolId)}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  toggleTool(toolId, checked === true)
                }
              />
              <span>
                <strong>{toolId}</strong>
                <small>This tool is unavailable in the current catalog.</small>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
    </div>
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
