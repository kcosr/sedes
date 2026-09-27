import type {
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  backendConversationEventSchema,
  backendConversationSnapshotSchema,
  type BackendConversationEvent,
} from "../../src/shared/protocol/backend.js";
import { PiHistoryProjector } from "../../src/server/backends/pi/pi-history-projector.js";
import { PiLiveToolProjector } from "../../src/server/backends/pi/pi-live-tool-projector.js";
import {
  PiToolIdentityCatalog,
  type PiToolInfoLike,
} from "../../src/server/backends/pi/pi-tool-identities.js";
import {
  createPiToolIdentityMarker,
  piToolIdentityMarkerType,
} from "../../src/server/backends/pi/pi-tool-identity-marker.js";
import {
  classifyPiViewedImage,
  PI_NON_VISION_IMAGE_NOTE,
} from "../../src/server/backends/pi/pi-viewed-image.js";

const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const readIdentity = {
  registrationId: "pi:builtin:read",
  origin: "pi_builtin",
  canonicalKind: "read",
  displayName: "read",
} as const;
const authentication = {
  conversationId: "viewed-image-conversation",
  installationKey: new Uint8Array(32).fill(0x24),
} as const;

function tool(name: string, source = "builtin", path = `<builtin:${name}>`): PiToolInfoLike {
  return { name, sourceInfo: { source, path } };
}

function live(tools: readonly PiToolInfoLike[] = [tool("read"), tool("bash")]) {
  const projector = new PiLiveToolProjector({
    identities: new PiToolIdentityCatalog(tools),
    now: () => "2026-09-27T12:00:00.000Z",
  });
  projector.beginAssistantStream({
    streamEpoch: "epoch",
    backendTurnId: "turn",
    sourceOrderBase: 1,
  });
  return projector;
}

function update(
  type: "toolcall_start" | "toolcall_delta" | "toolcall_end",
  contentIndex: number,
  id: string,
  name: string,
  args: unknown,
): AgentSessionEvent {
  const block = { type: "toolCall", id, name, arguments: args };
  const content: unknown[] = [];
  content[contentIndex] = block;
  const partial = { role: "assistant", content };
  return {
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type,
      contentIndex,
      partial,
      ...(type === "toolcall_delta" ? { delta: "" } : {}),
      ...(type === "toolcall_end" ? { toolCall: block } : {}),
    },
  } as unknown as AgentSessionEvent;
}

function execution(event: Record<string, unknown>): AgentSessionEvent {
  return event as unknown as AgentSessionEvent;
}

function imageResult(note?: string) {
  return {
    content: [
      { type: "text", text: `Read image file [image/png]${note ? `\n${note}` : ""}` },
      { type: "image", data: pixel, mimeType: "image/png" },
    ],
  };
}

function items(events: readonly BackendConversationEvent[]) {
  for (const event of events) backendConversationEventSchema.parse(event);
  return events.flatMap((event) =>
    event.type === "item_started" ||
    event.type === "item_updated" ||
    event.type === "item_completed"
      ? [{ type: event.type, item: event.item }]
      : [],
  );
}

function readToCompletion(
  projector: PiLiveToolProjector,
  contentIndex: number,
  id: string,
  path: string,
  result: unknown,
  isError = false,
) {
  return items([
    ...projector.consume(update("toolcall_start", contentIndex, id, "read", {})),
    ...projector.consume(update("toolcall_end", contentIndex, id, "read", { path })),
    ...projector.consume(
      execution({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path } }),
    ),
    ...projector.consume(
      execution({ type: "tool_execution_end", toolCallId: id, toolName: "read", result, isError }),
    ),
  ]);
}

describe("Pi viewed-image classification", () => {
  it("classifies only trusted built-in reads of image extensions, case-insensitively", () => {
    for (const path of ["a.png", "b.JPG", "c.jpeg", "d.GIF", "e.webp", "/x/f.Bmp", "@shot.PNG"]) {
      expect(classifyPiViewedImage(readIdentity, { path })).toBeDefined();
    }
    for (const path of ["a.svg", "png", "notes.png.txt", "dir.png/", "a.tiff"]) {
      expect(classifyPiViewedImage(readIdentity, { path })).toBeUndefined();
    }
    expect(classifyPiViewedImage(readIdentity, {})).toBeUndefined();
    expect(
      classifyPiViewedImage(
        { ...readIdentity, registrationId: "pi:live-extension:read", origin: "extension" },
        { path: "a.png" },
      ),
    ).toBeUndefined();
    expect(
      classifyPiViewedImage(
        { registrationId: "pi:builtin:bash", origin: "pi_builtin", canonicalKind: "bash", displayName: "bash" },
        { path: "a.png" },
      ),
    ).toBeUndefined();
    expect(
      classifyPiViewedImage(readIdentity, { path: "/home/agent/private/diagram.png" }),
    ).toEqual({ fileName: { text: "diagram.png" } });
  });
});

