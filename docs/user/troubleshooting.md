# Troubleshooting and recovery

Sedes distinguishes ordinary errors from operations that may already have
crossed a provider boundary. When an outcome is uncertain, preserving that
uncertainty is safer than silently repeating work.

## Start with the visible state

Before changing configuration or restarting services:

1. Read the complete callout or disabled-control reason.
2. Note whether the thread is Draft, idle, active, disconnected, archived, or
   in recovery.
3. Preserve any displayed reference ID.
4. Use **Try again**, **Retry**, **Restore**, **Reconcile**, or another action
   only when the callout offers it.
5. Avoid sending the same prompt from another client while the first operation
   is uncertain.

Sedes can retry only when it can prove an operation was not applied. When it
can prove acceptance, it adopts the result. Otherwise it keeps a visible
blocker.

## The application does not start

Check the basics in order:

- Node.js is 24.18 or newer.
- Dependencies were installed with `NODE_ENV` unset:

  ```sh
  env -u NODE_ENV npm ci
  ```

- Development uses `env -u NODE_ENV npm run dev`.
- Production was built and has a valid server configuration file at
  `${XDG_CONFIG_HOME:-$HOME/.config}/sedes/server.json`, or
  `SEDES_CONFIG_FILE` names another absolute file.
- The configuration is the current strict schema and every placeholder path
  was replaced.
- The selected port is not already in use.

The server logs contain the operator-facing startup classification. See
[Getting started](getting-started.md) and
[Configuration](../operator/configuration.md).

## A backend is unavailable

Provider availability depends on the account that runs the Sedes process. A
provider that works in your interactive terminal may fail in a service with a
different `HOME`, provider-specific home variable, `PATH`, executable path, or
file permissions.

Check the provider guide:

