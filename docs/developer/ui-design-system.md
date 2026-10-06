# UI design system

This is the reference for the browser client's tokens, primitives, and layout
kits. Read it before changing presentation. The code is the authority; each
section names the file to read for details. Paths below are relative to
`src/client/`.

| What | Where |
| --- | --- |
| Tokens, both themes, the density switch, the Tailwind bridge | `styles.css`, section `§ TOKENS AND THEME CONTRACT` |
| Primitives | `components/ui/` |
| Dialog and sheet anatomy, overlay motion | `components/ui/overlay.css` |
| Floating surface and menu row class recipes | `components/ui/floating.ts` |
| Settings kit and its only stylesheet | `components/settings/`, `settings.css` |
| Top-level page frame | `components/Workbench.tsx`, `components/automation/automations-view.css` |
| Automation state words and glyphs | `automation/automation-health.ts`, `automation/automation-text.ts`, `components/automation/AutomationGlyph.tsx` |
| Style guardrails | `styles.guardrails.test.ts`, `styles.guardrails.baseline.json` |

Build feature UI from the `components/ui/` primitives (imported as
`@client/components/ui/*`) rather than the Radix parts behind them, so it gets
the shared surfaces, layers, and focus rules; compose classes with `cn()`. A
new primitive or kit part gets unit tests and its CSS beside the component, or
in `overlay.css` for overlay anatomy.

## The reference-surface rule

The sidebar, the chat (transcript and composer), and the headers are the
reference design. Tokens are derived from them; other surfaces are made to
match them, not the reverse.

- In `§ SHELL, SIDEBAR, AND PAGES` (the sidebar parts), `§ THREAD VIEW AND
  HEADER`, `§ TRANSCRIPT AND CONVERSATION`, and `§ COMPOSER AND INTERACTION`,
  only value-preserving changes are allowed, with zero pixel difference. A
  deliberate off-scale value there gets a named token, such as
  `--text-transcript-meta: 12.5px`, instead of being snapped to the ramp.
- Menus, popovers, and pickers opened from those surfaces are not reference
  surfaces; they use the shared menu system below.
- The workbench bar and panel headers take `--workbench-bar-height` as a
  minimum and grow with their text (Android text zoom enlarges text, not
  heights). Their icon buttons use `--bar-control` and `--bar-icon`; the chat
  header's action glyphs are one step quieter (`--bar-icon` − 2px) on the same
  hit areas.

**Workspace panels** have minimum widths: Chat 360px, a tenant its
`size.minWidth` (Tasks 300px, Files and Workpads 320px), and Terminals and
panels without a declared minimum the divider's 160px floor. A split gives each
pane its fraction but never less than its minimum; when it cannot hold both,
the minimums shrink together in proportion. A panel that arrives on the desktop
stage collapses the least recently used side panels when the visible minimums
no longer fit; resizing the window or switching threads never collapses one.
A tenant first opens at its `size.preferredWidth`; with `size.preferredShare`
it takes that share of the stage instead, kept between its minimum and
preferred width (Tasks takes 35%: 300px at 1024px, 380px at 1440px;
Workpads 40%, 320–480px). The rules
are in `workspace-panels/layout-fit.ts`; declare a new tenant's minimum in its
`size`. From then on, each side panel keeps one share of the stage width (or
height, docked above or below) in every thread layout: a resize records it,
and each thread's splits are fitted to it, so Chat absorbs the difference
(`workspace-panels/panel-sizes.ts`). Tasks and Workpads also share their
place: every thread wraps its own panels in one companion arrangement, the
edges and order the user last set (`workspace-panels/companion-layout.ts`).

**Panel headers.** Every tenant except Tasks gets the shared `PanelChrome`:
icon, title, subtitle, unsaved dot, busy spinner, then collapse, ⋯ (Dock) and
close. A tenant puts its panel-level actions into the header by portaling
ghost icon buttons into `context.chromeActionsTarget`, sized like the other
bar controls (add its container to the `--bar-control` list in
`styles.css`). Through its host it sets the subtitle, dirty and busy state,
a back step drawn in place of the icon (`host.setBack`; behind it the
subtitle, the open view's name, takes the title's place), and its own ⋯ items
after the Dock group (`host.setMenuItems`, a memoized node that renders inside
the layout's menu, so menu primitives work in it; a sheet under touch
density). Document actions belong in
one hairline toolbar under the header, as in the Files editor and Workpads,
not in the header.

## Tokens

`:root` holds the light values and `:root[data-theme="dark"]` overrides only
raw values; tokens defined with `var()` or `color-mix()` follow automatically.
Consume tokens rather than literals, and add a token when a value has a role.