describe("Pi live viewed-image projection", () => {
  it("holds a streaming read until its final path decides the item kind", () => {
    const projector = live();
    const streamed = items([
      ...projector.consume(update("toolcall_start", 1, "call", "read", {})),
      ...projector.consume(update("toolcall_delta", 1, "call", "read", { path: "/srv/shots/diagram.t" })),
      ...projector.consume(update("toolcall_delta", 1, "call", "read", { path: "/srv/shots/diagram.png" })),
    ]);
    expect(streamed).toEqual([]);

    const ended = items(
      projector.consume(update("toolcall_end", 1, "call", "read", { path: "/srv/shots/diagram.png" })),
    );
    expect(ended).toEqual([
      {
        type: "item_started",
        item: {
          backendItemId: "live:epoch:1",
          backendTurnId: "turn",
          semanticKind: "viewed_image",
          status: "streaming",
          sourceOrder: 3,
          startedAt: "2026-09-27T12:00:00.000Z",
          fileName: { text: "diagram.png" },
        },
      },
    ]);
    expect(JSON.stringify(ended)).not.toContain("/srv/shots");
    expect(
      items(
        projector.consume(
          execution({ type: "tool_execution_start", toolCallId: "call", toolName: "read", args: { path: "/srv/shots/diagram.png" } }),
        ),
      ),
    ).toEqual([]);
    const completed = items(
      projector.consume(
        execution({ type: "tool_execution_end", toolCallId: "call", toolName: "read", result: imageResult(), isError: false }),
      ),
    );
    expect(completed).toEqual([
      {
        type: "item_completed",
        item: expect.objectContaining({
          backendItemId: "live:epoch:1",
          semanticKind: "viewed_image",
          status: "completed",
          sourceOrder: 3,
          completedAt: "2026-09-27T12:00:00.000Z",
        }),
      },
    ]);
    expect(projector.takeViewedImageResults()).toEqual([
      {
        toolCallId: "call",
        toolName: "read",
        part: { imageIndex: 1, mimeType: "image/png", data: pixel },
        child: {
          backendItemId: "live:epoch:1:image",
          backendTurnId: "turn",
          sourceOrder: 4,
          viewedItemId: "live:epoch:1",
          startedAt: "2026-09-27T12:00:00.000Z",
          completedAt: "2026-09-27T12:00:00.000Z",
          fileName: { text: "diagram.png" },
        },
      },
    ]);
    expect(projector.takeViewedImageResults()).toEqual([]);
  });

  it("publishes a held non-image read as an ordinary file read at arguments end", () => {
    const projector = live();
    const events = items([
      ...projector.consume(update("toolcall_start", 0, "call", "read", {})),
      ...projector.consume(update("toolcall_delta", 0, "call", "read", { path: "README.md" })),
      ...projector.consume(update("toolcall_end", 0, "call", "read", { path: "README.md" })),
    ]);
    expect(events).toEqual([
      {
        type: "item_started",
        item: expect.objectContaining({
          semanticKind: "file_read",
          phase: "arguments_complete",
          sourceOrder: 1,
          path: { text: "README.md" },
        }),
      },
    ]);
  });

  it("treats the executor-backed read of remote and sandboxed sessions as the built-in", () => {
    const projector = new PiLiveToolProjector({
      identities: new PiToolIdentityCatalog(
        [tool("read", "sdk", "<sdk:read>")],
        [],
        [],
        new Set(["read"]),
      ),
      now: () => "2026-09-27T12:00:00.000Z",
    });
    projector.beginAssistantStream({ streamEpoch: "remote", backendTurnId: "turn" });
    const events = readToCompletion(projector, 0, "call", "/srv/remote/plot.webp", imageResult());
    expect(events.map(({ type, item }) => [type, item.semanticKind])).toEqual([
      ["item_started", "viewed_image"],
      ["item_completed", "viewed_image"],
    ]);
    expect(projector.takeViewedImageResults()).toHaveLength(1);
  });

  it("keeps an extension tool named read streaming as a generic tool", () => {
    const projector = live([tool("read", "project", "/workspace/.pi/extensions/read.ts")]);
    const started = items(
      projector.consume(update("toolcall_start", 0, "call", "read", { path: "a.png" })),
    );
    expect(started).toEqual([
      { type: "item_started", item: expect.objectContaining({ semanticKind: "tool", phase: "arguments_streaming" }) },
    ]);
  });

  it("uses the execution-start arguments when no argument events arrived", () => {
    const projector = live();
    const events = items(
      projector.consume(
        execution({ type: "tool_execution_start", toolCallId: "late", toolName: "read", args: { path: "UPPER.BMP" } }),
      ),
    );
    expect(events).toEqual([
      {
        type: "item_started",
        item: expect.objectContaining({ semanticKind: "viewed_image", fileName: { text: "UPPER.BMP" } }),
      },
    ]);
  });

  it("places execution-only calls at their position in the ended message", () => {
    const projector = live();
    projector.consume({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Looking" },
          { type: "toolCall", id: "late", name: "read", arguments: { path: "late.png" } },
          { type: "text", text: "After" },
        ],
      },
    } as unknown as AgentSessionEvent);
    const late = items(
      projector.consume(
        execution({ type: "tool_execution_start", toolCallId: "late", toolName: "read", args: { path: "late.png" } }),
      ),
    );
    const unknown = items(
      projector.consume(
        execution({ type: "tool_execution_start", toolCallId: "other", toolName: "read", args: { path: "other.png" } }),
      ),
    );
    // Counting tool blocks alone would give index 0, the text block's position.
    expect(late[0]?.item).toMatchObject({ backendItemId: "live:epoch:1", sourceOrder: 3 });
    expect(unknown[0]?.item).toMatchObject({ backendItemId: "live:epoch:3", sourceOrder: 7 });
  });

  it("orders several reads in one message two positions apart with reserved children", () => {
    const projector = live();
    const first = readToCompletion(projector, 1, "first", "one.png", imageResult());
    const second = readToCompletion(projector, 3, "second", "two.jpeg", imageResult());
    const bash = items(
      projector.consume(update("toolcall_start", 4, "bash", "bash", { command: "ls" })),
    );
    expect(first.at(-1)?.item).toMatchObject({ semanticKind: "viewed_image", sourceOrder: 3 });
    expect(second.at(-1)?.item).toMatchObject({ semanticKind: "viewed_image", sourceOrder: 7 });
    expect(bash[0]?.item).toMatchObject({ semanticKind: "command", sourceOrder: 9 });
    expect(
      projector.takeViewedImageResults().map(({ child }) => [child.backendItemId, child.sourceOrder]),
    ).toEqual([
      ["live:epoch:1:image", 4],
      ["live:epoch:3:image", 8],
    ]);
  });

  it("fails an errored read with a path-free Sedes message and no child", () => {
    const projector = live();
    const events = readToCompletion(
      projector,
      0,
      "call",
      "/home/private/missing.png",
      { content: [{ type: "text", text: "ENOENT: no such file or directory, access '/home/private/missing.png'" }] },
      true,
    );
    expect(events.at(-1)).toEqual({
      type: "item_completed",
      item: expect.objectContaining({
        semanticKind: "viewed_image",
        status: "failed",
        error: {
          category: "unavailable",
          message: { text: "Pi could not read this image." },
          code: "pi_viewed_image_read_failed",
        },
      }),
    });
    expect(JSON.stringify(events)).not.toContain("/home/private");
    expect(projector.takeViewedImageResults()).toEqual([]);
  });

  it("lists no child for an image part that could never be published", () => {
    const projector = live();
    for (const [index, part] of [
      { type: "image", data: pixel, mimeType: "image/svg+xml" },
      { type: "image", data: "", mimeType: "image/png" },
      { type: "image", mimeType: "image/png" },
    ].entries()) {
      const events = readToCompletion(projector, index, `call-${index}`, `x-${index}.png`, {
        content: [{ type: "text", text: "Read image file" }, part],
      });
      expect(events.at(-1)?.item).toMatchObject({ semanticKind: "viewed_image", status: "completed" });
    }
    expect(projector.takeViewedImageResults()).toEqual([]);
  });

  it("completes a text-only or non-vision read without a child", () => {
    const projector = live();
    const textOnly = readToCompletion(projector, 0, "text", "big.png", {
      content: [{ type: "text", text: "Read image file [image/png]\n[Image omitted: could not be resized below the inline image size limit.]" }],
    });
    const nonVision = readToCompletion(projector, 1, "blind", "seen.png", imageResult(PI_NON_VISION_IMAGE_NOTE));
    expect(textOnly.at(-1)?.item).toMatchObject({ semanticKind: "viewed_image", status: "completed" });
    expect(nonVision.at(-1)?.item).toMatchObject({ semanticKind: "viewed_image", status: "completed" });
    expect(projector.takeViewedImageResults()).toEqual([]);
  });

  it("decides an interrupted streaming read from its partial path", () => {
    const image = live();
    image.consume(update("toolcall_start", 0, "call", "read", {}));
    image.consume(update("toolcall_delta", 0, "call", "read", { path: "shot.png" }));
    expect(items(image.interruptActive())).toEqual([
      {
        type: "item_started",
        item: expect.objectContaining({
          semanticKind: "viewed_image",
          status: "streaming",
          fileName: { text: "shot.png" },
        }),
      },
      {
        type: "item_completed",
        item: expect.objectContaining({
          semanticKind: "viewed_image",
          status: "interrupted",
          error: expect.objectContaining({ category: "interrupted" }),
        }),
      },
    ]);

    const partial = live();
    partial.consume(update("toolcall_start", 0, "call", "read", {}));
    partial.consume(update("toolcall_delta", 0, "call", "read", { path: "shot.p" }));
    expect(items(partial.interruptActive()).map(({ item }) => item.semanticKind)).toEqual([
      "file_read",
      "file_read",
    ]);
  });
});

