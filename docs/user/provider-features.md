# Provider features

Sedes gives Pi, Codex, Claude, and Grok a common thread, composer, pending-input,
Tasks, Files, and organization experience. Provider capabilities still differ.
The interface hides an operation when the current backend, model, topology, or
thread state does not support it.

## Compare providers

| Capability | Pi | Codex | Claude | Grok |
| --- | --- | --- | --- | --- |
| Mid-turn Steer | Yes, aimed at the current turn | Yes, aimed at the current turn | Yes, delivered to the conversation | No; Queue instead |
| Stop | Yes | Yes | Yes | Yes |
| Background work indicator above composer | No | No | Subagents and commands | No |
| Manual compact | Yes | Yes | No | No |
| Exact completed-turn fork | Yes | Yes | Yes, idle source | No |
| Latest provider snapshot fork | No | Yes | No | No |
| Skills | Yes | Yes | Yes, eligible skills | Not currently |
| Structured questions | No | Questionnaires and MCP forms | Multiple-choice questions | Not exposed |
| Provider permission interaction | Primitive prompts | Approvals | Permission prompts | Not exposed |
| Native image input | Model dependent | Model dependent | PNG, JPEG, GIF, WebP | Model dependent |
| Generated-image display | No native artifact | Completed in-band PNG | No native artifact | Completed local ImageGen/ImageEdit JPEG |
| Remote (SSH or outbound) workspace | Managed workspace tools/context | Persistent runtime; separately granted Files/CLI | Persistent runtime; separately granted Files/CLI | No |
| Managed provider terminal | No | Eligible external connections | No | No |