| Group | Tokens |
| --- | --- |
| Color contract | shadcn semantics (`--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`) plus `--muted-foreground-2`, `--border-soft`, `--code`, `--success`, `--info`, `--warning`, `--scrim`, `--sidebar-*`, `--syntax-*`, `--terminal-*`, environment tint |
| Status pairs | `--{success,info,warning,destructive}-{soft,border}`, mixed in oklab so the hue holds |
| Type | `--text-micro` 10, `--text-label` 11, `--text-meta` 12, `--text-ui` 13, `--text-body` 14.5, `--text-title` 15, `--text-sheet-title` 17, `--text-page` 20, `--text-display` 24, `--text-transcript-meta` 12.5, `--text-input`; `--weight-*`, `--leading-*`, `--tracking-label` |
| Spacing | `--space-0-5` 2 through `--space-8` 32, on a 4px grid with 2px half steps |
| Controls and icons | `--control-xs/sm/md/lg` 24/28/32/36, `--control-touch` 44, `--control-default`; `--icon-xs/sm/md/lg` 12/14/16/20; `--workbench-bar-height`, `--bar-control`, `--bar-icon` |
| Shape | `--radius-inline` 6 (only inside another rounded box), `--radius-ctl` 8, `--radius-card` 12, `--radius-lg` 16 |
| Interaction | `--hover` (the one wash for rows, ghost buttons, menu items), `--selected`, `--disabled-opacity`, `--destructive-solid(-hover)`, `--focus-ring` |
| Elevation and motion | `--elevation-1/2/3` (raised, floating, dialogs); `--duration-*`, `--motion-*` |
| Floating surfaces and dialogs | `--menu-row-height`, `--menu-row-radius`, `--menu-panel-padding`, `--menu-panel-radius`, `--dialog-width-sm/md/lg/xl` 400/560/760/1000, `--dialog-padding`, `--dialog-radius`, `--dialog-viewport-margin` |
| Layout | `--measure`, `--settings-page-width` 880, `--settings-page-width-wide` 1120 |

The `@theme inline` bridge exposes every semantic color, status pairs
included, to Tailwind and pins its text, shadow, and radius scales to the ramps
above; `--text-base` stays 16px for inputs.

## Density switch and touch sizes

There is one density query, `(max-width: 819px), (pointer: coarse)`: 820px is
the app breakpoint, and a coarse pointer gets touch density at any width. CSS
reads the tokens the switch sets; TypeScript uses `useTouchDensity()` or
`matchesTouchDensity()` from `app/use-touch-density.ts`. Under the switch,
`--control-default` and `--menu-row-height` become 44px, `--dialog-padding`
16px, and text inputs 16px so iOS does not zoom. `--workbench-bar-height` becomes 54px (52px otherwise),
`--bar-control` 40px tall and `--bar-control-width` 36px (both 32px), and
`--bar-icon` 20px (18px).

Inputs, `NativeSelect`, `SelectTrigger`, tabs, and switch hit areas follow
`--control-default`. Buttons keep fixed heights; a container opts its buttons
into touch height, as dialog footers and the settings save bar do. Component
layout uses container queries; media queries come only from the allowed set in
the guardrails (the breakpoint, 519px footer stacking, pointer, hover, and
reduced motion). The sidebar-to-drawer swap uses `(max-width: 819px)` alone.

## Primitives

**Buttons.** `Button` variants: `default` for the primary action, `outline`
for secondary actions and Cancel, `secondary`, `ghost` for toolbars and icon
buttons, `link`, `destructive`, and `destructive-outline`. `destructive` is a
solid fill reserved for confirming irreversible actions (delete, revoke, deny,
discard, Force reset); `destructive-outline` is the trigger that opens such a
confirmation, as in a Danger zone. Reversible actions such as Archive stay
neutral. Sizes: `xs`, `sm`, `default`, `lg`
(24/28/32/36) and `icon`, `icon-xs`, `icon-sm`, `icon-lg`.

**Controls.** `Input`, `Textarea`, `NativeSelect` (plain option lists; the
platform picker on touch), `Select`, `Checkbox`, `RadioGroup`, `Switch` (an
on/off setting that applies as it flips), `SegmentedControl` (one of a few,
always set, with a selected thumb), and `Tabs` (underlined sections of one
item) share the control box in `components/ui/control.ts`. `Field` takes `label`,
`description`, `error`, and `orientation`, and wires `id`,
`aria-describedby`, and `aria-invalid` into its control. The wiring resets
inside dialogs, sheets, popovers, and menus, so a dialog opened from a field
starts a new form.

