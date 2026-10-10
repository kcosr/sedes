# Workspace panels

A thread's workbench arranges five panel kinds (Chat, Files, Workpads, Tasks,
and Terminals) in regions on the desktop stage. The layout is client-only
presentation state: no server or protocol state is involved. The code is under
`src/client/workspace-panels/`; the user-facing behavior is in
[Arrange panels](../user/conversations.md#arrange-panels).

| Module | Owns |
| --- | --- |
| `regions.ts` | The pure model: kinds, regions, state, queries, and every layout operation. |
| `region-geometry.ts` | Size hints, region boxes and dividers, and make-room. |
| `region-persistence.ts` | Storage keys, strict parsing, and the one-time migration from the previous layout keys. |
| `region-store.ts` | `PanelRegionStore`: the device layout plus each thread's Terminals, persistence, focus requests, intents, and the workspace dirty registry. |
| `PanelLayout.tsx` | One thread's workbench: the bar, the stage, retained panel content, header controls, announcements, and the phone layout. |
| `RegionStage.tsx` | Positions the visible panels and dividers from the geometry. |
| `PanelToolbar.tsx`, `PanelChrome.tsx`, `TerminalsPanel.tsx` | The workbench bar, the shared panel header, and the Terminals header and body. |
| `panel-kinds.tsx` | Panel titles, region names and phrases, and glyphs. |
| `use-panel-focus-requests.ts` | Carrying out the store's focus requests. |

## Model

The kinds are `chat`, `files`, `workpads`, `tasks`, and `terminals`, in that
fixed order, which is also the toolbar's order. Each kind is a singleton. The
regions are `middle` and the edge regions `left`, `right`, `top`, and
`bottom`.

The device layout (`RegionLayout`) is shared by every thread on the device:

| Field | Meaning | Default |
| --- | --- | --- |
| `placement` | The region each kind opens in. | Chat `middle`; Files, Workpads, Tasks `right`; Terminals `bottom` |
| `shown` | The kind each region shows, or null. A region only shows a kind placed there. | Chat in `middle`, Terminals in `bottom`, the rest empty |
| `loaded` | The loaded device-wide kinds: Files, Workpads, Tasks. | None |
| `extendOrder` | The edge regions, outermost first. | Left, Right, Top, Bottom |
| `sizes` | Per kind, a share of the stage per axis: a width for Left and Right, a height for Top and Bottom, within 0.05–0.95. | None |
| `maximized` | The panel filling the stage. Never saved. | None |
| `recency` | Kinds from least to most recently shown or used. Never saved. | Empty |

A thread's view (`RegionView`) combines the device layout with that thread's
Terminals panel: its tabs (at most 24, each a terminal ID and a stable
producer ID) and active tab, or null while it is not loaded.

A panel is **loaded** when its content is mounted: Chat always, Files,
Workpads, and Tasks for the device, and Terminals per thread. It is **shown**
when it is loaded and its region shows it; a region whose pick is not loaded
in this thread, such as the Bottom in a thread without Terminals, renders
empty. It is **visible** when it is shown, make-room has not hidden it, and no
other panel is maximized; a maximized panel is visible whatever its region
shows. The toolbar's states follow: visible, hidden (loaded but not visible),
or closed.

## Operations

Every operation is pure and returns the next state, or the same object when
nothing changed.

| Operation | Effect |
| --- | --- |
| `openPanel(kind, region?)` | Loads the panel if needed and shows it in its region, hiding without unloading what that region showed. With `region`, the panel first moves there, which becomes its placement, and its old region empties if it showed the panel. Ends Maximize, except when the maximized panel opens in place. Marks the panel most recent. |
| `togglePanel` | The quick button and Ctrl/⌘+Shift+L for Tasks: hides a visible panel and opens any other. |
| `hidePanel` | Empties the panel's region if it showed the panel; the panel stays loaded. Hiding the maximized panel ends Maximize. |
| `closePanel` | The header's ✕. Chat only hides. Any other panel unloads (Terminals for this thread, with its tabs) and its region empties. The caller asks first when the panel reports unsaved changes. |
| `movePanel` | ⋯ → Move to. Sets the placement; a loaded panel shows in the new region, replacing what it showed, and its old region empties. Ends Maximize. |
| `maximizePanel`, `restoreMaximized` | Set or clear `maximized`. The layout itself is unchanged, so Restore returns it exactly. |
| `setExtend(region, on)` | ⋯ → Full height or Full width: moves the region outermost, or innermost when turned off. |
| `setPanelSize` | Remembers a kind's share along an axis. |
| `notePanelUsed` | Marks a kind most recent when focus enters it or it is pressed. |
| `resetRegionView` | Reset layout: default placements and extend order, Chat alone in the Middle, every other panel unloaded (this thread's Terminals included). Sizes are kept. |

Terminal tabs have their own operations. `openTerminalTab` adds or selects a
tab, loads Terminals, and opens it in its place or a chosen region; it fails
for an invalid ID or at the tab limit. `activateTerminalTab` selects a tab and
shows Terminals. `closeTerminalTab` makes the left neighbour active; the panel
stays loaded with no tabs.

Nothing returns on its own: a hidden or replaced panel shows again only when
it is opened.

## Geometry

`computeRegionGeometry` lays out one thread's view on a measured stage. A
maximized panel fills the stage, with no dividers or make-room. Otherwise the
visible edge regions are taken in extend order: each is peeled off the space
left by the ones outside it, along its own axis, and the Middle takes the
rest. Each edge region has a 5px divider on its inner side. When the Middle
shows nothing, the innermost visible edge region takes the rest instead.

An edge region is extended, and its Full height or Full width item is
checked, when it is outside each perpendicular neighbour in the order (Left
and Right share corners with Top and Bottom). The outer region spans the full
length, so it takes the corners; turning a region on moves it outermost, so
the most recent choice wins a shared corner. The default order runs the sides
full height and spans Top and Bottom across the Middle only.

An edge region's size is its panel's remembered share of the stage along the
region's axis or, without one, its default from the size hints. It is kept at
or above its minimum and at or below what leaves the inner regions theirs.
Tenants supply hints from their `size` (`panelSizeHints`):

| Kind | Minimum (width × height) | Default |
| --- | --- | --- |
| Chat | 360 × 160px | 40% of the stage |
| Files | 320 × 240px | 520px wide, 560px tall |
| Workpads | 320 × 240px | 40%, up to 480px wide and 560px tall |
| Tasks | 300 × 240px | 35%, up to 380px wide and 480px tall |
| Terminals | 160 × 160px | 30% of the stage |

Dragging a divider previews the layout (`previewResize`) and records the
kind's share on release; a release where the drag began writes nothing, and a
double-click records the default. Sizes are device-wide, so a resize applies
in every thread.

## Make-room

Make-room is derived from the stage size on every layout and never stored.
When the visible panels' minimums overflow the stage in width or height, the
candidates are the visible edge regions except Chat's; the Middle is never a
candidate. They are ranked least recently shown or used first: opening and
moving a panel, focusing it, or pressing in it makes it recent.

Every subset of candidates (at most four) is weighed: the least overflow, then
the subset whose most recent member is least recent, then the fewest regions,
then the older ones. Older regions therefore go together before a newer one,
the panel just opened goes only when nothing else makes room, and no region is
hidden that the fit doesn't need. When no subset fits, the remaining minimums
shrink together in proportion.

A panel hidden to make room stays loaded and its region keeps showing it, so
it returns when the stage has room. Its quick button is outlined; pressing it
opens the panel, which makes it most recent and may hide another region
instead. `PanelLayout` announces the change ("Files hidden to make room.",
"Files shown again.") in a polite live region, except when a thread mounts or
is switched to.

## Persistence

| Key | Value |
| --- | --- |
| `sedes-panel-regions@1` | `{ version: 1, placement, shown, loaded, extendOrder, sizes }` for the device. |
| `sedes-thread-panel-regions@1:<threadId>` | `{ version: 1, threadId, terminals }` for one thread, with the thread ID URI-encoded in the key; `terminals` is `{ tabs, activeTerminalId }` or null. |

Parsing is strict. A value that is not exactly what the serializer writes is
rejected as a whole: the device layout falls back to the defaults and a
thread's Terminals to not loaded. Only a size share outside its bounds is
dropped on its own. Storage that throws reads as empty, writes are best
effort, and a value is written only when it changes. On load, Files, Workpads,
or Tasks without a registered tenant are closed.

Each browser tab keeps its layout in memory and does not follow other tabs'
writes, so the most recent write is what a reload or a new tab starts from.

### Migration

When a new key is absent, the value is migrated once from the previous layout
keys and saved under the new key. The old keys are only read, never removed.

- **Device layout**, when any of `sedes-workspace-files-panel-state@1`,
  `sedes-workpads-panel-state@1`, `sedes-tasks-panel-state@1`,
  `sedes-panel-instance-sizes@5`, or `sedes-panel-companions@1` exists:
  - Tasks and Workpads keep the edge their companion arrangement docked them
    at. Every other kind takes its default placement, since Chat, Files, and
    Terminals were placed per thread.
  - An open panel is loaded, and an open panel that was not collapsed is
    shown. When several share a region, the companion arrangement's outermost
    wins, then Tasks, Workpads, and Files.
  - Remembered sizes for Files, Workpads, Tasks, and Terminals carry over. The
    extend order is the default.
  - Unreadable old values count as absent panels.
- **A thread's Terminals**, when `sedes-thread-panel-instance-layout@4:<threadId>`
  exists: the Terminals panel's tabs and active tab carry over. A layout that
  cannot be read, or has no valid Terminals panel, migrates as not loaded.

Per-thread collapsed state, the rest of the old per-thread layout trees, and
the removed Opening panels preference (`sedes-panel-presentation`) are not
read.

## Store

`PanelRegionStore` holds the device layout in state shared by a root store and
the stores `forThread` creates. A change through any of them notifies them
all. The root store has no thread and never loads Terminals; each thread store
loads and saves its own Terminals. A snapshot carries the view, the loaded and
visible panels, the panels hidden to make room, Maximize, the stage and its
geometry, the thread's Terminals, and the pending focus request.

`PanelLayout` measures the stage with a `ResizeObserver` and sets it on the
store; until then, geometry is computed as if the stage filled the window.
Phones set no stage, which turns geometry and make-room off.

`open(kind, { region, intent, focus, focusScope })` returns false when the
panel can't load here: a kind whose tenant isn't registered, or Terminals
without a thread. Callers include the panels menu, the quick buttons, file
links and Task file chips (Files with an open-file intent), terminal opens,
and thread selection, which opens Chat with focus.

- **Intents** are delivered to a panel and consumed by it with
  `consumeIntent(kind, sequence)`. A Files intent for another workspace is
  dropped.
- **Focus requests** are made by opening, showing, and terminal-tab changes
  unless `focus` is false. Each has a sequence number, and optionally a
  terminal ID and a thread scope. `usePanelFocusRequests` focuses the panel's
  preferred control (the terminal, for Terminals) once its content can take
  focus, retrying for a few frames, then consumes the request; pressing or
  typing elsewhere abandons it. A Chat request waits for the composer while
  the thread loads. When a panel holding focus hides, focus moves to the next
  visible panel, or to the **Panels** trigger.
- **The workspace dirty registry** records a workspace's unsaved Files edits
  for the navigation and `beforeunload` guards.

## Rendering

Each loaded panel's content renders into a retained portal target. Its
region's slot adopts the target while the panel is visible; otherwise an
inert, `aria-hidden` parking element holds it. Content therefore survives
hiding, replacement, moves, Maximize, and thread switches; Files remounts
when the workspace changes. Closing a panel unloads it and unmounts its
content. `RegionStage` renders the visible panels as siblings keyed by kind
and positioned by percentage boxes, so moving or maximizing a panel never
remounts it. The terminal renderer attaches only while Terminals is visible.

Tasks keeps its retained body in the Tasks host
(`components/tasks/tasks-host.tsx`); the layout publishes whether Tasks is
loaded and visible, its presentation (`panel`, or `sheet` on phones), its
header controls, and a way to show Chat, and Tasks draws its own header.

Escape restores a maximized layout unless it belongs to a focused text field,
composer, or terminal, or to an open dialog, menu, or listbox.

## Phones

At `(max-width: 819px)` there is no stage geometry, make-room, Maximize, or
Move to; a maximized layout is restored on crossing the width. One foreground
panel is chosen among the shown panels: the panel a focus request names, else
the one last selected, else the first in the fixed order, and Chat when none
is shown, so a thread never shows an empty stage. Switching panels opens them
in the device layout, so a panel that shares its placement with another
replaces it there, as on desktop. Files, Workpads, and Tasks render their
`sheet` presentation; for Tasks that is the touch layout, with the add bar
under the list and a task's detail in place of the list. Panel headers drop
Maximize and Move to, and the **Panels** menu drops its place buttons. Opening
Tasks without focus, as a transcript task card's **Open task** does, still
brings it in front.

Crossing the width keeps every loaded panel's content. An open Tasks editor
keeps its edit: when the new layout leaves Tasks off stage (another panel in
front on the phone, or make-room on desktop), the Tasks host shows Tasks
again for it.

Chat is the phone's home. Its header has no ✕, and its quick button does
nothing while Chat is in front. Closing or hiding the panel in front, or
Android Back, shows Chat by opening it: when another panel replaced Chat in
its region, Chat shows there again, which writes the device layout. A hidden
panel, or one Back left, stays loaded, and Back leaves its region showing it.
A panel the closed one had replaced in its region does not come back. Tasks'
**Add to prompt**, and a task's thread link, show Chat the same way, through
the published `showChat`, so the composer is in front and Tasks stays loaded.

Android Back first runs `handleExposedBack` (`app/android-back.ts`), a chain
of cancelable window events whose listener cancels one to say it took Back:
`sedes:close-task-detail`, which the Tasks panel in front claims while a task
detail is open, returning to its list; `sedes:close-workpad`, which a shown
Workpads panel claims while a workpad is open; then `sedes:show-chat`, which
the active phone layout claims while a panel other than Chat is in front.
Each step yields to an open overlay, menu, or the drawer. Only then does Back
dismiss overlays and open the drawer, so the drawer opens once Chat is in
front.

Terminals is a viewer, an open `dialog` that Android Back dismisses with a
cancelable Escape, with a same-URL history entry. Browser Back, Android Back,
and Escape go back through the entry to Chat; Terminals stays loaded and its
quick button brings it back. The entry exists only while the viewer is in
front: leaving it another way (✕, another panel, a wider window) pops it, so
switching away and back never adds entries, and browser Back from Chat, Files,
or Workpads stays a route traversal. Settings suspends the viewer and keeps
its entry.
