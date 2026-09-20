# Terminal panes

Each terminal in Sedes belongs to a thread and runs on that thread's execution
environment. A terminal starts in the project's workspace directory, but it is
a normal shell: you can `cd` elsewhere and use everything available to the
local or remote operating-system account.

Terminals are independent from agent conversations. A terminal can keep
running while no terminal panel is open, and a thread can have more than one
terminal. The panel’s **+** menu lists running and retained terminals for the current
thread without opening a connection to each one.

## Open and control a terminal

Choose **Terminals** from the application header’s **Panels** menu to reveal an
existing Terminals panel without changing its selected tab. If no panel is
open, it opens an existing usable terminal, or creates a terminal when none
can be opened. Older retained records remain available in the panel’s **+**
menu for removal.

The **+** menu creates a **New terminal**, reopens a closed tab, or ends and
removes a terminal with the X beside its entry. Closing the last tab leaves an
empty panel with a **New terminal** button. Revealing that empty panel keeps it
empty until you create a terminal or reopen one from **+**.

Opening **Terminals** from **Panels** uses the split layout. Once a Terminals
panel exists, its application-header shortcut follows the device's **Opening
panels** preference; Shift-click temporarily uses the opposite presentation.

Opening the first terminal creates one client-local **Terminals** panel in that
thread's workspace, split below the chat by default. Opening another terminal
adds a tab inside that panel. The panel's **+** menu greys terminals that
already have a tab, preventing duplicate connections. The panel
itself can still be docked beside Chat or Files with the normal panel controls.

Terminal tabs, their order, and the selected tab belong only to this client.
Switching threads restores that client's terminal tabs for the selected thread
and never carries them into another thread. Only the selected tab attaches to
its server terminal. It first restores the retained screen and scrollback, and
input remains disabled until that restore catches up to current output.
On desktop, opening the panel or activating a terminal focuses its input once
it is ready. Mobile does not autofocus terminal input or open the keyboard.

On a fine-pointer desktop, right-click a terminal tab and choose **Rename** to
edit its name in place. Enter or moving focus away saves the new name; Escape
cancels the edit. The keyboard context-menu key or Shift+F10 opens the same
menu. On touch layouts, open the tab’s **Terminal actions** menu and choose
**Rename**.

Several clients can observe one terminal. Exactly one panel controls keyboard
input and terminal size. Opening the selected terminal on a visible client,
reloading that page, or returning it to the foreground takes control after
history restoration and immediately publishes that client's freshly measured
rows and columns. The prior controller becomes read-only; it does not have to
release control first. An observer can also choose **Take control** from the
panel menu to retry the same handoff explicitly. A compact amber
lock after the active terminal tab label identifies a confirmed observer; it
does not appear during attach, replay, or an automatic control request.

Observers use the terminal's canonical row and column size even when their
viewport is smaller. Local scrolling, selection, and search do not resize or
modify the remote terminal. Terminal search uses the same Find control as chat,
including previous and next navigation, while searching terminal text rather
than the conversation transcript.

## Closing is not terminating

These actions are intentionally different:

| Action | Effect |
| --- | --- |
| **Tab X** | Removes an exited, failed, or interrupted terminal and its history. For an active terminal, offers **Close tab** or **End terminal** by default. |
| **Close tab** in the confirmation | Detaches this client's view of one terminal. The shell keeps running. |
| **Close panel** | Closes every local tab in this Terminals panel. All shells keep running. |
| **End terminal** | Ends the shell for every connected client, then removes its resource and retained history once process termination is confirmed. |
| **Disconnect and remove** (older transport-only records) | Closes the old owned connection before removing that record and history. It does not prove remote process cleanup. |
| **Remove terminal** | Removes a terminal and its retained history after it exited, failed, or was interrupted on its own. |
| **New terminal** | Creates a separate terminal in the same thread, starting again in the project's workspace directory. |

In **Settings → Terminal**, **Confirm before ending active terminals** is enabled
by default and applies only to this client. Turn it off to make the tab X end
terminals and remove them immediately after confirmed cleanup. Ending or
removing affects every client
and deletes retained history. A failed request leaves the tab open with an
error; disabling confirmation does not bypass server cleanup checks.
A reconnecting connection is not evidence that a terminal has ended.
With confirmation enabled, a terminal whose state is unknown or already
stopping offers only **Close tab** and **Cancel**.

