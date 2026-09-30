import { Layers3, Plus, Ungroup } from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { Button } from "@client/components/ui/button";
import {
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@client/components/ui/context-menu";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@client/components/ui/dialog";
import { Field } from "@client/components/ui/field";
import { Input } from "@client/components/ui/input";
import {
  matchesSearchQuery,
  SearchableSelectSearch,
} from "@client/components/ui/searchable-select";

export interface MoveToGroupOption {
  readonly id: string;
  readonly name: string;
}

const ITEM_SELECTOR =
  '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

/**
 * The picker's rows after its search field, in order: the submenu's rows, or
 * in the touch sheet the drill-in pane's rows below its back row.
 */
function pickerRows(search: HTMLInputElement | null): HTMLElement[] {
  const container = search?.closest<HTMLElement>(
    '[data-slot="context-menu-sub-content"], [data-slot="menu-sheet-pane"]',
  );
  return Array.from(container?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []).filter(
    (row) =>
      !row.matches(':disabled, [data-disabled], [aria-disabled="true"]') &&
      Boolean(search!.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING),
  );
}

/** Keys the search field keeps: the menu must not read them as typeahead or navigation. */
function keepsKey(event: KeyboardEvent<HTMLInputElement>): boolean {
  if (event.key === "Escape" || event.key === "Tab") return false;
  // Left from the start of the field closes the submenu, as it does from a row.
  if (event.key === "ArrowLeft") {
    const input = event.currentTarget;
    return input.selectionStart !== 0 || input.selectionEnd !== 0;
  }
  return true;
}

/**
 * "Move to group": a searchable submenu on desktop and a searchable drill-in
 * in the touch sheet. A plain search row filters the groups (the current one
 * carries the trailing check); when nothing matches, a "Create group" row
 * creates it and moves the thread in one step. "New group…" is always
 * present at the end, with "Remove from group" while the thread has one.
 * Typing goes to the search; the arrow keys move into the results and Enter
 * picks (from the search, the first result).
 */
export function MoveToGroupSubmenu({
  groups,
  currentGroupId,
  disabled,
  sheet,
  onAssign,
  onCreate,
  onNewGroup,
  onRemove,
}: {
  readonly groups: readonly MoveToGroupOption[];
  readonly currentGroupId: string | null;
  readonly disabled: boolean;
  /** The touch sheet presentation: the search is not focused on opening. */
  readonly sheet: boolean;
  readonly onAssign: (groupId: string) => void;
  /** Create a group with this name and move the thread into it. */
  readonly onCreate: (name: string) => void;
  /** Open the create dialog, prefilled with the search text. */
  readonly onNewGroup: (name: string) => void;
  readonly onRemove: () => void;
}): React.JSX.Element {
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger disabled={disabled}>
        <Layers3 aria-hidden="true" />
        Move to group
      </ContextMenuSubTrigger>
      <GroupPicker
        groups={groups}
        currentGroupId={currentGroupId}
        sheet={sheet}
        onAssign={onAssign}
        onCreate={onCreate}
        onNewGroup={onNewGroup}
        onRemove={onRemove}
      />
    </ContextMenuSub>
  );
}

