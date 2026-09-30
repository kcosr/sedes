/**
 * The floating surface shared by Popover, DropdownMenu, ContextMenu, Select
 * content and the searchable picker: the popover color, a hairline border,
 * the menu panel radius and the menu elevation. Motion lives in
 * `overlay.css` (keyed on each primitive's data-slot); nothing draws arrows.
 *
 * Portalled to the body the surface sits at 90, above the mobile drawer and
 * the dialog band; opened inside a dialog it portals into the dialog node
 * (see `DialogPortalContainerContext`) and so layers above that dialog.
 */
export const floatingSurfaceClass =
  "z-[calc(var(--z-dialog)+10)] rounded-(--menu-panel-radius) border border-border bg-popover text-popover-foreground shadow-(--elevation-2) outline-hidden"

/** Floating content keeps this far from the viewport edges. */
export const FLOATING_COLLISION_PADDING = 8

/** Gap between a trigger and the floating content it opens. */
export const FLOATING_SIDE_OFFSET = 4

/**
 * A submenu clears its parent panel's inset and border by a small gap, and
 * its first row lines up with the row that opened it.
 */
export const SUBMENU_SIDE_OFFSET = 10
export const SUBMENU_ALIGN_OFFSET = -5

/**
 * A menu panel: the floating surface with the menu inset. Plain menus stay
 * within 320px; menus with description rows may grow to 420px.
 */
export const menuPanelClass = `${floatingSurfaceClass} min-w-[9rem] max-w-[min(320px,calc(100vw-16px))] overflow-x-hidden overflow-y-auto p-(--menu-panel-padding) has-[[data-slot$=item-description]]:max-w-[min(420px,calc(100vw-16px))]`

/**
 * The menu row: `--menu-row-height` (44px under the density switch), 13/20
 * text, 16px muted icons, and the one `--hover` wash for both pointer hover
 * and keyboard focus (menu rows draw no focus ring). A row with an
 * `…-item-description` child becomes a two-line row with a 500 title.
 */
export const menuRowClass =
  "relative flex min-h-(--menu-row-height) w-full cursor-default items-center gap-2 rounded-(--menu-row-radius) px-2 text-left text-(length:--text-ui) leading-5 text-foreground outline-hidden select-none " +
  "data-highlighted:bg-(--hover) data-disabled:pointer-events-none data-disabled:opacity-(--disabled-opacity) " +
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground " +
  "has-[[data-slot$=item-description]]:items-start has-[[data-slot$=item-description]]:py-1.5 has-[[data-slot$=item-description]]:font-medium has-[[data-slot$=item-description]]:[&>svg]:mt-0.5"

/** Destructive rows: red text and icon on the same neutral wash. */
export const menuRowDestructiveClass =
  "data-[variant=destructive]:text-destructive data-[variant=destructive]:*:[svg]:text-destructive!"

/** Checkbox and radio rows: a trailing check and weight 500 when checked. */
export const menuCheckRowClass = "pr-8 data-[state=checked]:font-medium"

/** Where the trailing check sits in a checkbox, radio or select row. */
export const menuCheckIndicatorClass =
  "pointer-events-none absolute top-1/2 right-2 flex size-4 -translate-y-1/2 items-center justify-center text-foreground [&_svg]:text-foreground"

/** The 11px uppercase section label; never used for user text. */
export const menuLabelClass =
  "px-2 pt-2 pb-1 text-(length:--text-label) leading-4 font-semibold tracking-(--tracking-label) text-muted-foreground-2 uppercase"

/** The non-uppercase header for names (a stack, a thread, a group). */
export const menuHeaderClass =
  "px-2 pt-1.5 pb-1 text-(length:--text-ui) leading-5 font-medium text-foreground"

/** A 1px rule across the panel, 4px above and below. */
export const menuSeparatorClass =
  "-mx-(--menu-panel-padding) my-1 h-px bg-border"

/** A trailing shortcut or short reason ("Running"). */
export const menuShortcutClass =
  "ml-auto shrink-0 pl-4 text-(length:--text-meta) leading-4 font-normal text-muted-foreground-2 tabular-nums"

/** The second line of a two-line row. */
export const menuDescriptionClass =
  "block text-(length:--text-meta) leading-4 font-normal text-muted-foreground-2"

/** A non-focusable empty or loading row. */
export const menuEmptyClass =
  "flex min-h-(--menu-row-height) items-center justify-center gap-2 px-2 py-2 text-center text-(length:--text-meta) leading-4 text-muted-foreground-2 [&_svg]:size-3.5 [&_svg]:animate-spin"