The terminal panel header menu has no separate end/remove action. Use the
**+** menu’s X actions for terminals without open tabs.

The X at the right of an existing terminal in the terminal drop-down opens a
confirmation dialog. Confirming ends a live terminal and removes its history,
or removes an
already ended, failed, or interrupted terminal and its retained history.

Closing a browser, Electron window, Android view, or mobile Back navigation has
the same effect as **Close panel**. Reopen the terminal from the panel’s **+** menu later.

## Reconnects and interruptions

A brief network reconnect can resume an already-rendered panel. A reload or a
different client restores a server checkpoint and the ordered output after it
before joining live output. Sedes keeps the renderer hidden until that restore
has caught up, so an old terminal or an earlier pre-clear screen is not exposed
while the selected terminal is loading.

If output temporarily outruns one viewer's network or renderer, Sedes may
reconnect and restore that view from retained history while the shell keeps
running. Repeated reconnects mean that client is still falling behind; they do
not by themselves mean the local or SSH terminal process exited.

Server restore state contains up to the most recent 20,000 scrollback rows in a
serialized checkpoint no larger than 8 MiB. Sedes also checkpoints after 4 MiB
or 2,048 journal records so a fresh client does not replay an indefinitely
growing raw stream. When terminal output includes the standard `CSI 3 J`
erase-scrollback sequence, Sedes checkpoints immediately after applying it and
discards the older journal prefix. A normal `clear` implementation commonly sends that
sequence together with screen erasure; Sedes reacts to the terminal control
sequence rather than recognizing or interpreting shell commands.

Closing clients does not stop a terminal. A local terminal becomes
**Interrupted** if its main server restarts; its verified output remains
read-only. A persistent remote terminal survives main-server restart and SSH
loss, with bounded output kept on the sidecar. Reopening reconnects to the same
shell after reconciliation, without creating another process.

A remote sidecar restart interrupts its managed shells. Unexpected service loss
can leave cleanup unknown; wait for reconciliation before creating conflicting
work. Shells that exit naturally retain their history, including final output
produced while main was disconnected. An upgrade may remain blocked until that
output has been preserved.

Use **End terminal** to stop a local or persistent remote shell and remove its
history after cleanup is confirmed. Older transport-only records may instead
show **Disconnect and remove**; their original action closes the owned
connection and does not prove every remote job stopped. If the required effect
cannot be confirmed, Sedes retains the resource and history. If End reports that
it is still pending, it continues waiting for confirmation in the background;
reconnecting to the execution host lets it finish. If main restarts before
confirmation, the recovered history remains available for explicit removal.

If input delivery becomes uncertain during a remote disconnect, Sedes reports
the uncertainty and does not repeat the keystrokes automatically. After Sedes
reconnects, check the terminal state. If it still cannot confirm the input,
**Discard unconfirmed input** abandons those retained keystrokes and resumes
typing. The discarded keystrokes are not sent again, but they may already have
reached the terminal before the connection failed.

Scrolling up keeps the terminal on retained history while new output arrives.
Scroll back to the bottom to follow new output again. Older lines can still
expire when the scrollback retention limit is reached.

Normal typing is streamed through a bounded multi-frame window; it does not
wait for a network round trip after every key. A buffering indicator therefore
means the client has reached real transport backpressure, not that each
keystroke is awaiting its own acknowledgement.

## Mobile and accessibility

On a narrow screen, opening a terminal uses the available full stage or sheet.
Back closes the Terminals panel without terminating any shell. Touch scrolling
never injects input, and observer state remains visibly read-only. On
touch-primary devices, a compact TUI-style key strip and native command field
appear at the bottom; fine-pointer desktop layouts do not show that dock.

Terminal lifecycle and controller changes are announced separately from raw
output. Raw output is not an `aria-live` stream. The terminal's accessible mode
and searchable transcript provide alternatives for screen readers and content
that is difficult to navigate in the live grid.

A healthy connection has no green status indicator. The terminal tab shows a
status after its label only while its attachment is not ready or when the
terminal has exited, failed, or been interrupted. The application and chat
headers likewise stay quiet while connected and show status only when attention
is needed.

## Security note

A terminal has the authority of the Sedes service account locally or the
Sidecar SSH account remotely. The project directory is only its starting
directory, not a sandbox. Terminal history can include source, commands,
tokens printed by programs, and other sensitive data. Use it only through an
installation and network path you trust, and delete retained history when it
is no longer needed.
