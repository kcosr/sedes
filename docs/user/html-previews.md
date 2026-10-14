# HTML previews

An agent can publish a mock-up, chart, or other interactive HTML example in a
conversation. Previews load automatically when they are in or near view on
web, desktop, and Android. Their JavaScript can update the displayed content
locally. A page can also prepare a response for you to send through Sedes's
own **Send** control; it has no access to your credentials or other Sedes tools.

Inline content appears without a permanent header or dimensions footer. Use
the maximize button at the top right to open the larger viewer. Its header
contains the title, refresh, and previous/next arrows around a `1/3` revision
indicator when the page has multiple revisions. Single-revision pages omit
the revision controls.
Refresh reloads the selected saved revision and resets its local interaction
state.

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

Maximize the preview to see its header, then use the previous and next arrows
around the version indicator to browse that page's revisions. Browsing does not change
the saved conversation or the revision originally published there. While
browsing another revision, select the revision indicator to return to the revision
published at that position in chat. Closing the viewer restores that original
revision in the inline card. Open **Pages** in the thread header to find
published documents even when their original chat turn is outside the loaded
history or has been compacted by the provider.
The library orders documents by their first publication, newest first; later
revisions keep their document's position. Earlier chat previews remain available
there even when a conversation reaches its display limits.
If loaded history reaches its item or size limit, additional previews remain
available through **Pages** without displacing conversation messages.
The library lists page titles without revision labels. Its viewer stays the
same size when switching pages, scrolls long content within that space, and
accepts interaction immediately. It shares the fullscreen revision and zoom
controls, while each chat occurrence keeps its own interaction toggle.

Saved revisions preserve document content, images, and requested dimensions.
They do not save transient interaction state such as selected filters or text
typed into a mock form. Reopening or switching revisions starts that page
again. Pages belong to their original thread and are removed when that thread
is deleted.

## Send a Page response

A published page of any design can optionally send responses: a dashboard,
diagram, calculator, custom widget, or questionnaire. It can collect choices,
multiple selections, free text, or changes made through controls and canvas.
When the page supports responses, use Sedes's **Send** control to submit its text to the
page's owning thread. Sedes captures the text once at that click. If the agent
is busy, the response enters the thread's normal queue; it never interrupts
the current turn with Steer. The same flow works with Pi, Codex, Claude, Grok,
and OpenCode.

Chat shows a compact **Page response** user card with the saved page title and
revision. Expand it to read the exact submitted plain text, including its
original whitespace. The card does not render that text as HTML or Markdown.
Queued responses and submitted history retain this frozen text across reloads
and server restarts, even if the page later changes. A fork retains responses
in its inherited history, but cannot send through a page owned by the original
thread.

Answers that you have not sent exist only in the loaded page. Reloading,
closing, or releasing that frame can lose them; Sedes does not save form state,
and the agent cannot inspect it through a tool. A page cannot send by itself.
If its response is blank, invalid, or too large, Sedes shows an error instead
of sending it.

## Interact and recover

Inline HTML previews initially let gestures scroll the conversation on both desktop
and mobile. Tap or click the preview, or use its finger icon, to enable input.
Dragging, scrolling, stopping a scroll, and long presses do not enable interaction. The activating
tap only changes modes; tap again to use the page's controls. Use the checkmark
to return to conversation scrolling. Expanded previews and the Pages library
accept input immediately and have no interaction toggle. The page still loads
and runs while inline input is inactive.

A failed render or an attempt interrupted before cleanup does not restart
automatically. Use **Retry** to try that revision again. This protects against
repeated failures after a restart. If the browser cannot store recovery state,
a preview also requires an explicit retry. Closing a responsive preview
normally does not require a retry. Recovery state is local to this browser and
scoped to the connection, signed-in identity, thread, page, and revision. The
managed local desktop connection keeps its scope across restarts; another
device keeps its own state.

## Layout and zoom

Dimensions are optional. Without them, a preview uses the available width and
fits its height to the content. It can therefore adapt when viewed on another
device.

When a particular layout matters, ask for an explicit viewport. A mobile
mock-up might use 390 by 844 CSS pixels; a component example can specify only
its width and let its height fit the content. Explicit dimensions are saved
with each revision and preserved across devices. A large desktop mock-up
viewed on a phone keeps its desktop layout and is scaled to fit.

Use the maximize icon to open the expanded viewer. HTML pages, images, and
Mermaid diagrams share a floating zoom bar at the bottom: minus, percentage,
plus, **Fit**, and **1:1**. Zoom changes the displayed scale, not the document's
saved viewport. Very tall content and large canvases remain bounded by the
viewer's size limits. In fullscreen, pages without an explicit height fit the
viewer's width and scroll vertically; pages with an explicit height fit the
complete canvas.

Images and Mermaid diagrams also support pinch zoom and pan inline. At normal
size, a one-finger gesture scrolls the conversation; when zoomed, dragging pans
the media. Inline images and diagrams have no floating zoom toolbar. Use the
explicit expand control for the larger viewer and its zoom controls. Unused
space around expanded content matches the chat background.

Recently visible HTML previews stay loaded for up to 30 seconds after scrolling
away. At most four page frames remain active; visible previews take priority
over recently viewed ones. Hiding the app or leaving the view releases them.

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

## Author a response producer

The published page receives `window.sedes.onSubmit(producer)`. Register a
synchronous function that returns one nonblank string of at most 65,536 UTF-8
bytes. Read whichever controls or JavaScript state define the answer; there
is no fixed form schema. For example:

```html
<label><input type="radio" name="pace" value="steady" checked> Steady</label>
<label><input type="radio" name="pace" value="fast"> Fast</label>
<label>Topics
  <select id="topics" multiple>
    <option value="layout">Layout</option>
    <option value="content">Content</option>
  </select>
</label>
<label>Notes <textarea id="notes"></textarea></label>
<script>
  window.sedes.onSubmit(() => {
    const pace = document.querySelector('input[name="pace"]:checked').value;
    const topics = [...document.querySelector('#topics').selectedOptions]
      .map(option => option.value).join(', ');
    const notes = document.querySelector('#notes').value;
    return `Pace: ${pace}\nTopics: ${topics || 'None'}\nNotes: ${notes}`;
  });
</script>
```

Canvas widgets can serialize their own selection state into the same string.
Include all useful answers in that one value; there is no separately authored
summary. Keep the producer synchronous: promises, non-string values, thrown
errors, blank strings, and oversized output fail validation. Registering again
replaces the producer for a later capture. Registration does not send anything;
only the user's Sedes **Send** action requests a capture. Sedes supplies the
saved title and revision separately, so the producer need not repeat them.

## Optional agent screenshot preview

The agent can call the separate preview tool before publishing. It returns a
screenshot, bounded console messages, and measured dimensions, allowing the
agent to inspect and revise its work. It does not save a page or create a
revision. The registration API is available, so page code can test its producer
directly, but preview never invokes it for submission or sends a response.

This tool requires the optional browser installation on the Sedes server.
Publishing and viewing still work without it. See
[Optional HTML preview browser](../operator/page-previews.md) for setup and
platform requirements.