**Status and feedback.** One tone vocabulary (`components/ui/tone.ts`),
`neutral | info | success | warning | danger`, serves every status primitive. Buttons and menu items name
an action with `variant="destructive"` instead.

| Primitive | Use it for |
| --- | --- |
| `StatusPill` | The one live state of a row or header (Connected, Changes pending) |
| `Tag` | A fixed, neutral attribute: a kind, Default, Disabled |
| `Badge` | Other short labels: `tone`, `appearance` soft or outline, `size` xs or sm |
| `CountBadge` | Counts on tabs and items; neutral is a wash, info/warning/danger are solid |
| `Callout` | The one notice and error style, with `title` and `action`; pass `role="alert"` for errors the user just caused |
| `EmptyState` | Nothing to show: `panel` for a page or pane, `inline` inside a list |
| `KeyValueList` | Labelled facts in a `max-content 1fr` grid; `mono` for identifiers |

## Dialogs

| `DialogContent` prop | Values and use |
| --- | --- |
| `size` | `sm` (confirmations), `md`, `lg`, `xl`, or `viewer` for media |
| `layout` | `modal`, `side` (a trailing panel), or `sheet` |
| `mobile` | Under the density switch: `card`, `sheet`, or `fullscreen`. A modal defaults to `card` at `sm`, `fullscreen` at `viewer`, else `sheet`; side and sheet layouts default to `sheet` |
| `dismissible` | `false` blocks Escape, outside clicks, and the X, for example while an action is pending |
| `showClose`, `showOverlay` | Hide the X or the scrim |
| `layer` | `dialog`; `over-dialog` when opened from the mobile drawer or a sheet; `blocking` inside or over a blocking operation |
| `returnFocusRef` | Where focus returns when a dialog opened from a menu row closes, since the row unmounts with its menu |

The surface is a flex column capped at the viewport, on `--popover` with a
hairline border, `--elevation-3`, and `--dialog-radius`, over one `--scrim`
with no blur. Compose it from slots: `DialogHeader` (`DialogTitle`,
`DialogDescription`, and the X on the title row), `DialogBody` (the only scroll
region), `DialogSection` (a titled group), `DialogAlert` (a `Callout`, announced
when `danger`), and `DialogFooter`. The footer puts tertiary actions in its
`start` slot, then outline Cancel, then the primary action last; below 520px
they stack full width with the primary on top. While an action runs, its label
ends in "…" and dismissal is locked.

On open, focus goes to an element marked `data-autofocus`, else the first
field, else the primary footer action, or the first non-destructive action
when the primary is destructive. It never goes to the X. A sheet is a bottom
panel with rounded top corners, safe-area padding, and an X (no drag handle),
lifted above the soft keyboard through `--keyboard-inset`. Floating content
opened inside a dialog portals into it.

Reopening during an exit animation creates fresh content and a fresh scrim.
Delayed outside-press and focus-restoration events from the previous opening
cannot dismiss or steal focus from the new one. Closing dialog surfaces let
pointer input through; open modal dialogs retain their normal isolation.
Retained content portaled outside a modal's React ancestry, such as the Tasks
body, activates its dialogs only after the host modal mounts so the host does
not hide an editor that has already reopened from assistive technology.
Hover surfaces ignore leave and blur events from descendants portaled outside
their DOM boundary, so a closing child dialog cannot dismiss its owning roster
before focus returns.

`ConfirmDialog` is the only confirmation, never `window.confirm`: a small card,
also on phones, with no X; Cancel is the way out. Name the verb and object in
`confirmLabel` ("Remove backend"). `tone="danger"` makes the confirm solid red
and focuses Cancel. An async `onConfirm` that rejects keeps the dialog open
with the message inline; `blockers` lists reasons that disable the action. `DiscardChangesDialog` is the
one unsaved-changes guard: **Keep editing** (focused) and a destructive discard
whose `discardLabel` names what follows ("Discard and leave").

## Menus and pickers

`Popover`, `DropdownMenu`, `ContextMenu`, `Select` content, and
`SearchableSelect` share one floating surface (`floatingSurfaceClass`):
`--popover`, a hairline border, `--menu-panel-radius`, `--elevation-2`, the
shared pop-in motion, no arrows, and 8px collision padding.

Menu rows follow one anatomy (`menuRowClass` and its siblings): the
`--menu-row-height`, 13/20 text, 16px muted icons, and the `--hover` wash for
both pointer hover and keyboard focus, with no focus ring. Give every row in a
menu an icon, or none, so labels align. Labels never wrap.