function GroupPicker({
  groups,
  currentGroupId,
  sheet,
  onAssign,
  onCreate,
  onNewGroup,
  onRemove,
}: Omit<Parameters<typeof MoveToGroupSubmenu>[0], "disabled">): React.JSX.Element {
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const name = query.trim();
  const matching = groups.filter((group) => matchesSearchQuery(query, [group.name]));
  const firstRow = () => pickerRows(search.current)[0];
  const lastRow = () => pickerRows(search.current).at(-1);
  const typeIntoSearch = (text: string) => {
    setQuery((current) => current + text);
    search.current?.focus();
  };
  return (
    <ContextMenuSubContent
      // The desktop submenu is wide enough to search in, with the search row
      // flush at its top; the sheet's drill-in keeps the sheet's width.
      className={sheet ? undefined : "w-64 pt-0"}
      onKeyDown={(event) => {
        if (event.target === search.current) return;
        // Typing on a row (or the panel) goes to the search, not typeahead.
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          typeIntoSearch(event.key);
        } else if (event.key === "ArrowUp" && event.target === firstRow()) {
          event.preventDefault();
          search.current?.focus();
        }
      }}
    >
      <GroupSearch
        inputRef={search}
        sheet={sheet}
        value={query}
        onChange={setQuery}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            (event.key === "ArrowDown" ? firstRow() : lastRow())?.focus();
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (name) firstRow()?.click();
          }
          if (keepsKey(event)) event.stopPropagation();
        }}
      />
      {name && matching.length === 0 ? (
        <ContextMenuItem onSelect={() => onCreate(name)}>
          <Plus aria-hidden="true" />
          <span className="thread-action-label">Create group “{name}”</span>
        </ContextMenuItem>
      ) : null}
      {matching.length > 0 ? (
        <ContextMenuRadioGroup
          aria-label="Groups"
          value={currentGroupId ?? ""}
          onValueChange={(groupId) => {
            if (groupId !== currentGroupId) onAssign(groupId);
          }}
        >
          {matching.map((group) => (
            <ContextMenuRadioItem key={group.id} value={group.id}>
              <Layers3 aria-hidden="true" />
              <span className="thread-action-label">{group.name}</span>
            </ContextMenuRadioItem>
          ))}
        </ContextMenuRadioGroup>
      ) : null}
      {name || matching.length > 0 ? <ContextMenuSeparator /> : null}
      <ContextMenuItem onSelect={() => onNewGroup(name)}>
        <Plus aria-hidden="true" />
        New group…
      </ContextMenuItem>
      {currentGroupId !== null && (
        <ContextMenuItem onSelect={onRemove}>
          <Ungroup aria-hidden="true" />
          Remove from group
        </ContextMenuItem>
      )}
    </ContextMenuSubContent>
  );
}

/**
 * The shared search row at the top of the picker. On desktop it takes focus
 * as the submenu opens; the touch sheet opens for browsing, and typing is a
 * tap away.
 */
function GroupSearch({
  inputRef,
  sheet,
  value,
  onChange,
  onKeyDown,
}: {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly sheet: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}): React.JSX.Element {
  useLayoutEffect(() => {
    if (!sheet) inputRef.current?.focus({ preventScroll: true });
  }, [inputRef, sheet]);
  return (
    <div className="thread-group-picker-search" data-sheet={sheet || undefined}>
      <SearchableSelectSearch
        ref={inputRef}
        role="searchbox"
        aria-label="Search groups"
        placeholder="Search groups"
        maxLength={120}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

/** The comparison key the server uses for group names. */
function groupNameKey(name: string): string {
  return name.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

/**
 * "New group…": create a group with this thread in it. Only the name; the
 * existing groups live in the picker the user came from. Validation (empty,
 * duplicate, or the server's own) sits on the field.
 */
export function NewGroupDialog({
  open,
  initialName,
  groups,
  onOpenChange,
  onCreate,
  contentRef,
  returnFocusRef,
}: {
  readonly open: boolean;
  readonly initialName: string;
  readonly groups: readonly MoveToGroupOption[];
  readonly onOpenChange: (open: boolean) => void;
  /** Resolves once the group exists with the thread in it; a rejection's message shows on the field. */
  readonly onCreate: (name: string) => Promise<unknown>;
  readonly contentRef?: RefObject<HTMLDivElement | null>;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [openedWith, setOpenedWith] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  // Each opening starts from its own prefill.
  if (open && openedWith !== initialName) {
    setOpenedWith(initialName);
    setName(initialName);
    setError(undefined);
  } else if (!open && openedWith !== undefined) {
    setOpenedWith(undefined);
  }
  const submit = async () => {
    if (pending) return;
    const trimmed = name.normalize("NFKC").trim();
    if (!trimmed) {
      setError("Enter a name for the group.");
      input.current?.focus();
      return;
    }
    if (groups.some((group) => groupNameKey(group.name) === groupNameKey(trimmed))) {
      setError(`A group named “${trimmed}” already exists.`);
      input.current?.focus();
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await onCreate(trimmed);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "The group could not be created.");
      input.current?.focus();
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent
        ref={contentRef}
        size="sm"
        layer="over-dialog"
        dismissible={!pending}
        returnFocusRef={returnFocusRef}
        onOpenAutoFocus={(event) => {
          // The prefill is a suggestion: typing replaces it.
          event.preventDefault();
          input.current?.focus({ preventScroll: true });
          input.current?.select();
        }}
      >
        <DialogHeader>
          <DialogTitle>New group</DialogTitle>
          <DialogDescription>Creates a group with this thread in it.</DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogBody>
            <Field label="Group name" error={error}>
              <Input
                ref={input}
                maxLength={120}
                value={name}
                disabled={pending}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(undefined);
                }}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
