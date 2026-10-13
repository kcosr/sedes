# Show image files in chat

An agent can show an existing image directly in the conversation with
`image.show`. Enable **Show image** under **Images** in the thread's Agent
tools settings, then ask the agent to show a screenshot, chart, or other image.

The tool accepts an absolute path and an optional title:

```json
{"path":"/workspace/output/chart.png","title":"Results"}
```

Sedes reads the file from the thread's configured execution environment using
its Files access. A remote path is read on that remote host. The file must be
inside an admitted Files root. Supported formats are PNG, JPEG, GIF, and WebP,
subject to the existing 16 MiB image and image-dimension limits.

The image appears inline with the existing expand, zoom, pan, and image-save
controls. Sedes retains the captured bytes with the source thread, so later
changes or deletion of the original file do not change the image in chat.
Another call captures the current file as another image. Replaying the same
request returns the original capture. Images are not added to the Pages
library and do not have page revisions.

Showing an image requires the originating active conversation turn. The tool
returns small image metadata to the agent, not image bytes. An agent that
also needs to inspect the image can use its own image-reading tools.

The same operation is available through supported Native tools and Sedes CLI
presentations. In CLI progressive mode, invoke it with:

```sh
sedes tool invoke image.show --input-json '{"path":"/workspace/output/chart.png","title":"Results"}' --json
```

As with other agent tools, availability depends on the thread's backend,
selected presentation, saved grants, and execution environment. An image
shown in one thread remains owned by that thread; a fork does not copy its
application-owned image associations.