function message(id: string, value: unknown, timestampSecond = 0): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: `2026-09-27T12:00:${String(timestampSecond).padStart(2, "0")}.000Z`,
    message: value,
  } as SessionEntry;
}

function marker(id: string, assistantEntryId: string, toolCallId: string): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-09-27T12:00:00.000Z",
    customType: piToolIdentityMarkerType,
    data: createPiToolIdentityMarker(
      { assistantEntryId, toolCallId, toolName: "read", identity: readIdentity },
      authentication,
    ),
  } as SessionEntry;
}

function assistant(content: unknown[], stopReason = "toolUse") {
  return { role: "assistant", content, stopReason };
}

function toolResult(toolCallId: string, content: unknown[], isError = false) {
  return { role: "toolResult", toolCallId, toolName: "read", content, isError };
}

function project(branch: SessionEntry[], runState?: "running") {
  const projection = new PiHistoryProjector({
    toolIdentityAuthentication: authentication,
    ...(runState ? { runState } : {}),
  }).project(branch);
  backendConversationSnapshotSchema.parse(projection.snapshot);
  return projection;
}

describe("Pi historical viewed-image projection", () => {
  it("reserves the child position at the call and names the image part at the result", () => {
    const projection = project([
      message("user", { role: "user", content: "look" }),
      message(
        "assistant",
        assistant([
          { type: "text", text: "Looking" },
          { type: "toolCall", id: "call", name: "read", arguments: { path: "/srv/Plot.PNG" } },
          { type: "text", text: "and after" },
        ]),
      ),
      marker("marker", "assistant", "call"),
      message("result", toolResult("call", imageResult().content), 5),
      message("final", assistant([{ type: "text", text: "done" }], "stop")),
    ]);
    const { itemsById } = projection.snapshot;
    expect(itemsById["assistant:1"]).toEqual({
      backendItemId: "assistant:1",
      backendTurnId: "user",
      semanticKind: "viewed_image",
      status: "completed",
      sourceOrder: 2,
      startedAt: "2026-09-27T12:00:00.000Z",
      completedAt: "2026-09-27T12:00:05.000Z",
      fileName: { text: "Plot.PNG" },
    });
    expect(itemsById["assistant:2"]?.sourceOrder).toBe(4);
    expect(itemsById["assistant:1:image"]).toBeUndefined();
    expect(projection.viewedImages).toEqual([
      {
        child: {
          backendItemId: "assistant:1:image",
          backendTurnId: "user",
          sourceOrder: 3,
          viewedItemId: "assistant:1",
          startedAt: "2026-09-27T12:00:05.000Z",
          completedAt: "2026-09-27T12:00:05.000Z",
          fileName: { text: "Plot.PNG" },
        },
        assistantEntryId: "assistant",
        toolCallId: "call",
        toolResultEntryId: "result",
        imageIndex: 1,
      },
    ]);
  });

  it("lists no candidate for an unsupported image part", () => {
    const projection = project([
      message("user", { role: "user", content: "look" }),
      message("assistant", assistant([{ type: "toolCall", id: "call", name: "read", arguments: { path: "a.png" } }])),
      marker("marker", "assistant", "call"),
      message(
        "result",
        toolResult("call", [
          { type: "text", text: "Read image file [image/tiff]" },
          { type: "image", data: pixel, mimeType: "image/tiff" },
        ]),
      ),
    ]);
    expect(projection.snapshot.itemsById["assistant:0"]).toMatchObject({ semanticKind: "viewed_image", status: "completed" });
    expect(projection.viewedImages).toEqual([]);
  });

  it("keeps an unmarked read a generic tool", () => {
    const projection = project([
      message("user", { role: "user", content: "look" }),
      message("assistant", assistant([{ type: "toolCall", id: "call", name: "read", arguments: { path: "a.png" } }])),
      message("result", toolResult("call", imageResult().content)),
    ]);
    expect(projection.snapshot.itemsById["assistant:0"]).toMatchObject({ semanticKind: "tool", status: "completed" });
    expect(projection.viewedImages).toEqual([]);
  });

  it("projects failures, text-only and non-vision results without a child", () => {
    const projection = project([
      message("user", { role: "user", content: "look" }),
      message(
        "assistant",
        assistant([
          { type: "toolCall", id: "missing", name: "read", arguments: { path: "/secret/missing.png" } },
          { type: "toolCall", id: "text", name: "read", arguments: { path: "notes.png" } },
          { type: "toolCall", id: "blind", name: "read", arguments: { path: "seen.webp" } },
        ]),
      ),
      marker("m1", "assistant", "missing"),
      marker("m2", "assistant", "text"),
      marker("m3", "assistant", "blind"),
      message("r1", toolResult("missing", [{ type: "text", text: "ENOENT '/secret/missing.png'" }], true)),
      message("r2", toolResult("text", [{ type: "text", text: "plain text" }])),
      message("r3", toolResult("blind", imageResult(PI_NON_VISION_IMAGE_NOTE).content)),
    ]);
    const { itemsById } = projection.snapshot;
    expect(itemsById["assistant:0"]).toMatchObject({
      semanticKind: "viewed_image",
      status: "failed",
      error: { code: "pi_viewed_image_read_failed" },
    });
    expect(JSON.stringify(projection.snapshot)).not.toContain("/secret");
    expect(itemsById["assistant:1"]).toMatchObject({ semanticKind: "viewed_image", status: "completed" });
    expect(itemsById["assistant:2"]).toMatchObject({ semanticKind: "viewed_image", status: "completed" });
    expect(projection.viewedImages).toEqual([]);
  });

  it("interrupts a result-less read instead of rejecting it, and keeps an active one streaming", () => {
    const branch = [
      message("user", { role: "user", content: "look" }),
      message("assistant", assistant([{ type: "toolCall", id: "call", name: "read", arguments: { path: "a.gif" } }])),
      marker("marker", "assistant", "call"),
    ];
    const settled = project(branch);
    expect(settled.snapshot.itemsById["assistant:0"]).toMatchObject({
      semanticKind: "viewed_image",
      status: "interrupted",
      error: { category: "interrupted", code: "pi_tool_result_missing" },
    });
    expect(settled.diagnostics).toContainEqual({ code: "tool_result_missing", entryId: "assistant" });
    const running = project(branch, "running");
    expect(running.snapshot.itemsById["assistant:0"]).toMatchObject({
      semanticKind: "viewed_image",
      status: "streaming",
    });
    expect(settled.unresolvedViewedImages).toEqual([]);
    expect(running.unresolvedViewedImages).toEqual([
      { viewedItemId: "assistant:0", assistantEntryId: "assistant", toolCallId: "call" },
    ]);
  });
});