This table is the plain-language summary. The
[capability matrix](../operator/backends/index.md#capability-differences) in the
operator guide is authoritative and carries the exact conditions; if the two
ever appear to disagree, the operator matrix is correct.

Steer means different things per provider. Pi and Codex steer the exact turn
that is running. Claude's Steer is delivered to the conversation at its next
native opportunity: it may join the running turn or start the next one, and it
never interrupts work. Grok has no Steer, so active-turn input waits in Queue.

Queue, durable drafts, stashes, Tasks, attachments in supported topologies,
saved Agents, templates, search, bookmarks, and inventory organization are
Sedes features shared across backends unless a specific input requires an
unsupported provider capability.

When a transcript contains a provider-proven compaction boundary, Sedes shows
**Conversation compacted**. The marker expands only when the provider retained
a genuine summary for that boundary. Pi summaries are expandable; Codex
boundaries are static because its native compaction item contains no summary.

## Settings are validated, not substituted

The operator defines which models and settings a target may use. The live
provider catalog can also change. Sedes preserves an unavailable historical
selection so you can understand the thread, but blocks new work until you
choose an admitted replacement. It does not silently switch models, efforts,
permissions, or execution settings.

Settings are generally applied at a turn boundary. Controls may be disabled
while a turn is active or when a provider runtime is unavailable.

## Respond to approvals and questions

Transcript command items, both the preview and expanded details, show the inner
script of a complete `bash -lc` wrapper for readability. Command approval dialogs
retain the exact provider-supplied command so you can review what is being
authorized.

When a provider needs permission or structured input, Sedes places a compact
panel above the composer in Chat or TUI. The transcript and composer remain
mounted and usable outside the panel, so you can inspect the turn or keep a
draft while deciding. There is no Sedes timeout.

For a decision, choose the primary action, an alternative, or the separate
rejection action. The chosen action submits immediately. Enter or Escape works
only when one truthful primary or rejection action is unambiguous; the panel
does not guess which choice you intended.

For a questionnaire:

1. Answer each question in order. Local answers remain while you move between
   questions.
2. Use an offered **Other** choice and note field when appropriate.
3. Leave a question explicitly unanswered when that is the intended answer;
   Sedes asks for confirmation rather than omitting it silently.
4. Submit the complete questionnaire.

MCP requests that only ask permission show **Allow** and **Cancel**, without an
empty JSON editor. When a request asks for information, complete its labeled
fields and choose **Continue**. Defaults and required-field validation follow
the request. Optional fields can be left out; a supplied **No** or zero still
counts as an answer. Invocation parameters, when provided, remain read-only
and separate from the information you submit.

Secret fields are masked while editing and use the ephemeral response path;
their contents are excluded from notices and diagnostics. Escape interrupts
the active turn when that operation is available—it never manufactures blank
answers. A visible note or Other editor may consume Escape first to close or
clear itself.

Focus enters the panel once, is not trapped there, and returns to the prior
meaningful control after the final request resolves. Desktop uses a compact
panel; mobile uses a safe-area-aware bottom panel with touch-sized controls.
Ordinary Tab navigation, arrow navigation, and available number shortcuts
remain usable.

A pending request survives navigation and reconnect while the same provider
runtime remains alive. A server or provider restart cannot preserve the native
callback; the provider must present the request again. After submission, the
panel remains disabled but visible until provider resolution is confirmed. A
proven-not-applied response can be tried again, while an uncertain outcome
stays in recovery rather than being submitted twice.

Codex MCP approvals show **Invocation parameters** when the provider supplies
the arguments for that request. These are read-only details of the tool call,
with sensitive values redacted. The JSON response editor is separate: an empty
`{}` response does not mean the tool was called without arguments.

Codex supports approvals and structured questionnaires. Claude supports its
permission decisions and eligible questions. Pi uses the decision panel for
its supported mutating-tool approval. Grok does not currently expose a
blocking-interaction UI.

## Let an agent use Sedes tools

Use **Thread actions > Agent tools…** to choose the exact Sedes application
tools available to that thread. In CLI mode, you can enable or disable access,
add or remove tools, and change the access boundary during a turn. Changes apply
to subsequent tool requests; work already admitted continues. The agent sees
added tools when it next requests discovery. Native-tool changes and changes
to the surface or mode require an idle thread.
Presentation has two controls:

- **Surface** chooses Native tools or the generated CLI. This selector appears
  only when the target supports more than one surface: eligible local Pi, and
  Codex and Claude threads.
- **Mode** chooses Progressive discovery or Individual named tools/commands.
  Progressive keeps the initial surface compact and describes operations on
  demand. Individual presents each granted operation directly with typed
  parameters.

Pi supports Native Progressive and Native Individual wherever native Sedes
tools are eligible, plus both CLI modes on eligible local threads. Codex and
Claude support both modes on both surfaces. Their Native tools come from a
Sedes MCP server that Sedes adds to the thread itself, so you do not configure
anything in Codex or Claude; the tools appear as `mcp__sedes__…` and the
provider's own permission settings apply to them. New Codex and Claude threads
start on Native tools with Individual mode; threads created before this change
keep their CLI setting until you change it. Grok supports both modes on its
single CLI surface,
so its surface selector is hidden. An unavailable combination is omitted
rather than silently replaced with another surface or mode.

For CLI presentation, `sedes --help`, group help, and progressive catalog
discovery reflect the thread's current grants. Adding or removing a grant in
this dialog changes the next discovery request, and every invocation rechecks
the current policy. The injected mode is only an instruction to the CLI; it
does not grant access.

The **Access boundary** setting determines when enabled tools ask for approval:

- **Ask outside this thread** asks before accessing another thread, project or
  global content, or resources outside the current thread's workspace.
- **Ask outside this environment** is the default and asks when a tool reaches
  another execution environment.
- **Allow without asking** skips this extra application prompt.

An approval waits across browser navigation or disconnect and applies only to
that exact invocation. None of these choices bypasses ordinary Sedes authority
or provider permission controls. Automations fail closed when access requires
an interactive decision. Delegated work is evaluated under the destination
thread's own policy. See the
[Agent-tools contract](../internals/agent-tools.md) for the complete tool and
authority model.

## Connect an external Tool client

External Tool clients use the same generated `sedes` CLI without inheriting a
thread policy or interactive cross-environment approval. Create, rotate,
disable, and revoke their credentials in **Settings > Tool clients**. See
[Tool clients](settings.md#tool-clients) for the one-time-token workflow and
network safety guidance.

## Check provider accounts and warnings

Open **Accounts** from the sidebar footer **More** menu to see the available
weekly windows, balances, reset credits, reset times, and last successful check
for configured provider accounts. Expand one account for details.

- **Check** asks the selected account—or all listed accounts—to run a live
  usage check through Provider Pulse; it is not merely a redraw of cached data.
- **Snapshot** records the current usage as a comparison baseline. Later views
  can describe what changed since that snapshot.
- While Accounts remains open, Sedes refreshes the displayed server status
  about once per minute and polls more quickly while a Check or Snapshot
  settles.

Quota is shown only for provider accounts that expose this capability. An
unavailable or stale result remains labeled instead of being estimated.

When Sedes or a backend publishes an active installation advisory, a numbered
**Warnings** control appears beside Settings. Open it to see the source, title,
and message for each warning. The control disappears when all advisories clear;
that does not dismiss or suppress a warning manually.

## Pi

Pi is the most direct option for native Pi models, tools, skills, tool-access
controls, usage, and cost reporting.

Thread controls include:

- provider and model selection;
- thinking level;
- Pi tool access: read-only, ask, or full;
- manual compact;
- native commands and skills;
- Send, Steer, Queue, Stop, and rename; and
- latest-completed or selected-completed-turn forks where the workspace shape
  supports them.

### Pi workspace execution

When a Local Pi target offers workspace isolation, **New thread** adds a
**Workspace execution** choice:

- **Project directly** lets Pi workspace tools operate on the remembered
  project under the ordinary target policy.
- **Writable isolated clone** creates a durable private Git clone. The agent
  can change that clone without mounting or modifying the source project.
- **Read-only project with writable home** mounts the exact source project
  read-only at `~/workspace` while leaving the rest of the private home and
  temporary directory writable. It is a live view, so outside source changes
  can become visible.

Both isolated choices start Pi in `/home/agent`, with the effective project at
`~/workspace`. The isolation boundary covers Pi's workspace shell and file
tools; provider authentication, model calls, conversation history, and the Pi
SDK remain in the Sedes process.

For an isolated thread, choose a network profile admitted by the operator:

- **Isolated** removes access to the execution host's network namespace.
- **Execution host** deliberately allows the sandbox to reach the host network,
  including loopback services, and is therefore a broader authority.

If Bubblewrap or an admitted profile is unavailable, Sedes hides or rejects
the isolated choice rather than falling back to direct project access.
Isolated Pi workspaces cannot currently fork, so fork controls remain absent or
unavailable on those threads. Direct local and supported managed-SSH Pi threads
retain their ordinary completed-turn fork behavior.

The isolated workspace survives normal worker shutdown and server restart.
Archiving keeps it by default. When archiving only that thread, you may instead
choose **Delete** after reviewing warnings for uncommitted, untracked, or
unpublished clone work. Read-only deletion removes only the private home, never
the source project.

For a writable clone, **Thread actions** also offers:

- **Import branch** to fetch its committed branch into the source repository;
- **Retain for outside use** to keep the clone and report its path for an
  explicit handoff; and
- **Delete isolated workspace…** for permanent removal after safety review.

Git import transfers committed objects, not uncommitted or untracked files.
Read-only workspaces do not offer branch import or outside handoff. See the
[Pi isolated workspace contract](../internals/pi-workspace-sandbox.md) for the
complete isolation and lifecycle boundary.

Pi tool access and Sedes agent-tool access boundary are separate approval
layers. Allowing a Pi tool does not grant a Sedes tool access to another
environment, and allowing a Sedes cross-environment operation does not broaden
Pi's read-only or ask mode.

Composer files use staged paths. A selected Pi model that advertises image
input can also receive verified native image content. Pi does not currently
produce Sedes native generated-image artifact items.

Pi can remain on the Sedes host while supported workspace file and shell
operations run through a managed SSH sidecar. Provider credentials and model
calls remain local in that arrangement, and skills stay local unless the
environment also enables bounded remote skill discovery.

See the [Pi operator guide](../operator/backends/pi.md).

## Codex

Codex exposes the broadest execution-policy surface:

- model and reasoning effort;
- service tier, including **Fast mode** when available;
- sandbox mode;
- network access;
- approval policy and reviewer;
- manual compact;
- approvals and structured questionnaires;
- Send, Steer, Queue, Stop, and rename;
- selected-turn and latest-provider-snapshot forks;
- **Goal**; and
- an eligible managed **TUI**.

### Follow-up questions

Nonblocking follow-up questions appear in the **Questions** panel above the
composer, oldest first. The panel opens when questions arrive and when you load
a session with pending questions. Closing it keeps it closed until another
question arrives or you reload. The amber question icons in the composer and
sidebar appear only while questions are pending; the sidebar icon opens that
session's questions. A notice above the conversation also lets you reopen them.
Automatic opening leaves keyboard focus where it is, and new arrivals preserve
the request you are already answering.

In the sidebar's **State** grouping, sessions with pending questions stay in
**Needs attention** until the questions are answered or dismissed. Inline question
rows use amber while any questions remain pending and blue once all have a known
outcome. Their headers show the question icon and a shortened question preview;
expand a row for the full questions. Answered and dismissed outcomes have distinct
labels, while mixed batches are marked resolved. Older questions whose outcome
was not recorded remain neutral. A count appears only when there is more than one
question, both inline and in the composer.

Click a suggested answer to send it immediately, or choose **Other…** to write
a custom reply. Your existing composer draft stays intact. **Dismiss** removes
the current request's remaining questions without sending a message. The panel
advances after each request and disappears when none remain.

These questions do not block the running agent. They remain pending across later
messages and reloads. Archiving a session with unanswered questions asks for
confirmation and preserves them for when you unarchive. Sent answers appear as
**Question answered** entries in the transcript.

### Fast mode

Fast mode is a service-tier choice. Availability comes from the active runtime
and installation policy; Sedes does not infer it from a model name. Change it
with the other desired next-turn settings.

### Goal

Goal stores one bounded objective with a provider-observed status such as
active, paused, blocked, limited, or complete. Use the Goal control to create,
pause, resume, clear, or inspect it. Goal is provider state, not a Sedes Task or
automation.

Paused and blocked goals offer **Resume**. Limited and complete goals continue
to offer **Clear** without a Resume action.

On desktop, the control opens an anchored card above the composer. On narrow or
touch layouts it opens an inset bottom card so the full objective and actions
remain reachable above the soft keyboard. Opening an unset Goal focuses the
objective editor; inspecting a set Goal does not open the keyboard. Dismissing
an unfinished create keeps its text for the next reopen. While a Goal action is
pending, the card stays open so an uncertain result cannot be hidden.

### Managed TUI

The managed terminal is offered only for an eligible external Codex connection
using the unrestricted model catalog and an exact supported runtime, either on
a local endpoint or through a persistent sidecar that provides the managed
terminal. It is intentionally absent for owned-stdio, allowlist, and denylist
targets.

In TUI view, the normal durable composer remains visible:

- **Stage** pastes plain text into the terminal without submitting.
- **Send** pastes plain text and sends exactly one Enter.
- The mobile key bar supplies Esc, Tab, Control+C, and arrow keys.

Each terminal action uses one atomic paste frame and accepts at most 64 KiB
including framing. An oversized draft remains intact and can still be sent in
Chat under the ordinary 256 KiB composer bound. Context excerpts, attachments,
and Task references cannot be represented as terminal keystrokes, so TUI
submission remains disabled until they are removed or you return to Chat. A
resolved selected skill and plain text are supported.

Codex can display completed provider-generated PNG artifacts when the runtime
supplies the reviewed in-band image item.

See the [Codex operator guide](../operator/backends/codex.md),
[Codex execution settings](../internals/codex-thread-execution-settings.md),
and [Managed Codex TUI](../internals/codex-managed-tui.md).

## Claude

Claude threads expose model, effort, and a Claude-specific permission mode.
The installation sets the maximum allowed modes; a thread or Agent can choose
only within that ceiling.

Claude supports:

- Send, Steer, Queue, Stop, and rename;
- native permission prompts and multiple-choice questions;
- eligible native skills;
- usage reporting;
- live background-work status and separate subagent lifecycle rows;
- ordinary staged files;
- native PNG, JPEG, GIF, and WebP composer image input;
- Tasks and context excerpts;
- Sedes CLI agent tools on eligible local, SSH, or outbound threads; and
- exact completed-turn forks while the source is idle.

Claude's Steer is conversation-scoped: it is delivered at Claude's next native
opportunity, so it may join the running turn or start the next one, and it
never interrupts work. Pending input stays visible until Claude confirms it was
incorporated. Choose Queue when you want the input held for a new turn instead.

Claude does not support manual compact, active-source or latest snapshot forks,
managed terminals, plan-mode/reset workflows, or provider-output image
artifacts. The same managed Claude runtime serves local execution and the
persistent sidecar on SSH or outbound hosts.

Claude permission mode is separate from Sedes agent-tool policy. One does not
broaden the other.

See the [Claude operator guide](../operator/backends/claude.md).

## Grok

Grok uses a Sedes-owned local ACP process and exposes model and reasoning-effort
selection at conversation creation. A bound Grok thread does not currently
support changing that tuple, so create a new thread when a different admitted
model or effort is required.

Grok supports:

- Send, Queue, Stop, and rename;
- text, Task, staged-file, and admitted native-image input;
- normalized plan, command, file, web-search, MCP, generic-tool, and
  collaboration activity; and
- completed local **ImageGen** and **ImageEdit** JPEG artifacts.

Grok does not currently expose Steer, forks, manual compact, interactive
permission UI, structured questions, provider-feature controls, skills,
context excerpts, remote execution, or managed terminal workflows. Unsupported
input is rejected rather than silently discarded.

Grok's local image input and generated-image output are separate capabilities.
A model may reject image input even though completed ImageGen/ImageEdit output
can still be displayed.

See the [Grok operator guide](../operator/backends/grok.md).

## Why a control can disappear

A feature may be absent or disabled because of:

- the selected backend or model;
- the target's installed policy;
- local versus SSH topology;
- provider runtime version or connection health;
- draft versus bound thread state;
- idle, active, disconnected, archived, or recovery state; or
- whether the action's exact history boundary is eligible.

Treat the current UI as capability-driven. If something expected is missing,
check [Troubleshooting](troubleshooting.md#an-action-or-setting-is-missing), then
the backend's operator guide.

Previous: [Tasks and automations](tasks-and-automations.md) · Next:
[Settings](settings.md)
