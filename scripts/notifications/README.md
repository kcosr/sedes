# Assistant voice notification hook

`sedes-notify-assistant.py` consumes the Sedes version 3 notification JSON on
stdin and invokes a separately installed `assistant-notifications-cli`.
It sends a visible title/body and separate speech in event → workspace → thread
title order. Speech shortens thread titles to 12 words and 80 characters.
For `turn.completed`, the hook reads the sections selected in the notification
UI, in **Provisional → Unclassified → Final** order. Unselected section keys
are omitted from `assistantResult`. Missing, null, empty, or whitespace-only
sections add no speech. With no response text, the normal completion
announcement remains. Response whitespace and control characters are normalized;
this hook does not truncate text. Upstream truncation remains in effect. The
visible notification body is unchanged.

Version 3 carries only selected sections. Update this hook together with the
server; it intentionally rejects prior versions. Under **Turn completed → Response text**, all sections are off by default.
Select Final to hear the final answer.
Select Unclassified to hear Grok's response or other output without reliable
phase evidence; this may include progress commentary. No script arguments are
needed to choose which phases are spoken.

The hook requires Python 3 at `/usr/bin/python3`, Node at `~/.local/bin/node`,
and the Assistant CLI at `~/.local/bin/assistant-notifications-cli`, all under
the Sedes service account. Its destination is `https://assistant`; that hostname
must resolve from the server. This home-network hook explicitly accepts any TLS
certificate by setting `NODE_TLS_REJECT_UNAUTHORIZED=0` only in the notification
CLI's environment. HTTPS remains encrypted, but the server's identity is not
verified. No CA certificate file is required.

The CLI is an external dependency and is not included here.
This hook contains no credentials. Notification content is assembled at runtime
and can contain thread/project names, reminder text, and generic diagnostics.

Install or update from the repository root:

```sh
install -m 0755 scripts/notifications/sedes-notify-assistant.py \
  ~/.local/bin/sedes-notify-assistant
```

In **Settings → Notifications**, use the installed absolute path, no arguments,
and a 30-second timeout. Select the desired events and enable notifications.
An installed copy is independent of checkout branch changes; reinstall after
updating this source. No server restart is required for wrapper updates.

To preview without sending a notification:

```sh
~/.local/bin/sedes-notify-assistant --dry-run < payload.json
```

The UI test sends an actual notification. Normal hooks are best effort, with
no retries or delivery guarantee. Approval/input notifications contain generic
event descriptions and thread context, not the command or question being asked.
