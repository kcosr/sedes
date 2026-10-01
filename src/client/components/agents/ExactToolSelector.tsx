import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import "./agents.css";
import { Checkbox } from "@client/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@client/components/ui/collapsible";

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

/**
 * Exact tool grants, one collapsed item per tool group. Each group's header
 * keeps its select-all checkbox beside the trigger and summarizes the
 * selection ("1 of 9 tools"), so the whole catalog fits on a screen; open
 * groups lay their tools out in two columns when there is room.
 */
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
  /** Show each tool's effect, and flag groups whose selection includes a risky one. */
  readonly showEffects?: boolean;
  readonly onChange: (toolIds: readonly string[]) => void;
}): React.JSX.Element {
  const idPrefix = useId();
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
  const toggleGroup = (group: ExactToolGroup): void => {
    const next = new Set(selected);
    const remove = groupSelection(group, selected).state === true;
    for (const { id, available } of group.tools) {
      if (available === false) continue;
      if (remove) next.delete(id);
      else next.add(id);
    }
    replace(next);
  };

  return (
    <div className="exact-tool-selector">
      {groups.map((group) => {
        const selection = groupSelection(group, selected);
        const risky =
          showEffects &&
          group.tools.some(
            ({ id, effects }) => selected.has(id) && effects && toolRisk(effects),
          );
        const groupId = `${idPrefix}-group-${group.id}`;
        return (
          <ToolGroupItem
            key={group.id}
            idPrefix={groupId}
            title={group.label}
            description={group.description}
            defaultOpen={selection.unavailable > 0}
            summary={
              <>
                <SummaryPart>{selection.label}</SummaryPart>
                {selection.unavailable > 0 ? (
                  <SummaryPart attention>
                    {selection.unavailable} unavailable
                  </SummaryPart>
                ) : null}
                {risky ? <SummaryPart attention>High risk</SummaryPart> : null}
              </>
            }
            select={
              <Checkbox
                aria-label={`Select all ${group.label} tools`}
                aria-describedby={`${groupId}-description`}
                checked={selection.state}
                disabled={disabled || selection.selectable === 0}
                onCheckedChange={() => toggleGroup(group)}
              />
            }
          >
            {group.tools.map((tool) => {
              const descriptionId = `${idPrefix}-${tool.id}-description`;
              const effectId = `${idPrefix}-${tool.id}-effect`;
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
          </ToolGroupItem>
        );
      })}
      {unavailableToolIds.length > 0 ? (
        <ToolGroupItem
          idPrefix={`${idPrefix}-unavailable`}
          kind="unavailable"
          title="Unavailable selections"
          description="Remove tools that are no longer offered."
          defaultOpen
          summary={
            <SummaryPart>
              {unavailableToolIds.length}{" "}
              {unavailableToolIds.length === 1 ? "tool" : "tools"}
            </SummaryPart>
          }
        >
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
        </ToolGroupItem>
      ) : null}
    </div>
  );
}

/**
 * One collapsible tool group: the select-all checkbox (its own control,
 * outside the trigger), then a trigger with the chevron, the title, the
 * selection summary and the group description.
 */
function ToolGroupItem({
  idPrefix,
  kind,
  title,
  description,
  summary,
  select,
  defaultOpen,
  children,
}: {
  readonly idPrefix: string;
  readonly kind?: "unavailable";
  readonly title: string;
  readonly description: string;
  readonly summary: React.ReactNode;
  /** The group's select-all checkbox; without it the column stays empty. */
  readonly select?: React.ReactNode;
  readonly defaultOpen: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const titleId = `${idPrefix}-title`;
  const summaryId = `${idPrefix}-summary`;
  const descriptionId = `${idPrefix}-description`;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="exact-tool-group"
      data-kind={kind}
      role="group"
      aria-labelledby={titleId}
    >
      <div className="exact-tool-group-header">
        {select ? (
          <label className="exact-tool-group-select">{select}</label>
        ) : (
          <span className="exact-tool-group-select" aria-hidden="true" />
        )}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="exact-tool-group-trigger"
            aria-label={title}
            aria-describedby={`${summaryId} ${descriptionId}`}
          >
            <ChevronRight aria-hidden="true" />
            <span className="exact-tool-group-text">
              <span className="exact-tool-group-heading">
                <strong id={titleId}>{title}</strong>
                <span id={summaryId} className="exact-tool-group-summary">
                  {summary}
                </span>
              </span>
              <small id={descriptionId}>{description}</small>
            </span>
          </button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="exact-tool-list">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * One part of a group summary, after a "·" separator (the title comes
 * first). The spaces keep the parts apart in the accessible description;
 * the flex layout drops them visually.
 */
function SummaryPart({
  attention = false,
  children,
}: {
  readonly attention?: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      {" "}
      <span aria-hidden="true">·</span>{" "}
      <span data-attention={attention || undefined}>{children}</span>
    </>
  );
}

interface GroupSelection {
  readonly state: boolean | "indeterminate";
  /** Tools that can be granted now. */
  readonly selectable: number;
  /** "1 of 9 tools", counting only tools that can be granted now. */
  readonly label: string;
  /** Selected tools the catalog currently marks unavailable. */
  readonly unavailable: number;
}

function groupSelection(
  group: ExactToolGroup,
  selected: ReadonlySet<string>,
): GroupSelection {
  const selectable = group.tools.filter(({ available }) => available !== false);
  const count = selectable.filter(({ id }) => selected.has(id)).length;
  return {
    state:
      count === 0 ? false : count === selectable.length ? true : "indeterminate",
    selectable: selectable.length,
    label:
      selectable.length === 0
        ? "No tools available"
        : `${count} of ${selectable.length} ${selectable.length === 1 ? "tool" : "tools"}`,
    unavailable: group.tools.filter(
      ({ id, available }) => available === false && selected.has(id),
    ).length,
  };
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
