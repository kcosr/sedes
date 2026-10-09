import { ArrowDownAZ, CalendarArrowDown, Clock, Layers, MessageSquare } from "lucide-react";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../ui/dropdown-menu.js";
import type { ScopeListSort, ScopeView } from "./scope-views.js";

const SORTS: readonly { value: ScopeListSort; label: string; icon: typeof Clock }[] = [
  { value: "newest", label: "Newest", icon: CalendarArrowDown },
  { value: "updated", label: "Recently updated", icon: Clock },
  { value: "title", label: "Title", icon: ArrowDownAZ },
];

/** Choosing an option keeps the menu open, so several can be set in a row. */
export const keepViewOptionsOpen = (event: Event) => event.preventDefault();

/** View options › Sort: Newest, Recently updated or Title. */
export function SortOptionItems({
  value,
  onChange,
  disabled,
}: {
  readonly value: ScopeListSort;
  readonly onChange: (sort: ScopeListSort) => void;
  readonly disabled?: boolean;
}): React.JSX.Element {
  return (
    <>
      <DropdownMenuLabel>Sort</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        aria-label="Sort"
        value={value}
        onValueChange={(next) => {
          const sort = SORTS.find((candidate) => candidate.value === next);
          if (sort) onChange(sort.value);
        }}
      >
        {SORTS.map(({ value: sort, label, icon: Icon }) => (
          <DropdownMenuRadioItem key={sort} value={sort} disabled={disabled} onSelect={keepViewOptionsOpen}>
            <Icon />
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}

/**
 * The view's own scope option: All's **Group by project**, or Project's
 * **Include thread …** (its threads' items join the project's own). Other
 * views have none.
 */
export function ScopeOptionItem({
  view,
  groupByProject,
  includeThreadItems,
  includeThreadLabel,
  onChange,
  disabled,
}: {
  readonly view: ScopeView;
  readonly groupByProject: boolean;
  readonly includeThreadItems: boolean;
  /** "Include thread tasks", "Include thread workpads". */
  readonly includeThreadLabel: string;
  readonly onChange: (change: { groupByProject?: boolean; includeThreadItems?: boolean }) => void;
  readonly disabled?: boolean;
}): React.JSX.Element | null {
  if (view === "all") {
    return (
      <DropdownMenuCheckboxItem
        checked={groupByProject}
        disabled={disabled}
        onCheckedChange={(checked) => onChange({ groupByProject: checked === true })}
        onSelect={keepViewOptionsOpen}
      >
        <Layers />
        Group by project
      </DropdownMenuCheckboxItem>
    );
  }
  if (view === "project") {
    return (
      <DropdownMenuCheckboxItem
        checked={includeThreadItems}
        disabled={disabled}
        onCheckedChange={(checked) => onChange({ includeThreadItems: checked === true })}
        onSelect={keepViewOptionsOpen}
      >
        <MessageSquare />
        {includeThreadLabel}
      </DropdownMenuCheckboxItem>
    );
  }
  return null;
}
