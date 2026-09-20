# Thread template contract

This document records the implemented ownership, persistence, drift, and
creation contract for thread templates. User instructions belong in the
[organization guide](../user/organize-work.md).

## Supported scope

A template is a principal-owned, durable recipe for prefilling New thread. It
stores one project, target, execution-workspace selection, and Saved Agent.
Templates always reference a Saved Agent; Custom thread settings cannot be
saved as a template.

Sedes supports creating, selecting, updating, duplicating, and
deleting templates only within the shared New thread surface. It does not add a
separate management page, template descriptions, template filters, sharing,
automations, or agent-tool operations.

## Creation experience

New thread is one responsive surface regardless of where it is opened. On
desktop it is a narrow, one-column drawer beside the sidebar, or from the left
edge when the sidebar is closed. On mobile the same content appears in a
card-like bottom sheet. Opening it does not open or close the sidebar.

The template picker is a compact dropdown, ordered alphabetically, whose
default is **Configure manually**. A fresh invocation begins unselected except
for valid project or target scope supplied by the invoking context and existing
single-choice defaults. The Agent field begins unselected.

Selecting a usable template prefills the ordinary New thread controls. The
user may then change any field, including choosing **Custom**, before creating
the thread. The thread title is never part of a template. Creating a thread
never mutates the selected template and uses the existing authoritative thread
creation path; there is no create-from-template endpoint.

When fields covered by a selected template change, the surface says
**Modified from _Template name_** and offers explicit actions:

- **Update template** replaces that template after confirmation;
- **Save as new** asks for a new template name;
- **Reset changes** restores the selected template.

An unchanged selection offers **Edit template** and **Save as new**. Manual
configuration offers **Save as template**. Template mutation actions require a
Saved Agent as the final selection and are unavailable for Custom.

## Persistence and authority

A template stores:

- ID and name;
- project ID and captured project label;
- target ID and captured target label;
- direct or isolated execution-workspace selection;
- Saved Agent ID and captured Agent name;
- revision and creation/update timestamps; and
- server-derived tenant and principal ownership.

Captured labels are display-only repair context. IDs are authority. The server
derives labels and validates the project, target, execution-workspace choice,
and Saved Agent at create and update time. Thread creation independently
revalidates the prefilled final selections. Updates and deletes use optimistic
revision checks. Duplicate names are allowed.

The template stores neither an Agent settings snapshot nor an Agent revision.
It follows the referenced Agent's current definition until the user creates a
thread. The resulting thread receives the resolved settings and tool policy as
independent thread state.

## Drift, repair, and deletion

Deleting a project, target, or Saved Agent never cascade-deletes templates.
Deleting a template never changes an Agent or thread. A template whose
reference is missing or incompatible remains listed with one actionable
**Needs attention** state. It cannot create a thread until the user selects a
valid replacement and updates it, but it can always be deleted.

The current contract intentionally has no detailed readiness matrix and does not
resolve every list row eagerly. It validates a template when selected and at
each authoritative mutation. It never guesses a replacement by name or falls
back to another target or Agent.

Deleting an Agent uses the existing Agent deletion flow with a general warning
that saved uses may need attention. It does not require templates to be edited
first.

## Thread Agent origin

A thread created with a Saved Agent records only immutable origin metadata:
the Agent ID, the captured Agent name, and the Agent revision used during
creation. Custom threads and threads copied from another thread's settings have
no Agent origin. Templates are not recorded on threads.

Agent origin is provenance, not current configuration identity. Later Agent
edits, Agent deletion, and thread setting changes do not rewrite or clear it.
The server reports whether the scoped Agent still exists. The browser displays
the origin only in **Session stats**, marking it deleted only when that live
scoped lookup fails. It does not add badges or filters to the sidebar, header,
or transcript.

## Intentionally unsupported machinery

The implementation does not include template provenance on threads, a
template-specific spawn endpoint, mutation receipts, detailed per-template
readiness states, Agent-based thread filters, or a reverse lookup from thread
settings to Agents. Those concepts would imply a stronger ongoing relationship
than editable prefill provides.

## Verification

Tests must prove principal isolation; strict template shapes; revision-checked
CRUD; server-derived labels; failure on missing or incompatible references;
non-cascading deletion and repair; current Agent resolution at thread creation;
transactional capture of exact Agent origin; no origin for Custom or copied
threads; and desktop, hidden-sidebar, landing-page, and mobile use of the same
responsive creation flow.
