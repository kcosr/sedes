import {
  AlignLeft,
  ArrowDownAZ,
  Circle,
  CircleCheck,
  Clock,
  FileText,
  Layers,
  MessageSquare,
  Pin,
  TextSearch,
} from "lucide-react";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu.js";
import type {
  TasksShow,
  TasksSort,
  TasksView,
  TasksViewOptions,
} from "./tasks-view-options.js";

const SORTS: readonly { value: TasksSort; label: string; icon: typeof Pin }[] = [
  { value: "pinned-newest", label: "Pinned, then newest", icon: Pin },
  { value: "updated", label: "Recently updated", icon: Clock },
  { value: "title", label: "Title", icon: ArrowDownAZ },
];

const SHOWS: readonly { value: TasksShow; label: string; icon: typeof Pin }[] = [
  { value: "open", label: "Open", icon: Circle },
  { value: "completed", label: "Completed", icon: CircleCheck },
];

// Choosing an option keeps the menu open, so several can be set in a row.
const keepOpen = (event: Event) => event.preventDefault();

/**
 * The View options rows (sort, show, only, grouping, search notes) for one
 * view: the desktop View options menu, and on phones part of the ⋯ menu.
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
      <DropdownMenuLabel>Sort</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        aria-label="Sort"
        value={options.sort}
        onValueChange={(value) => {
          const sort = SORTS.find((candidate) => candidate.value === value);
          if (sort) onChange({ sort: sort.value });
        }}
      >
        {SORTS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuRadioItem key={value} value={value} onSelect={keepOpen}>
            <Icon />
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Show</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        aria-label="Show"
        value={options.show}
        onValueChange={(value) => {
          const show = SHOWS.find((candidate) => candidate.value === value);
          if (show) onChange({ show: show.value });
        }}
      >
        {SHOWS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuRadioItem key={value} value={value} onSelect={keepOpen}>
            <Icon />
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
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
      {view === "all" && (
        <DropdownMenuCheckboxItem
          checked={options.groupByProject}
          onCheckedChange={(groupByProject) => onChange({ groupByProject })}
          onSelect={keepOpen}
        >
          <Layers />
          Group by project
        </DropdownMenuCheckboxItem>
      )}
      {view === "project" && (
        <DropdownMenuCheckboxItem
          checked={options.includeThreadTasks}
          onCheckedChange={(includeThreadTasks) =>
            onChange({ includeThreadTasks })
          }
          onSelect={keepOpen}
        >
          <MessageSquare />
          Include thread tasks
        </DropdownMenuCheckboxItem>
      )}
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
