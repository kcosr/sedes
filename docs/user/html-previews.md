# HTML previews

An agent can publish a mock-up, chart, or other interactive HTML example in a
conversation. Each preview has a title, revision number, and expand control.
Its JavaScript can update the displayed content locally; it has no connection
to the agent, your credentials, or other Sedes tools.

Enable the **Pages** tools in the thread's Agent tools settings. Ask the agent
to publish its result, for example: “Show a mobile mock-up of the settings
screen,” or “Make an interactive example of this chat bubble.” The tools use
the thread's existing native or CLI presentation.

## Edit and compare revisions

The agent can write an HTML file using its ordinary file tools, then publish
that file. Later it can edit the file and publish it again using the same page
ID and expected revision. Each changed publication creates an immutable
revision and appends another preview to chat. Earlier previews keep their
original revision. Republishing identical HTML, title, and dimensions leaves
the revision unchanged.

After context compaction, the agent can list the thread's pages and read a
current or earlier revision. File publications return their original source
path; inline publications return their saved HTML so the agent can revise
and republish it without relying on its previous chat context.

Use the previous and next controls in a preview's header to browse that page's
revisions. **Original** returns that occurrence to the revision published
there; browsing does not change the saved conversation. Open **Pages** in the
thread header to find published documents even when their original chat turn
is outside the loaded history or has been compacted by the provider.
The library orders documents by their first publication, newest first; later
revisions keep their document's position. Earlier chat previews remain available
there even when a conversation reaches its display limits.
If loaded history reaches its item or size limit, additional previews remain
available through **Pages** without displacing conversation messages.

Saved revisions preserve document content, images, and requested dimensions.
They do not save transient interaction state such as selected filters or text
typed into a mock form. Reopening or switching revisions starts that page
again. Pages belong to their original thread and are removed when that thread
is deleted.

## Layout and zoom

Dimensions are optional. Without them, a preview uses the available width and
fits its height to the content. It can therefore adapt when viewed on another
device.

When a particular layout matters, ask for an explicit viewport. A mobile
mock-up might use 390 by 844 CSS pixels; a component example can specify only
its width and let its height fit the content. Explicit dimensions are saved
with each revision and preserved across devices. A large desktop mock-up
viewed on a phone keeps its desktop layout and is scaled to fit.

Expand the preview to inspect it with zoom controls. Zoom changes the displayed
scale, not the document's saved viewport. Very tall content and large canvases
remain bounded by the viewer's size limits.

## Files and embedded images

The publishing tool accepts exactly one source: an absolute HTML file path or
an inline HTML string. A file can contain up to 1 MiB of UTF-8 HTML; inline
input is limited to 65,536 characters and 256 KiB. Styles and JavaScript belong
inside the HTML. Separate script files, stylesheets, nested frames, and network
requests are unsupported.

File publishing reads from the thread's execution environment. On a remote
workspace, this requires its configured Files access. Images referenced in
the HTML or CSS can use paths relative to the HTML file, absolute paths, or
file URIs. The importer captures permitted PNG, JPEG, GIF, and WebP images into
the saved revision. Later edits or deletion of source files do not alter an
earlier preview. A publication may capture up to 64 distinct image references, with a
16 MiB limit on the captured document.

Inline HTML has no source directory and cannot read filesystem images. Embed
its images as base64 data URLs. Neither source form downloads images or other
assets from HTTP or HTTPS addresses.

## Optional agent screenshot preview

The agent can call the separate preview tool before publishing. It returns a
screenshot, bounded console messages, and measured dimensions, allowing the
agent to inspect and revise its work. It does not save a page or create a
revision.

This tool requires the optional browser installation on the Sedes server.
Publishing and viewing still work without it. See
[Optional HTML preview browser](../operator/page-previews.md) for setup and
platform requirements.
