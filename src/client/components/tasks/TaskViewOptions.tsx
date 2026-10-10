import { AlignLeft, ArrowDownToLine, FileText, Pin, TextSearch } from "lucide-react";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu.js";
import {
  ScopeOptionItem,
  SortOptionItems,
  keepViewOptionsOpen as keepOpen,
} from "../scope-view/ViewOptionsItems.js";
import type {
  TasksView,
  TasksViewOptions,
} from "../../app/tasks-panel-store.js";

/**
 * The View options rows (sort, only, thread tasks, search notes) for one view:
 * the desktop View options menu, and on phones part of the ⋯ menu. Sort and
 * the view's scope option are the rows Workpads shares. Pinned tasks lead
 * each section whatever the sort.
 */
export function TaskViewOptionsItems({
  view,
  options,
  onChange,
}: {
  readonly view: TasksView;
  readonly options: TasksViewOptions;
  readonly onChange: (change: Partial<TasksViewOptions>) => void;
}): React.JSX.Element {
  return (
    <>
      <SortOptionItems value={options.sort} onChange={(sort) => onChange({ sort })} />
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Only</DropdownMenuLabel>
      <DropdownMenuCheckboxItem
        checked={options.onlyPinned}
        onCheckedChange={(onlyPinned) => onChange({ onlyPinned })}
        onSelect={keepOpen}
      >
        <Pin />
        Pinned
      </DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem
        checked={options.onlyBacklog}
        onCheckedChange={(onlyBacklog) => onChange({ onlyBacklog })}
        onSelect={keepOpen}
      >
        <ArrowDownToLine />
        Backlog
      </DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem
        checked={options.onlyWithNotes}
        onCheckedChange={(onlyWithNotes) => onChange({ onlyWithNotes })}
        onSelect={keepOpen}
      >
        <AlignLeft />
        With notes
      </DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem
        checked={options.onlyWithFiles}
        onCheckedChange={(onlyWithFiles) => onChange({ onlyWithFiles })}
        onSelect={keepOpen}
      >
        <FileText />
        With files
      </DropdownMenuCheckboxItem>
      <DropdownMenuSeparator />
      <ScopeOptionItem
        view={view}
        includeThreadItems={options.includeThreadTasks}
        includeThreadLabel="Include thread tasks"
        onChange={(includeThreadTasks) => onChange({ includeThreadTasks })}
      />
      <DropdownMenuCheckboxItem
        checked={options.searchNotes}
        onCheckedChange={(searchNotes) => onChange({ searchNotes })}
        onSelect={keepOpen}
      >
        <TextSearch />
        Search notes
      </DropdownMenuCheckboxItem>
    </>
  );
}