- [Pi](../operator/backends/pi.md#troubleshooting)
- [Codex](../operator/backends/codex.md#troubleshooting)
- [Claude](../operator/backends/claude.md#troubleshooting)
- [Grok](../operator/backends/grok.md)

Do not copy provider credentials into browser settings or Sedes configuration.
Authenticate the provider in the operating-system account that runs Sedes and
restart only when the operator intends to replace active runtimes.

## No models are selectable

The usual causes are:

1. provider authentication or native catalog discovery failed;
2. the live provider returned no eligible models;
3. the installation's `modelPolicy` filtered the catalog; or
4. an existing selection is now denied or unavailable.

Sedes does not invent a default or substitute a nearby model/effort. Ask the
operator to verify the live catalog and policy, then explicitly choose an
admitted setting.

## An action or setting is missing

Controls are capability-driven. Check:

- [the provider comparison](provider-features.md#compare-providers);
- whether the thread is idle, active, archived, disconnected, or recovering;
- whether the operation requires a completed turn or an idle source;
- whether the target is local or SSH;
- whether the selected model advertises the capability; and
- whether runtime version or installation policy disables it.

Examples: Grok shows neither Steer nor forks; Claude shows Steer, but it goes
to the conversation instead of the running turn; managed Codex TUI requires an
eligible external Codex connection with unrestricted catalog policy, and on an
SSH or outbound host a persistent sidecar with working terminal support; Files
on SSH requires the managed sidecar.

## A project cannot be opened

The path must be absolute and inside the roots configured for the selected
execution environment. Browsing a directory does not admit it permanently;
**Add project** performs the final check.

For SSH, verify the configured OpenSSH alias and remote root. Sedes never falls
back to the server host's same-looking path when remote access fails.

## A thread fails to load

A moved or removed project, unavailable backend, oversized/invalid history, or
temporary attach failure can prevent an authoritative snapshot.

- Repair the directory, provider, or connection.
- Choose **Try again** for a fresh attach.
- If a cached snapshot is shown, treat it as read-only until the new attach is
  authoritative.

Temporary load failures receive up to three automatic retries before Sedes
waits for you. Keep the displayed reference ID for server delivery diagnostics.

## First send is uncertain

First send both creates a provider conversation and delivers the initial input.
A dropped response can make acceptance impossible to prove.

Do not create another thread or copy the prompt into a native provider client.
Use the recovery card to adopt, retry only after proven non-acceptance, or
abandon the recorded local attempt when that is the offered final action.
Sedes will not silently send the initial prompt twice.

## Send or Queue failed

When Sedes proves the input did not cross the provider boundary, it removes the
temporary presentation and restores or reconciles the draft. If the draft is
no longer empty, use the offered controls to avoid overwriting newer work.

A queue row that is still user-owned can be removed or restored to an empty
composer. A row that is dispatching or uncertain cannot be cancelled because
the provider may already own the work.

## Steer is unconfirmed

An exact-target Steer may have been accepted even when its response is lost.
Sedes keeps **Steer unconfirmed** visible and does not return the contribution
to the composer until reconciliation or target-turn settlement proves it was
not accepted.

Do not resend the same correction. If the target turn ended before acceptance
and non-acceptance is provable, Sedes converts the exact input to ordinary
Queue work for the next turn.

## Stop is uncertain

Stop is a request to the provider, not proof that every operation or external
side effect halted. Wait for authoritative thread state or follow the recovery
card. Repeating Stop cannot roll back work already completed.

## An approval or question disappeared

Pending provider interactions survive browser navigation and reconnect while
the same provider runtime remains alive. They do not survive a server/provider
runtime replacement unless the provider presents the request again.

If the request is still current, reopen the thread and wait for its
authoritative snapshot. If the turn ended, the provider withdrew the request,
or the runtime restarted, do not fabricate an answer in chat. Review the turn
outcome and start a new turn only when safe.

## An attachment will not send

Check:

- count and size limits in [Files and context](files-and-context.md#attach-whole-files-or-images-to-the-composer);
- whether upload completed before delivery;
- whether the file changed or failed integrity validation;
- whether the execution environment supports staging; and
- whether the selected model supports native image input, when image content
  rather than a staged file is required.

Sedes rejects the complete input if one attachment cannot be staged safely. It
does not send a partial set. Remove or replace the failing attachment and try
again only after the upload card reports a clean state.

## Files is unavailable or a link will not open

Files availability belongs to the exact execution environment. An SSH target
needs the configured managed Files capability. A file link must resolve
uniquely inside an admitted primary, supplemental, or supported link-only root
and pass file-type and sensitive-file checks.

Task paths and Markdown links are references, not authorization. Add the
correct project or supplemental root when appropriate; do not widen server
roots merely to make an untrusted link open.

## A file save conflicts

Another client or program changed the saved file after your editor opened.
Choose:

- **Reload** to use the saved version;
- **Overwrite** only after deliberately reviewing the conflict; or
- **Keep editing** to preserve your local draft while comparing externally.

Refresh does not discard the dirty editor automatically.

## An automation did not run

Confirm that:

- the automation is enabled rather than paused;
- its schedule preview shows the expected time zone and next occurrence;
- the thread and target are available;
- a local precheck exited zero;
- the selected clone boundary is eligible; and
- the run is not waiting at an attended approval.

Open automation history to distinguish skipped, missed/coalesced, waiting,
failed, and uncertain occurrences. SSH prechecks are unsupported and fail
rather than executing remotely.

## A packaged client cannot connect

On Android, use **Settings > Server** to enter a complete origin with no path
or credentials, choose **Test**, then **Save & connect**. In Electron, use
**Settings > Connection > Switch connection**, select Local or the named
profile, and retry **Connect**. For Direct or SSH, verify that the server admits
the client's exact Host/Origin and that the intended private network route
exists.

If Electron Local does not start:

- close Electron completely and retry once; Local is an app-session child, not
  a separately managed service;
- inspect the `server.json` within the private `managed-local` subtree beneath
  Electron's user-data directory. Electron seeds it only when absent and never
  replaces an invalid or manually edited file;
- confirm that provider executables, authentication, model setup, and
  provider-native stores required by the enabled backend are available to the
  same desktop account; and
- do not redirect a source checkout or another Sedes process to Electron's
  managed state directory.

Back up the complete `managed-local` subtree only while Electron is stopped.
Deleting it is destructive: it removes Local configuration and Sedes-owned
application state, but does not remove provider-owned conversations or
credentials. Do not use deletion as routine connection troubleshooting.

Opening the chooser from Local intentionally leaves Local running. Cancelling
the warning or a failed/cancelled Direct or SSH candidate restores Local. A
successful replacement stops Local before it is shown. If Electron reports
that Local cleanup could not be proved, the candidate is abandoned rather than
leaving a hidden second server; quit Electron before retrying.

For an Electron SSH profile:

- confirm the remote Sedes daemon is running on
  `127.0.0.1:<remote-port>` and its schema-version-11 bootstrap file includes
  `electron` in `packagedClients`;
- run `ssh <alias>` as the same desktop account and resolve host-key,
  password, passphrase, multifactor, key, agent, and routing problems there;
- keep user, port, key, and proxy-jump settings in the system OpenSSH alias;
  the Electron form deliberately accepts only that alias and the remote Sedes
  port; and
- retry manually after repairing SSH. Electron does not loop on failed
  authentication or silently fall back to another profile.

If an active SSH process exits, Electron closes the application connection and
returns to the chooser. Reconnect only after checking the SSH route and remote
daemon. The tunnel provides transport, not a Sedes login or a new server
identity.

Do not work around a connection failure by enabling a public listener or
Tailscale Funnel. Follow the [Android](../operator/clients/android.md),
[Electron](../operator/clients/electron.md), or
[Operations](../operator/operations.md) guide for a supported boundary.

## Force reset

**Force reset…** is the final user-authoritative escape hatch for unresolved
Sedes-owned recovery records. Read the preview carefully. It also counts the
background agents and commands running in the affected conversations, or says
when that work is unknown; replacing their loaded runtimes may stop it.

Force reset abandons only the listed local blockers. It does not:

- stop provider work;
- delete provider history;
- prove the provider is idle;
- undo external side effects; or
- erase the evidence that an outcome was uncertain.

A fresh provider projection may still reveal active work or an orphaned native
conversation after reset. Use it only when reconciliation cannot progress and
you accept that boundary.

## Collect diagnostics for support

Open **Settings → Diagnostics** and use only the built-in, bounded diagnostics
relevant to the symptom. Clear the
buffer, enable one category, reproduce once, copy the log, then turn the
category off. Keep reference IDs and timestamps with the report.

Operators and developers should follow
[Debug diagnostics](../developer/diagnostics.md) before adding logging or
sharing provider data.

## Failed turn details

When the current turn fails, the thread shows an explanation alongside its failed
status. Starting another attempt clears the current explanation; clicking Send
when the request is rejected does not. Older failed turns retain **Failed turn
details** that you can expand without keeping the sidebar in an error state.
Provider details unavailable from retained history use a generic explanation.
Pi retries are not final failures until retry processing has settled. Grok
submission refusals and uncertain outcomes keep their existing recovery controls.
The sidebar reflects loaded runtimes, so its failed indicator can disappear when
a runtime is unloaded and return when the failed conversation is reopened.

Previous: [Settings](settings.md) · Back to the [User guide](index.md)