| Part | Use |
| --- | --- |
| `Item` with `ItemDescription` | A two-line row: 13/500 title over a 12px muted line |
| `CheckboxItem`, `RadioItem` | State: a trailing check and weight 500 when checked |
| `Label` | The 11px uppercase eyebrow; never user text. `variant="header"` (with `description`) names a subject such as a thread |
| `Item variant="destructive"` | Red on the same wash; last, after a separator |
| `Value` | A current value or a disabled row's short reason ("Running"): muted, row-sized, truncating before the label. Long values such as workspace paths stay in the submenu |
| `Shortcut` | Keyboard hints only |
| `Empty` (`loading`) | A non-focusable empty or loading row, never a disabled item |

**Menu-to-sheet.** Set `presentation="sheet"` on `DropdownMenu` or
`ContextMenu` when `useTouchDensity()` is true and the menu has more than six
items or any submenu. The same parts render as a bottom sheet with 44px rows;
`sheetTitle` and `sheetDescription` on the content give its header (the
subject's name and a meta line), and submenus drill in with a back row.

**Picker shell.** `SearchableSelect` is the one searchable picker, at least as
wide as its trigger, with a plain search row over a divider. Options carry
`label`, `description`, `icon`, `searchTerms`, `group`, `pinned` (always
shown), `disabled`, or `unavailable` (dimmed with a note, still selectable).
Set `descriptionIsPath` when the description is a path: a long one gives way
from its start, so its last segments stay visible, and the row's tooltip keeps
it whole.
`presentation="dialog"` shows the shared bottom sheet; `trigger` takes a custom
trigger such as a composer pill. Custom pickers reuse `SearchableSelectSearch`.

## Settings kit and the split layout

The pages are listed in `settings-pages.ts` (id, label, distinct icon, group,
description, availability). A new page needs a registry entry, a slug in
`app/settings-route.ts`, and its render case in `SettingsView.tsx`.

| Part | Use it for |
| --- | --- |
| `SettingsPage` | One page: title, description, `actions` (primary last), `back`, `width` default or `wide` |
| `SettingsSection`, `SettingsSubgroup` | A titled group, at most one `card` level; a subgroup is a 12px heading over a divider |
| `SettingsField`, `SwitchField`, `SettingsActionRow` | A labelled row with the control in a 220–360px column (stacking under the density switch or below 640px of page), an on/off row, an item row with buttons |
| `SaveBar` | The sticky footer of a form: state on the left, then Cancel, an optional `secondaryAction`, and Save on the right; "Saved" is transient here. The secondary action is an outline second way to save, such as "Save as paused" beside "Save and enable", enabled exactly when Save is; its `saving` flag moves the saving label onto it |
| `EntityList`, `EntityRow` | Inventory rows at least 56px tall: the whole row opens the item; one `StatusPill`; the actions menu is its own tab stop |
| `DangerZone`, `DangerZoneItem` | Always the last section; each `destructive-outline` trigger opens a `ConfirmDialog` (a reversible item uses a plain outline) |
| `SettingsSearch`, `SettingsBackLink` | The search above a list; the "‹" link, which goes up through history so it and Back agree |

Use one save model per page type: switches apply at once, forms save through
`SaveBar`. Clear notices and errors on navigation (`useTransientNotice`), and
return focus from dialogs with `useFocusReturn`.

**Split and stack.** An inventory page (Environments, Backends, Agents) wraps
its list and selection in `SettingsSplit` inside a `SettingsPage` whose
`selection` is `none`, `detail`, or `editor`. A container query on the
settings column puts a 300–340px list beside the selection at 960px or wider;
below that the page shows the list or the selection, and content marked
`data-stack="list"` goes with the list. `wide` gives a long editor the full
width. Use `SettingsDetailHeader` for a detail header and `SettingsEditor` for
an editor (section anchors, errors, form, and `SaveBar`). Selection and editing
are routes: `app/settings-route.ts` parses `resourceId` and `mode` (`view`,
`edit`, `new`, `pending`), and `settingsResourceParent` is the one "up" target
for the "‹" links and Escape. `useSettingsSplitFocus` restores list scroll and
focus. Guard unsaved edits with `installNavigationBlocker` and
`DiscardChangesDialog`; a page that keeps an editor in local state registers it
with `useSettingsEscapeLevel`.

## Top-level pages

Archived, Usage, Automations, an automation's page, and its editor are pages
without a thread: `Workbench.tsx` renders each in `pane-host-nav-header`, a
column whose header holds only the sidebar trigger (shown when the sidebar is
collapsed or hidden), with no workspace panels and no Tasks. A new page adds
its root class to the `pane-host-nav-header > …` flex rule in `styles.css`.
The three automation pages share one frame in `automations-view.css`,
matching the Archived page: `.automations-view` is the scroller, and
`.automations-page` is the centred column, `--measure` wide, and the
`automations-page` query container. Keep both classes on a page root.

A page can build on the settings kit. `SettingsDetailHeader` and
`SettingsEditor` title themselves as `h2` under a Settings page; pass
`headingLevel={1}` when they are the page's own header. Section anchors follow
the nearest scrolling ancestor, so an editor works in a page's own scroller
as well as the settings column, and `SaveBar` sticks to that scroller. A "‹"
link to a parent the page is always under uses `navigateUp(path)` (the
`SettingsBackLink` default); a page reached from several places, such as an
automation's page, passes `navigateBack(fallback)`, which returns to the
previous entry when this document opened it and otherwise replaces the entry
with the fallback.

## Automation state vocabulary

Every surface that shows an automation (sidebar rows and groups, the thread
preview, the header button, thread notices, the Automations list, and the
automation page) takes its state, words, and glyph from the shared helpers. Do
not derive automation state, labels, tones, or icons in a component; extend
the helpers and their tests.

| Helper | Use |
| --- | --- |
| `automationHealth(thread, now)` | The one state, first match wins: `sending`, `failed`, `unknown` (an uncertain last run), `archived`, `snoozed` (only while the wake time is ahead), `active`, `paused`, `not_started`. Each carries its list `group` (`needs_attention`, `upcoming`, `paused`, `suspended`), `glyph`, chip `tone`, and `label` |
| `automationNeedsAttention`, `automationIdentityGlyph`, `automationIdentityLabel` | Failed or uncertain for attention buckets; the Repeat, CirclePause, or spinner glyph for surfaces that show attention separately, as a row badge or a tinted header button |
| `compareAutomationsInGroup`, `AUTOMATION_HEALTH_GROUPS` | List group order and the order within a group |
| `describeSchedule`, `runStateLabel`, `runSkipReason`, `runMeta` | Schedule sentences, run state words, and one-line run facts. `completed` reads "Delivered": the backend accepted the prompt, not that the turn ended |
| `automationStatusText`, `lastRunAge`, `automationErrorText` | The short state for tooltips and status lines, the last run's age, and an error code as a sentence where only the code is projected |
| `futureTimeLabel` (`lib/time.ts`) | The one format for upcoming instants: next runs and wake times |
| `AutomationGlyph` | Draws a health glyph at `sidebar`, `list`, or `header` size; colors only `danger`, `warning`, and `info`, so Active and Paused stay quiet |

Uncertain runs need attention everywhere, and paused is never a warning tone.
Repeat is the automation icon in menus, headers, and rows.

## Z layers

Every positive `z-index` names a layer; `0` and negative values stay local to
their stacking context. Within a band, use `calc(var(--z-x) + n)`.

| Layer | Value | Holds |
| --- | --- | --- |
| `--z-sticky` | 1 | In-page sticky and raised chrome |
| `--z-floating` | 50 | In-page popovers |
| `--z-dialog` | 80 | Dialogs; floating surfaces portalled to the body sit at +10 |
| `--z-drawer` | 81 | The mobile drawer |
| `--z-over-dialog` | 100 | Sheets and dialogs over the drawer or a dialog, menu sheets, tooltips |
| `--z-blocking` | 110 | The operation overlay, dialogs over it, confirmations and pickers over sheets |

## Style guardrails

`styles.guardrails.test.ts` runs with `npm test`; it parses client CSS with
postcss and scans TSX. Unresolved `var()` references are zero-tolerance: every
`var(--x)` without a fallback must resolve to a defined property, a
`--radix-*` property, or an entry in `RUNTIME_SET_PROPERTIES` for a property
set from code. The other rules ratchet against
`styles.guardrails.baseline.json`, which counts offenders per rule and file: color literals outside `§ TOKENS AND THEME CONTRACT`; `font-size`,
`font-weight`, `border-radius`, and `z-index` literals; `!important`; media
queries outside the allowed set; and, in TSX outside `components/ui/`, Tailwind
palette colors, `text-[Npx]`, and hex colors in `style=`.

A count above the baseline fails: fix the new offender and never raise the
baseline. A count below it also fails until you lock in the improvement, which
only ever lowers counts:

```sh
env -u NODE_ENV UPDATE_STYLE_GUARDRAILS=1 npx vitest run src/client/styles.guardrails.test.ts
```

Commit the lowered baseline with the change. On a merge conflict in the
baseline, take either side and run the same command.
