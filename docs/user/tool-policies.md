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
backend-supported presentation into independent thread state. The recorded
policy name, revision, and source level describe that creation snapshot.
Editing a policy, Agent, template, or default does not update existing threads.
User forks and **New with same settings** copy the source thread's current
policy. Agent and Tool-client forks may copy it only when it does not exceed
the caller's own tools and resource scope.

Use **Thread actions → Agent tools** to edit an existing thread's tools and
access switches. You can enable broader access temporarily and turn it off
again; Sedes does not automatically restore it or let the agent enable it.
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

## Presentation across backends

A set stores tools and resource scope, not a provider transport. New threads
normally use their backend's supported presentation default. A Saved Agent or
New thread can request an explicit supported presentation independently.
In **New thread → Tool presentation**, choose **Inherit** or one of the target's
supported modes. A template remembers that choice; if a different target does
not support it, choose Inherit or another available mode before creating.
Pi, Codex, Claude, Grok, and OpenCode use the shared policy and scope checks;
their supported Native/CLI modes and runtime prerequisites still differ. See
[provider features](provider-features.md#let-an-agent-use-sedes-tools).

## Upgrading existing policies

The old cross-boundary approval choices are replaced by explicit resource
scope. Previously unrestricted policies retain both switches on; policies
limited to one environment retain access to other projects on that environment.
Old thread-only policies are disabled for review because project scope would
be broader than their original restriction. Existing explicit Agent policies
become named policy sets, retaining their supported presentation separately.
Server and clients must be upgraded together for the new protocol.
