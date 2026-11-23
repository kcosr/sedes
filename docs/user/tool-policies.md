# Tool policy sets

Tool policy sets give new threads a reusable exact list of Sedes tools and
project/environment access rules. They are owned by your Sedes account and
work across compatible backends and execution hosts in the same installation.
They do not configure provider-native tools, external MCP servers, or provider
sandbox and permission settings.

## Create a policy

Open **Settings → Tool policies**, create a named policy, select its tools,
and choose its two access rules:

- **Allow other environments** permits operations on other execution hosts,
  subject to the project rule.
- **Allow other projects** permits operations on other projects, subject to
  the environment rule.

With other-project access off, opening a new location must name the current
project; omitting the project would otherwise create a different project.

Both switches start off. The two rules are independent:

| Other environments | Other projects | Resource scope |
| --- | --- | --- |
| Off | Off | Current project on the current environment |
| On | Off | Current project across environments |
| Off | On | All projects on the current environment |
| On | On | All projects across environments |

The switches affect only enabled Sedes tools. Ordinary ownership, runtime
availability, and provider permissions still apply. Project Tasks and Workpads
are shared project records, not separate documents per host. With other
environments off, a project needs an active location on the current environment
before its shared records are accessible. Global Tasks,
global Workpads, Saved Agents, and client devices remain shared account
resources. A client result hides an out-of-scope default-thread reference.
HTML Pages, image display, and worktree operations keep their narrower
source-thread or source-workspace restrictions.

## Choose defaults at each level

The selection order is **Account → Environment → Backend → Agent → Thread**.
Set the account default on the Tool policies page. Environment and backend
settings provide independent defaults, Agents store a reusable selection,
and **New thread** provides the final selection.

Each level can **Inherit**, **Disable tools**, or choose a named policy set.
The nearest explicit selection supplies the complete policy. Tools and access
switches never merge with earlier levels. When no level selects a policy,
Sedes tools stay disabled. Changing tool defaults does not restart a backend.

For example, select Everyday at account level and Reviewer on a review Agent.
Threads created with that Agent receive Reviewer only; they do not also
receive Everyday's tools. A thread-level policy can replace Reviewer, or
Disable tools can turn Sedes tools off for that new thread.

A template stores the thread-level selection alongside its project, target,
execution-workspace choice, and Saved Agent. Inherit is resolved when creating
the thread. Templates do not introduce another inheritance level.

A deleted policy leaves its saved references needing attention. Select a
replacement or choose Inherit/Disable tools before creating an affected thread.
An explicit later selection can replace an earlier missing reference.

## Existing threads keep a snapshot

Thread creation copies the effective exact tool list, access switches, and
backend-supported presentation into independent thread state. An unmodified
named policy retains its applied set ID, name, and revision; customized tools
or access switches are shown as **Custom**. Presentation is separate from the
set, so presentation edits retain the named policy.
Editing a policy, Agent, template, or default does not update existing threads.
User forks and **New with same settings** copy the source thread's current
policy. Agent and Tool-client forks may copy it only when it does not exceed
the caller's own tools and resource scope. Agent and Tool-client operations that
create, edit, enable, or run a clone automation apply the same restriction to
the automation's source thread.

Use **Thread actions → Agent tools** to edit an existing thread's tools and
access switches. Choose a saved **Policy set** and **Apply** to replace the
draft's tools and access settings, keeping its presentation. You can customize
the draft before **Save** updates the thread. This remains an independent
snapshot; later edits or deletion of the set do not update the thread. The
dialog shows its current named policy or **Custom**, including after reopening.
Manual tool or access-switch edits clear the set association. Selecting
**Custom** keeps the current settings and clears the association when saved.
You can enable broader access temporarily and turn it off again; Sedes does
not automatically restore it or let the agent enable it.
CLI access edits apply to subsequent requests. Native-tool and presentation
changes require an idle thread. Work already admitted may finish.

## Scoped discovery and direct requests

Lists and searches return only the part of the requested collection within
the thread's resource scope. They do not ask to search another project or host
and do not reveal hidden result counts. A direct request outside scope fails
with an explanation; it does not create an approval popup or retry against a
different resource. Broader access requires your explicit policy edit.

An agent cannot create or configure another Agent/thread with a broader tool
policy than its own and then use it to bypass this boundary. Existing
independently configured destination threads keep their own policy.

## Delegate management to an agent

The **Execution** tool group lets a thread agent inspect and manage environments,
backends, the default connection, runtime lifecycle and tool-policy sets. These
operations start disabled and are selected individually. Reading or renaming a
resource does not enable its configuration or removal. Configure/create grants
include executable paths, variables, credential-reference approval and privilege
settings. Detailed environment/backend reads show stored literal variable values;
enable those reads only for an agent that should see that configuration.

`tool_policy.*` can create/edit policy sets, select account/environment/backend
defaults, and preview the effective selection and supported presentation for a
target. Creating environments, changing account defaults and administering
account-wide policy sets require **Allow other environments**. A valid target
with no saved selection reads as **Inherit**.

Policy administration deliberately permits defining broader tools or access
for future threads. It does not change the calling thread's already-applied
policy. The agent still cannot assign more tools or broader scope than its own
when creating/configuring threads, Saved Agents or templates, including through
an inherited policy. Enable administrative tools as an explicit delegation,
separately from ordinary thread creation and Saved Agent authoring.

The **Threads** group also includes `thread.tool_settings.get/update` and
`thread_template.list/get/update`. An agent can change an admitted other thread's
applied tools and supported presentation, or an existing template's policy and
presentation while preserving its other settings. It cannot change its own
thread's tool settings. Existing Saved Agent tools remain the way to edit an
Agent. Native/presentation changes still require an idle target and runtime
retirement; no new presentation defaults are added above Agent/Thread scope.

Updates use revision checks. A thread tool-settings update has no replay receipt:
after a lost reply, read the current settings before trying another update.
Policy-set/default/template writes use the same readback approach. These new
management operations are available to thread agents, not principal Tool clients.
See [agent-managed configuration](../operator/configuration.md#agent-managed-configuration)
for partial configuration updates and lifecycle recovery.

## Presentation across backends

A set stores tools and resource scope, not a provider transport. New threads
normally use their backend's supported presentation default. A Saved Agent or
New thread can request an explicit supported presentation independently.
In **New thread → Tool presentation**, choose **Inherit** or one of the target's
supported modes. A template remembers that choice; if a different target does
not support it, choose Inherit or another available mode before creating.
Every backend uses the shared policy and scope checks. Supported Native and
CLI modes and their runtime prerequisites vary by backend. See
[provider features](provider-features.md#let-an-agent-use-sedes-tools).

## Upgrading existing policies

The old cross-boundary approval choices are replaced by explicit resource
scope. Previously unrestricted policies retain both switches on; policies
limited to one environment retain access to other projects on that environment.
Old thread-only policies are disabled for review because project scope would
be broader than their original restriction. Existing explicit Agent policies
become named policy sets, retaining their supported presentation separately.
Server and clients must be upgraded together for the new protocol.
Historical creation labels become current associations only when the upgrade
can prove the thread still has that unmodified policy; other threads show Custom.
