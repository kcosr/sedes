import type { ComponentType, ReactNode } from "react";
import {
  ContextMenuItem,
  ContextMenuItemDescription,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@client/components/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuItemDescription,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@client/components/ui/dropdown-menu";

/**
 * The menu parts a shared block of rows needs. A block rendered inside a
 * ContextMenu takes the ContextMenu parts and inside a DropdownMenu the
 * DropdownMenu parts, because each Radix part must sit under its own root;
 * both render as sheet rows under `presentation="sheet"`.
 */
export interface MenuParts {
  readonly Item: ComponentType<{
    readonly children?: ReactNode;
    readonly className?: string;
    readonly disabled?: boolean;
    readonly variant?: "default" | "destructive";
    readonly title?: string;
    readonly "aria-describedby"?: string;
    readonly onSelect?: (event: Event) => void;
  }>;
  readonly ItemDescription: ComponentType<{ readonly children?: ReactNode }>;
  readonly Separator: ComponentType<object>;
  readonly Shortcut: ComponentType<{
    readonly children?: ReactNode;
    readonly "aria-hidden"?: boolean | "true" | "false";
  }>;
  readonly Sub: ComponentType<{
    readonly children?: ReactNode;
    readonly onOpenChange?: (open: boolean) => void;
  }>;
  readonly SubTrigger: ComponentType<{
    readonly children?: ReactNode;
    readonly disabled?: boolean;
  }>;
  readonly SubContent: ComponentType<{ readonly children?: ReactNode }>;
}

export const contextMenuParts: MenuParts = {
  Item: ContextMenuItem,
  ItemDescription: ContextMenuItemDescription,
  Separator: ContextMenuSeparator,
  Shortcut: ContextMenuShortcut,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};

export const dropdownMenuParts: MenuParts = {
  Item: DropdownMenuItem,
  ItemDescription: DropdownMenuItemDescription,
  Separator: DropdownMenuSeparator,
  Shortcut: DropdownMenuShortcut,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};
