// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationItemSchema, type ConversationItem } from "../../../shared/index.js";
import {
  ConversationItemView,
  conversationItemRenderers,
} from "./ConversationItemView";
import { MarkdownContent } from "./MarkdownContent";
import { WorkspaceFileLinkProvider } from "../../workspace-files/workspace-file-link-routing.js";

const androidImageActions = vi.hoisted(() => ({
  available: false,
  present: vi.fn(),
}));

vi.mock("../../app/android-output-image-actions.js", () => ({
  supportsAndroidOutputImageActions: () => androidImageActions.available,
  presentAndroidOutputImageActions: androidImageActions.present,
}));

vi.mock("../diff/pierre-file-change-diff.js", () => ({
  PierreFileChangeDiff: ({
    source,
    path,
    destinationPath,
    itemId,
    itemRevision,
    itemStatus,
    wrap,
  }: {
    readonly source:
      | { readonly kind: "unified_patch"; readonly text: string }
      | { readonly kind: "whole_file_write"; readonly content: string }
      | {
          readonly kind: "replacement_preview";
          readonly oldContent: string;
          readonly newContent: string;
        };
    readonly path: string;
    readonly destinationPath?: string;
    readonly itemId: string;
    readonly itemRevision: number;
    readonly itemStatus: string;
    readonly wrap?: boolean;
  }) => (
    <div
      data-destination={destinationPath ?? ""}
      data-path={path}
      data-item-id={itemId}
      data-item-revision={itemRevision}
      data-item-status={itemStatus}
      data-source-kind={source.kind}
      data-testid="pierre-file-change-diff"
      data-wrap={wrap === false ? "scroll" : "wrap"}
    >
      {source.kind === "whole_file_write"
        ? source.content
        : source.kind === "unified_patch"
          ? source.text
          : `${source.oldContent}\n${source.newContent}`}
    </div>
  ),
}));

beforeEach(() => {
  androidImageActions.available = false;
  androidImageActions.present.mockReset();
  androidImageActions.present.mockResolvedValue("cancelled");
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const common = {
  id: "item-1",
  turnId: "turn-1",
  status: "completed" as const,
  revision: 1,
};

function installIntersectionObserver() {
  let callback: IntersectionObserverCallback | undefined;
  let target: Element | undefined;
  let instance: IntersectionObserver | undefined;
  const observe = vi.fn((element: Element) => {
    target = element;
  });
  const disconnect = vi.fn();

  class TestIntersectionObserver {
    readonly root = null;
    readonly rootMargin = "256px 0px";
    readonly thresholds = [0];

    constructor(observerCallback: IntersectionObserverCallback) {
      callback = observerCallback;
      instance = this as unknown as IntersectionObserver;
    }

    observe(element: Element): void {
      observe(element);
    }

    unobserve(): void {}

    disconnect(): void {
      disconnect();
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
  return {
    disconnect,
    observe,
    intersect() {
      if (!callback || !target || !instance) {
        throw new Error("intersection_observer_not_ready");
      }
      callback(
        [
          {
            boundingClientRect: target.getBoundingClientRect(),
            intersectionRatio: 1,
            intersectionRect: target.getBoundingClientRect(),
            isIntersecting: true,
            rootBounds: null,
            target,
            time: 0,
          },
        ],
        instance,
      );
    },
  };
}

describe("normalized conversation renderers", () => {
  it("registers every normalized semantic kind", () => {
    expect(Object.keys(conversationItemRenderers).sort()).toEqual(
      [
        "activity_summary",
        "assistant_message",
        "collaboration",
        "command",
        "compaction",
        "file_change",
        "file_read",
        "image",
        "mcp",
        "notice",
        "plan",
        "reasoning",
        "review_marker",
        "tool",
        "user_message",
        "viewed_image",
        "web_search",
      ].sort(),
    );
  });

  it("expands only compactions that include a genuine summary", () => {
    const { rerender } = render(
      <ConversationItemView
        item={{
          ...common,
          kind: "compaction",
          summary: { text: "Important retained context" },
        }}
      />,
    );

    expect(
      screen.getByText("Conversation compacted", { selector: "summary" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Important retained context")).toBeInTheDocument();

    rerender(
      <ConversationItemView item={{ ...common, kind: "compaction" }} />,
    );

    expect(
      screen.queryByText("Conversation compacted", { selector: "summary" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Conversation compacted", { selector: "div" }),
    ).toBeInTheDocument();
    expect(document.querySelector("details")).toBeNull();
  });

  it("renders ordered reasoning summaries before raw reasoning detail", () => {
    render(
      <ConversationItemView
        item={
          {
            ...common,
            kind: "reasoning",
            summaryParts: [
              { text: "Preparing the checks" },
              { text: "Running the focused suite" },
            ],
            markdown: { text: "Private raw reasoning detail" },
          } as ConversationItem
        }
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Thought for|Reasoning/ }),
    );
    const body = document.querySelector(".reason-body");
    expect(body).not.toBeNull();
    const text = body!.textContent ?? "";
    expect(text).toContain("Preparing the checks");
    expect(text).toContain("Running the focused suite");
    expect(text).toContain("Private raw reasoning detail");
    expect(text.indexOf("Preparing the checks")).toBeLessThan(
      text.indexOf("Running the focused suite"),
    );
    expect(text.indexOf("Running the focused suite")).toBeLessThan(
      text.indexOf("Private raw reasoning detail"),
    );
  });

  it("loads and opens a durable image artifact from the full preview surface", async () => {
    const intersection = installIntersectionObserver();
    const content = new Blob(
      [
        new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49,
          0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1,
        ]),
      ],
      { type: "image/png" },
    );
    const loadOutputArtifactContent = vi.fn(async () => content);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:generated-image"),
      revokeObjectURL,
    });
    const { unmount } = render(
      <ConversationItemView
        context={{ assistantLabel: "Assistant", loadOutputArtifactContent }}
        item={{
          ...common,
          kind: "image",
          image: {
            representation: "artifact",
            artifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            mimeType: "image/png",
            alt: { text: "Generated chart" },
            fileName: { text: "chart.png" },
            byteSize: content.size,
            sha256: "a".repeat(64),
          },
        }}
      />,
    );

    expect(loadOutputArtifactContent).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Load image preview" }),
    ).toBeVisible();
    act(() => intersection.intersect());
    expect(screen.getByRole("status")).toHaveTextContent("Loading image");
    expect(loadOutputArtifactContent).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.any(AbortSignal),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "Generated chart" }),
      ).toHaveAttribute("src", "blob:generated-image"),
    );
    const image = screen.getByRole("img", { name: "Generated chart" });
    const expand = screen.getByRole("button", {
      name: "Expand image: Generated chart",
    });
    expect(image).toBeVisible();
    expect(expand).toContainElement(image);
    expect(screen.queryByLabelText("Zoom level")).toBeNull();

    fireEvent.click(image);
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("100%");
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(expand).toHaveFocus());
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:generated-image");
  });

  it("opens Android image actions on long-press without opening the preview", async () => {
    androidImageActions.available = true;
    const intersection = installIntersectionObserver();
    const content = new Blob(
      [
        new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49,
          0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1,
        ]),
      ],
      { type: "image/png" },
    );
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:android-image"),
      revokeObjectURL: vi.fn(),
    });
    const artifact = {
      representation: "artifact" as const,
      artifactId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      mimeType: "image/png" as const,
      byteSize: content.size,
      sha256: "e".repeat(64),
      alt: { text: "Long press image" },
    };
    render(
      <ConversationItemView
        context={{
          assistantLabel: "Assistant",
          loadOutputArtifactContent: async () => content,
        }}
        item={{ ...common, kind: "image", image: artifact }}
      />,
    );
    act(() => intersection.intersect());
    const image = await screen.findByRole("img", { name: "Long press image" });
    const preview = screen.getByRole("button", {
      name: "Expand image: Long press image",
    });
    expect(preview).toHaveAttribute("data-android-image-actions", "available");

    expect(fireEvent.contextMenu(image)).toBe(false);
    expect(androidImageActions.present).toHaveBeenCalledWith({
      artifact,
      content,
    });
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => undefined);
    androidImageActions.present.mockClear();
    vi.useFakeTimers();
    const pointerDown = new Event("pointerdown", { bubbles: true });
    Object.defineProperties(pointerDown, {
      isPrimary: { value: true },
      pointerType: { value: "touch" },
      clientX: { value: 20 },
      clientY: { value: 30 },
    });
    fireEvent(preview, pointerDown);
    act(() => vi.advanceTimersByTime(550));
    expect(androidImageActions.present).toHaveBeenCalledOnce();
    expect(fireEvent.click(preview)).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    vi.useRealTimers();
  });

  it("leaves the ordinary browser image context menu untouched", async () => {
    const intersection = installIntersectionObserver();
    const content = new Blob(
      [
        new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49,
          0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1,
        ]),
      ],
      { type: "image/png" },
    );
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:web-image"),
      revokeObjectURL: vi.fn(),
    });
    render(
      <ConversationItemView
        context={{
          assistantLabel: "Assistant",
          loadOutputArtifactContent: async () => content,
        }}
        item={{
          ...common,
          kind: "image",
          image: {
            representation: "artifact",
            artifactId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            mimeType: "image/png",
            byteSize: content.size,
            sha256: "f".repeat(64),
          },
        }}
      />,
    );
    act(() => intersection.intersect());
    await screen.findByRole("button", { name: "Expand image" });
    const image = document.querySelector(".image-figure img");
    expect(image).not.toBeNull();
    expect(fireEvent.contextMenu(image!)).toBe(true);
    expect(androidImageActions.present).not.toHaveBeenCalled();
  });

  it("keeps offscreen artifacts deferred until intersection or explicit loading", async () => {
    const intersection = installIntersectionObserver();
    const content = new Blob(
      [
        new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49,
          0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1,
        ]),
      ],
      { type: "image/png" },
    );
    const loadOutputArtifactContent = vi.fn(async () => content);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:deferred-image"),
      revokeObjectURL: vi.fn(),
    });
    const item = {
      ...common,
      kind: "image" as const,
      image: {
        representation: "artifact" as const,
        artifactId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        mimeType: "image/png" as const,
        byteSize: content.size,
        sha256: "c".repeat(64),
      },
    };
    const context = { assistantLabel: "Assistant", loadOutputArtifactContent };
    const first = render(
      <ConversationItemView context={context} item={item} />,
    );

    expect(intersection.observe).toHaveBeenCalledTimes(1);
    expect(loadOutputArtifactContent).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    act(() => intersection.intersect());
    await waitFor(() =>
      expect(loadOutputArtifactContent).toHaveBeenCalledOnce(),
    );
    await screen.findByRole("button", { name: "Expand image" });
    first.unmount();

    const explicit = installIntersectionObserver();
    loadOutputArtifactContent.mockClear();
    render(<ConversationItemView context={context} item={item} />);
    fireEvent.click(screen.getByRole("button", { name: "Load image preview" }));
    await waitFor(() =>
      expect(loadOutputArtifactContent).toHaveBeenCalledOnce(),
    );
    expect(explicit.disconnect).toHaveBeenCalled();
  });

  it("disconnects an offscreen artifact observer without fetching on unmount", () => {
    const intersection = installIntersectionObserver();
    const loadOutputArtifactContent = vi.fn();
    const { unmount } = render(
      <ConversationItemView
        context={{ assistantLabel: "Assistant", loadOutputArtifactContent }}
        item={{
          ...common,
          kind: "image",
          image: {
            representation: "artifact",
            artifactId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            mimeType: "image/png",
            byteSize: 24,
            sha256: "d".repeat(64),
          },
        }}
      />,
    );

    expect(intersection.observe).toHaveBeenCalledOnce();
    unmount();
    expect(intersection.disconnect).toHaveBeenCalledOnce();
    expect(loadOutputArtifactContent).not.toHaveBeenCalled();
  });

  it("shows durable image retrieval and normalized omission failures", async () => {
    const { rerender } = render(
      <ConversationItemView
        context={{
          assistantLabel: "Assistant",
          loadOutputArtifactContent: async () => {
            throw new Error("unavailable");
          },
        }}
        item={{
          ...common,
          kind: "image",
          image: {
            representation: "artifact",
            artifactId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            mimeType: "image/png",
            byteSize: 24,
            sha256: "b".repeat(64),
          },
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("Image unavailable · load failed")).toBeVisible(),
    );

    rerender(
      <ConversationItemView
        item={{
          ...common,
          kind: "image",
          image: {
            representation: "omitted",
            mimeType: "image/png",
            alt: { text: "Unavailable chart" },
            reason: "byte_limit",
          },
        }}
      />,
    );
    expect(screen.getByText("Image unavailable · byte limit")).toBeVisible();
    expect(screen.getByText("Unavailable chart")).toBeVisible();
  });

  it("renders collaboration summaries as one quiet marker row", () => {
    const { container, rerender } = render(
      <ConversationItemView
        item={{
          ...common,
          kind: "collaboration",
          action: "spawn",
          agentLabel: { text: "ignored-when-summary-is-present" },
          summary: { text: "Started `/root/explorer`" },
        }}
      />,
    );

    const activity = screen.getByLabelText("Collaboration activity");
    expect(activity).toHaveClass("collab-row", "marker-label");
    expect(activity).toHaveTextContent("Started `/root/explorer`");
    expect(activity).not.toHaveTextContent("Subagent · spawn");
    expect(activity).not.toHaveTextContent("ignored-when-summary-is-present");
    expect(container.querySelector('[data-testid="bounded-text"]')).toBeNull();
    expect(activity.querySelector("pre")).toBeNull();
    expect(activity.querySelectorAll(".collab-summary")).toHaveLength(1);

    rerender(
      <ConversationItemView
        item={{
          ...common,
          revision: 2,
          kind: "collaboration",
          action: "message",
          agentLabel: { text: "explorer" },
        }}
      />,
    );
    expect(activity).toHaveTextContent("explorer · message");

    rerender(
      <ConversationItemView
        item={{
          ...common,
          revision: 3,
          kind: "collaboration",
          action: "status",
        }}
      />,
    );
    expect(activity).toHaveTextContent("Subagent · status");

    rerender(
      <ConversationItemView
        item={{
          ...common,
          revision: 4,
          kind: "collaboration",
          action: "message",
          agentLabel: { text: "explorer" },
          summary: { text: "   " },
        }}
      />,
    );
    expect(activity).toHaveTextContent("explorer · message");
  });

  it("progressively renders safe Markdown and suppresses an empty transient row", () => {
    const { container, rerender } = render(
      <ConversationItemView
        item={{
          ...common,
          kind: "assistant_message",
          status: "streaming",
          markdown: { text: "**partial" },
        }}
      />,
    );
    expect(screen.getByText("**partial")).toBeInTheDocument();
    expect(container.querySelector("strong")).not.toBeInTheDocument();

    rerender(
      <ConversationItemView
        item={{
          ...common,
          kind: "assistant_message",
          status: "streaming",
          markdown: {
            text: "# Live heading\n\n**Settled bold**\nactive *tail",
          },
        }}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Live heading" }),
    ).toBeInTheDocument();
    expect(container.querySelector("strong")).toHaveTextContent("Settled bold");
    expect(container).toHaveTextContent("active *tail");

    rerender(
      <ConversationItemView
        item={{
          ...common,
          kind: "assistant_message",
          status: "streaming",
          markdown: {
            text: "```ts\nconst answer = 42;",
          },
        }}
      />,
    );
    expect(container.querySelector("pre code")).toHaveTextContent("const answer = 42;");
    expect(
      screen.getByRole("button", { name: "Copy code" }),
    ).toBeInTheDocument();

    rerender(
      <ConversationItemView
        item={{
          ...common,
          kind: "assistant_message",
          status: "streaming",
          markdown: { text: "" },
        }}
      />,
    );
    expect(
      container.querySelector('[data-testid="message-row"]'),
    ).not.toBeInTheDocument();
  });

  it("keeps completed assistant selection disabled until Markdown handoff", () => {
    let nowMs = 1_000;
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const streamingItem = {
      ...common,
      kind: "assistant_message" as const,
      status: "streaming" as const,
      markdown: { text: "streaming answer" },
    };
    const { container, rerender } = render(
      <ConversationItemView item={streamingItem} />,
    );
    const selectionSurface = () =>
      container.querySelector<HTMLElement>(".message-body");

    expect(selectionSurface()).toHaveAttribute(
      "data-selection-enabled",
      "false",
    );
    rerender(
      <ConversationItemView
        item={{ ...streamingItem, status: "completed", revision: 2 }}
      />,
    );
    expect(selectionSurface()).toHaveAttribute(
      "data-selection-enabled",
      "false",
    );

    act(() => {
      nowMs += 450;
      vi.advanceTimersByTime(450);
    });
    expect(selectionSurface()).toHaveAttribute(
      "data-selection-enabled",
      "true",
    );

    clock.mockRestore();
    vi.useRealTimers();
  });

  it("renders normalized skill metadata as a badge beside plain user text", () => {
    const { container } = render(
      <ConversationItemView
        item={{
          ...common,
          kind: "user_message",
          content: [
            { kind: "skill", name: { text: "keel-local" } },
            { kind: "text", text: { text: "Here's the test" } },
          ],
        }}
      />,
    );

    expect(
      screen.getByText("keel-local").closest(".message-skill-badge"),
    ).not.toBeNull();
    expect(screen.getByText("Here's the test")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("$keel-local");
    expect(container).not.toHaveTextContent("[Skill:");
  });

  it("presents authenticated callback input as a collapsed agent-result disclosure", () => {
    const { container } = render(
      <ConversationItemView
        item={{
          ...common,
          kind: "user_message",
          deliveryOperationId: "callback-delivery-1",
          origin: {
            kind: "agent_result",
            callbackId: "callback-1",
            sourceThreadId: "worker-thread",
            sourceThreadLabel: { text: "Research agent" },
          },
          content: [
            {
              kind: "text",
              text: {
                text: "Agent result from Research agent (completed):\n\n# Investigation complete with **three findings**",
              },
            },
          ],
        }}
      />,
    );

    const disclosure = container.querySelector(
      'details[data-message-origin="agent_result"]',
    );
    expect(disclosure).not.toBeNull();
    expect(disclosure).not.toHaveAttribute("open");
    const summary = disclosure!.querySelector("summary")!;
    expect(summary).toHaveTextContent("Agent result");
    expect(summary).toHaveTextContent("Research agent");
    expect(summary).toHaveTextContent("Investigation complete with three findings");
    expect(summary).not.toHaveTextContent("#");
    expect(summary).not.toHaveTextContent("**");
    expect(screen.queryByText("You", { selector: "header" })).toBeNull();
  });

  it("presents a thread.send input as a collapsed agent-message disclosure", () => {
    const { container } = render(
      <ConversationItemView
        item={{
          ...common,
          kind: "user_message",
          deliveryOperationId: "agent-message-delivery-1",
          origin: {
            kind: "agent_message",
            sourceThreadId: "controller-thread",
            sourceThreadLabel: { text: "Main implementation" },
          },
          content: [
            { kind: "text", text: { text: "Review the lifecycle changes" } },
          ],
        }}
      />,
    );

    const summary = container.querySelector(
      'details[data-message-origin="agent_message"] > summary',
    );
    expect(summary).toHaveTextContent("Agent message");
    expect(summary).toHaveTextContent("Main implementation");
    expect(summary).toHaveTextContent("Review the lifecycle changes");
  });

  it("restores a compact question response from persisted origin metadata", () => {
    const wireItem = {
      ...common,
      kind: "user_message",
      deliveryOperationId: "question-delivery-1",
      origin: {
        kind: "question_response",
        requestId: "question-request-1",
        sourceItemId: "question-source-item",
        answers: [
          { questionIndex: 0, question: "Which region?", answer: "eu-west-1" },
          { questionIndex: 1, question: "Notes?", answer: "<script>alert('test')</script>\nKeep **literal**" },
        ],
      },
      content: [{ kind: "text", text: { text: "Ordinary provider message content" } }],
    };
    const restored = () => conversationItemSchema.parse(JSON.parse(JSON.stringify(wireItem)));
    const first = render(<ConversationItemView item={restored()} />);
    let disclosure = first.container.querySelector('details[data-message-origin="question_response"]')!;
    expect(disclosure).not.toHaveAttribute("open");
    expect(disclosure.querySelector("summary")).toHaveTextContent("Questions answered");
    expect(disclosure).toHaveAttribute("data-question-status", "answered");
    expect(disclosure.querySelector(".question-disclosure-icon")).toHaveAttribute("aria-hidden", "true");
    expect(disclosure.querySelector(".question-disclosure-count")).toHaveTextContent("2");
    expect(disclosure.querySelector(".question-disclosure-preview")).toHaveTextContent("Which region?");
    expect(disclosure.querySelector("summary")).not.toHaveTextContent("eu-west-1");
    fireEvent.click(disclosure.querySelector("summary")!);
    expect(disclosure).toHaveAttribute("open");
    expect(within(disclosure as HTMLElement).getByText("Which region?", { selector: "dt" })).toBeVisible();
    expect(within(disclosure as HTMLElement).getByText("eu-west-1", { selector: "dd" })).toBeVisible();
    expect(disclosure.querySelectorAll("dd")[1]?.textContent).toBe("<script>alert('test')</script>\nKeep **literal**");
    expect(disclosure.querySelector("script")).toBeNull();
    expect(first.container).not.toHaveTextContent("Ordinary provider message content");
    first.unmount();
    const reloaded = render(<ConversationItemView item={restored()} />);
    disclosure = reloaded.container.querySelector('details[data-message-origin="question_response"]')!;
    expect(disclosure).not.toHaveAttribute("open");
    expect(disclosure.querySelector("summary")).toHaveTextContent("Questions answered");
    expect(disclosure.querySelectorAll("dt")).toHaveLength(2);
  });

  it("uses a singular question response title without a count", () => {
    const { container } = render(<ConversationItemView item={conversationItemSchema.parse({
      ...common,
      kind: "user_message",
      deliveryOperationId: "single-question-delivery",
      origin: {
        kind: "question_response",
        requestId: "single-question",
        sourceItemId: "single-source",
        answers: [{ questionIndex: 0, question: "Which region?", answer: "eu-west-1" }],
      },
      content: [{ kind: "text", text: { text: "Provider response" } }],
    })} />);
    const summary = container.querySelector('details[data-message-origin="question_response"] summary')!;
    expect(summary).toHaveTextContent("Question answered");
    expect(summary.querySelector(".question-disclosure-count")).toBeNull();
    expect(summary.querySelector(".question-disclosure-preview")).toHaveTextContent("Which region?");
  });

  it("does not infer question response styling from ordinary message text", () => {
    const { container } = render(
      <ConversationItemView item={{
        ...common,
        kind: "user_message",
        content: [{ kind: "text", text: { text: "User responded to a question:\nQuestion: Region?\nAnswer: eu-west-1" } }],
      }} />,
    );
    expect(container.querySelector('[data-message-origin="question_response"]')).toBeNull();
    expect(screen.getByText("You", { selector: "header" })).toBeInTheDocument();
    expect(container).toHaveTextContent("User responded to a question:");
  });

  it("renders durable context excerpts as cards without changing user text", () => {
    render(
      <ConversationItemView
        item={{
          ...common,
          kind: "user_message",
          content: [
            {
              kind: "context_excerpt",
              excerpt: {
                id: "0ff5247c-813a-48c5-a23c-880fb7aeb1f8",
                excerpt: "const answer = 42;",
                note: "Explain this value",
                source: {
                  kind: "workspace_file",
                  rootId: "primary",
                  path: "src/answer.ts",
                  revision: "revision-1",
                },
                locator: {
                  kind: "line_range",
                  startLine: 7,
                  endLine: 7,
                },
              },
            },
            { kind: "text", text: { text: "What should change?" } },
          ],
        }}
      />,
    );

    expect(screen.getByText("answer.ts")).toBeInTheDocument();
    expect(screen.queryByText("lines 7–7")).not.toBeInTheDocument();
    expect(screen.getByText("line 7")).toBeInTheDocument();
    expect(screen.getByText("Explain this value")).toBeInTheDocument();
    expect(screen.getByText("What should change?")).toBeInTheDocument();
    expect(screen.queryByText(/context_excerpt/u)).not.toBeInTheDocument();
  });

  it("renders and opens a normalized attachment through the scoped content route", async () => {
    const content = new Blob(
      [
        new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49,
          0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1,
        ]),
      ],
      { type: "image/png" },
    );
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:transcript-attachment"),
      revokeObjectURL: vi.fn(),
    });
    const { container } = render(
      <ConversationItemView
        context={{
          assistantLabel: "Assistant",
          loadAttachmentContent: async () => content,
        }}
        item={{
          ...common,
          kind: "user_message",
          content: [
            {
              kind: "attachment",
              attachment: {
                id: "attachment-image-1",
                fileName: "diagram.png",
                kind: "image",
                mediaType: "image/png",
                byteSize: content.size,
              },
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("diagram.png")).toBeInTheDocument();
    await waitFor(() =>
      expect(container.querySelector("img")).toHaveAttribute(
        "src",
        "blob:transcript-attachment",
      ),
    );
    expect(container).not.toHaveTextContent("preview omitted");
    fireEvent.click(
      screen.getByRole("button", { name: "Preview image: diagram.png" }),
    );
    expect(
      screen.getByLabelText("Image preview for diagram.png"),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("presents command details without dumping a raw object", () => {
    const item: ConversationItem = {
      ...common,
      kind: "command",
      phase: "completed",
      command: { text: "npm test" },
      cwd: { text: "/workspace" },
      output: {
        text: "42 tests passed",
        truncation: {
          truncated: true,
          originalBytes: 200,
          retainedBytes: 100,
          reason: "byte_limit",
        },
      },
      exitCode: 0,
      durationMs: 1250,
    };
    render(<ConversationItemView item={item} />);

    fireEvent.click(screen.getByRole("button", { name: /Command/ }));
    expect(screen.getAllByText("npm test").length).toBeGreaterThan(0);
    expect(screen.getByText(/Working directory/)).toHaveTextContent(
      "/workspace",
    );
    expect(screen.getByText("42 tests passed")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("100 bytes omitted");
    expect(screen.queryByText(/\"command\":/)).not.toBeInTheDocument();
  });

  it.each([
    ["cat > notes.md <<'EOF'\nprivate document body\nEOF", "cat > notes.md <<'EOF'…"],
    ["x".repeat(700), `${"x".repeat(511)}…`],
    ["😀".repeat(513), `${"😀".repeat(511)}…`],
    ["printf ok\r\nsecond line", "printf ok…"],
    ["npm test", "npm test"],
  ])("keeps a bounded first-line command header and complete expanded details (%#)", (command, preview) => {
    const item: ConversationItem = {
      ...common,
      kind: "command",
      phase: "completed",
      command: { text: command },
    };
    const { container } = render(<ConversationItemView item={item} />);
    const target = container.querySelector(".op-target-scroll")!;
    expect(target.textContent).toBe(preview);
    expect(Array.from(target.textContent!).length).toBeLessThanOrEqual(512);
    const toggle = screen.getByRole("button", { name: /Command/ });
    fireEvent.click(toggle);
    expect(container.querySelector('[aria-label="Command details"] pre')?.textContent).toBe(command);
  });

  it.each([
    ["bash -lc 'printf hello'", "printf hello"],
    ["/bin/bash -lc 'printf hello'", "printf hello"],
    ["/usr/local/bin/bash -lc 'printf hello'", "printf hello"],
    [
      String.raw`bash -lc 'printf "\n" "$HOME"'`,
      String.raw`printf "\n" "$HOME"`,
    ],
    [
      'bash -lc "printf \\"hello\\" \\$HOME \\`date\\` \\\\ \\q"',
      'printf "hello" $HOME `date` \\ \\q',
    ],
    ['bash -lc "printf hel\\\nlo"', "printf hello"],
    ["bash -lc 'printf hello' extra", "bash -lc 'printf hello' extra"],
    [
      "bash -lc 'printf hello'; printf next",
      "bash -lc 'printf hello'; printf next",
    ],
    ["bash -lc 'printf hello", "bash -lc 'printf hello"],
  ])(
    "unwraps only complete bash wrappers in the preview and expanded details (%#)",
    (command, expected) => {
      const { container } = render(
        <ConversationItemView
          item={{
            ...common,
            kind: "command",
            phase: "completed",
            command: { text: command },
          }}
        />,
      );
      expect(container.querySelector(".op-target-scroll")?.textContent).toBe(
        expected,
      );
      fireEvent.click(screen.getByRole("button", { name: /Command/ }));
      expect(
        container.querySelector('[aria-label="Command details"] pre')
          ?.textContent,
      ).toBe(expected);
    },
  );

  it("preserves a truncated bash wrapper in both command presentations", () => {
    const command = "bash -lc 'printf hello'";
    const { container } = render(
      <ConversationItemView
        item={{
          ...common,
          kind: "command",
          phase: "completed",
          command: {
            text: command,
            truncation: {
              truncated: true,
              originalBytes: 100,
              retainedBytes: command.length,
              reason: "byte_limit",
            },
          },
        }}
      />,
    );
    expect(container.querySelector(".op-target-scroll")?.textContent).toBe(
      `${command}…`,
    );
    fireEvent.click(screen.getByRole("button", { name: /Command/ }));
    expect(
      container.querySelector('[aria-label="Command details"] pre')
        ?.textContent,
    ).toBe(command);
    expect(screen.getByRole("note")).toHaveTextContent("bytes omitted");
  });

  it("scrolls command previews with arrow keys without expanding details", () => {
    const item: ConversationItem = {
      ...common,
      kind: "command",
      phase: "preflight_or_executing",
      command: { text: "x".repeat(600) },
    };
    const { container } = render(<ConversationItemView item={item} />);
    const target = container.querySelector(".op-target-scroll")!;
    Object.defineProperties(target, {
      scrollWidth: { value: 1000 },
      clientWidth: { value: 200 },
    });
    const toggle = screen.getByRole("button", { name: /Command/ });
    fireEvent.keyDown(toggle, { key: "ArrowRight" });
    expect(target.scrollLeft).toBe(120);
    fireEvent.keyDown(toggle, { key: "ArrowLeft" });
    expect(target.scrollLeft).toBe(0);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("renders generic tool arguments as a bounded semantic tree", () => {
    const item: ConversationItem = {
      ...common,
      kind: "tool",
      phase: "result_streaming",
      toolName: { text: "extension_lookup" },
      title: { text: "Lookup record" },
      category: "other",
      arguments: {
        kind: "object",
        entries: [
          { key: { text: "record" }, value: { text: "abc" } },
          {
            key: { text: "token" },
            value: { kind: "redacted", reason: "sensitive_key" },
          },
        ],
      },
      result: {
        content: [{ kind: "text", value: { text: "Still working" } }],
        isError: false,
      },
    };
    render(<ConversationItemView item={item} />);

    const toggle = screen.getByRole("button", { name: /Lookup record/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("record")).toBeInTheDocument();
    expect(screen.getByText("abc")).toBeInTheDocument();
    expect(screen.getByText("Sensitive value redacted")).toBeInTheDocument();
    expect(screen.getByText("Still working")).toBeInTheDocument();
  });

  it.each(["file_read", "file_change"] as const)("allows scrolling long %s filenames without opening details", (kind) => {
    const path = `src/${"long-directory/".repeat(30)}filename.ts`;
    const item: ConversationItem = kind === "file_read"
      ? { ...common, kind, phase: "completed", path: { text: path } }
      : { ...common, kind, phase: "completed", path: { text: path }, operation: "write", effect: "applied" };
    const { container } = render(<ConversationItemView item={item} />);
    const target = container.querySelector(".op-target-scroll")!;
    expect(target).toHaveTextContent(path);
    Object.defineProperties(target, {
      scrollWidth: { value: 1000 },
      clientWidth: { value: 100 },
    });
    const toggle = screen.getByRole("button", { name: kind === "file_read" ? /Read/ : /Write/ });
    fireEvent.keyDown(toggle, { key: "ArrowRight" });
    expect(target.scrollLeft).toBe(120);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("renders a streaming whole-file write lazily and preserves expansion across updates", async () => {
    const first: ConversationItem = {
      ...common,
      kind: "file_change",
      status: "streaming",
      phase: "arguments_streaming",
      operation: "write",
      effect: "proposed",
      path: { text: "notes.md" },
      contentPreview: { text: "# Notes\nfirst line" },
    };
    const { rerender } = render(<ConversationItemView item={first} />);
    const toggle = screen.getByRole("button", { name: /Write/ });

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      document.querySelector('[data-testid="bounded-text"] pre'),
    ).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const pierreDiff = await screen.findByTestId("pierre-file-change-diff");
    expect(pierreDiff).toHaveAttribute("data-source-kind", "whole_file_write");
    expect(pierreDiff).toHaveTextContent("# Notes first line");
    expect(toggle.querySelector(".diff-counts")).toHaveTextContent("+2");
    expect(toggle.querySelector(".diff-counts")).toHaveTextContent("−0");

    rerender(
      <ConversationItemView
        item={{
          ...first,
          revision: 2,
          contentPreview: {
            text: "# Notes\nfirst line\nsecond line",
          },
        }}
      />,
    );
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => {
      expect(screen.getByTestId("pierre-file-change-diff")).toHaveTextContent(
        "# Notes first line second line",
      );
    });
    expect(toggle.querySelector(".diff-counts")).toHaveTextContent("+3");
  });

  it("treats normalized Codex Add content as whole-file text and preserves truncation", async () => {
    render(
      <ConversationItemView
        item={{
          ...common,
          kind: "file_change",
          phase: "completed",
          operation: "write",
          effect: "applied",
          path: { text: "src/generated.ts" },
          diff: {
            text: {
              text: "@@ literal content\n+still content…",
              truncation: {
                truncated: true,
                originalBytes: 200,
                retainedBytes: 40,
                reason: "byte_limit",
              },
            },
          },
          additions: 12,
          deletions: 0,
        }}
      />,
    );

    const toggle = screen.getByRole("button", { name: /Write/ });
    expect(toggle.querySelector(".diff-counts")).toHaveTextContent("+12");
    expect(toggle.querySelector(".diff-counts")).toHaveTextContent("−0");
    fireEvent.click(toggle);
    const pierreDiff = await screen.findByTestId("pierre-file-change-diff");
    expect(pierreDiff).toHaveAttribute("data-source-kind", "whole_file_write");
    expect(pierreDiff).toHaveTextContent("@@ literal content +still content…");
    expect(screen.getByRole("note")).toHaveTextContent("160 bytes omitted");
  });

  it("routes an explicit empty write to the lazy whole-file surface", async () => {
    render(
      <ConversationItemView
        item={{
          ...common,
          kind: "file_change",
          phase: "completed",
          operation: "write",
          effect: "applied",
          path: { text: "empty.txt" },
          contentPreview: { text: "" },
        }}
      />,
    );
    const toggle = screen.getByRole("button", { name: /Write/ });
    expect(toggle.querySelector(".diff-counts")).toBeNull();
    fireEvent.click(toggle);
    expect(
      await screen.findByTestId("pierre-file-change-diff"),
    ).toHaveAttribute("data-source-kind", "whole_file_write");
  });

  it("fails closed to the bounded preview for an unsafe whole-file path", () => {
    render(
      <ConversationItemView
        item={{
          ...common,
          kind: "file_change",
          phase: "completed",
          operation: "write",
          effect: "applied",
          path: { text: "unsafe\npath.ts" },
          contentPreview: { text: "+literal content" },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Write/ }));
    expect(screen.getByTestId("bounded-text")).toHaveTextContent(
      "+literal content",
    );
    expect(screen.queryByTestId("pierre-file-change-diff")).toBeNull();
  });

  it("keeps file navigation on a content-preview-only file change", () => {
    const openReference = vi.fn(() => true);
    render(
      <WorkspaceFileLinkProvider handler={{ openReference }}>
        <ConversationItemView
          item={{
            ...common,
            kind: "file_change",
            phase: "completed",
            operation: "edit",
            effect: "applied",
            path: { text: "src/preview-only.ts" },
            range: { startLine: 44, endLine: 45 },
            contentPreview: { text: "replacement preview" },
          }}
        />
      </WorkspaceFileLinkProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    expect(screen.getByTestId("bounded-text")).toHaveTextContent(
      "replacement preview",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open src/preview-only.ts in Files at line 44",
      }),
    );
    expect(openReference).toHaveBeenCalledExactlyOnceWith({
      reference: {
        kind: "workspace_relative",
        path: "src/preview-only.ts",
      },
      target: { kind: "source_line", lineNumber: 44 },
      presentation: "split",
    });
  });

  it("renders a replacement preview in Pierre and opens Files at the top", async () => {
    const openReference = vi.fn(() => true);
    render(
      <WorkspaceFileLinkProvider handler={{ openReference }}>
        <ConversationItemView
          item={{
            ...common,
            kind: "file_change",
            phase: "completed",
            operation: "edit",
            effect: "applied",
            path: { text: "src/replaced.ts" },
            replacement: {
              before: { text: "const oldValue = 1;" },
              after: { text: "const newValue = 2;\n" },
            },
          }}
        />
      </WorkspaceFileLinkProvider>,
    );

    const toggle = screen.getByRole("button", { name: /Edit/ });
    expect(toggle.querySelector(".diff-counts")).toBeNull();
    fireEvent.click(toggle);
    const diff = await screen.findByTestId("pierre-file-change-diff");
    expect(diff).toHaveAttribute("data-source-kind", "replacement_preview");
    expect(diff).toHaveTextContent("const oldValue = 1;");
    expect(diff).toHaveTextContent("const newValue = 2;");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open src/replaced.ts in Files at line 1",
      }),
    );
    expect(openReference).toHaveBeenCalledExactlyOnceWith({
      reference: { kind: "workspace_relative", path: "src/replaced.ts" },
      target: { kind: "source_line", lineNumber: 1 },
      presentation: "split",
    });
  });

  it("omits zero-only file counts and renders one-sided positive counts", () => {
    const item: ConversationItem = {
      ...common,
      kind: "file_change",
      phase: "completed",
      operation: "delete",
      effect: "applied",
      path: { text: "empty.txt" },
      additions: 0,
      deletions: 0,
    };
    const { rerender } = render(<ConversationItemView item={item} />);
    expect(document.querySelector(".diff-counts")).toBeNull();

    rerender(
      <ConversationItemView
        item={{ ...item, revision: 2, additions: undefined, deletions: 2 }}
      />,
    );
    const counts = document.querySelector(".diff-counts");
    expect(counts).toHaveTextContent("+0");
    expect(counts).toHaveTextContent("−2");

    rerender(
      <ConversationItemView
        item={{
          ...item,
          revision: 3,
          additions: undefined,
          deletions: undefined,
        }}
      />,
    );
    expect(document.querySelector(".diff-counts")).toBeNull();
  });

  it("presents file reads and file changes with semantic paths, ranges, and effects", async () => {
    const { rerender } = render(
      <ConversationItemView
        item={{
          ...common,
          kind: "file_read",
          phase: "completed",
          path: { text: "src/reader.ts" },
          range: { startLine: 12, endLine: 18 },
          contentPreview: { text: "export function read() {}" },
        }}
      />,
    );

    const readToggle = screen.getByRole("button", { name: /Read/ });
    expect(readToggle).toHaveTextContent("src/reader.ts");
    expect(readToggle).not.toHaveTextContent("lines 12–18");
    fireEvent.click(readToggle);
    expect(screen.getByText(/lines 12–18/)).toBeInTheDocument();
    expect(screen.getByText("export function read() {}")).toBeInTheDocument();

    rerender(
      <ConversationItemView
        item={{
          ...common,
          kind: "file_change",
          phase: "completed",
          operation: "move",
          effect: "applied",
          path: { text: "src/old.ts" },
          destinationPath: { text: "src/new.ts" },
          diff: { text: { text: "@@ -1 +1 @@\n-old\n+new" } },
          additions: 1,
          deletions: 1,
        }}
      />,
    );

    const moveToggle = screen.getByRole("button", { name: /Move/ });
    fireEvent.click(moveToggle);
    expect(moveToggle).toHaveAttribute("aria-expanded", "false");
    expect(moveToggle).toHaveTextContent("src/old.ts");
    expect(moveToggle).toHaveTextContent("+1");
    expect(moveToggle).toHaveTextContent("−1");
    const headerStats = moveToggle.querySelector(".diff-counts");
    expect(headerStats).toHaveTextContent("+1");
    expect(headerStats).toHaveTextContent("−1");
    fireEvent.click(moveToggle);
    expect(screen.getByText(/src\/new\.ts/)).toBeInTheDocument();
    expect(document.querySelector(".file-stats")).toBeNull();
    const pierreDiff = await screen.findByTestId("pierre-file-change-diff");
    expect(pierreDiff).toHaveTextContent("@@ -1 +1 @@");
    expect(pierreDiff).toHaveTextContent("-old");
    expect(pierreDiff).toHaveTextContent("+new");
    expect(pierreDiff).toHaveAttribute("data-path", "src/old.ts");
    expect(pierreDiff).toHaveAttribute("data-destination", "src/new.ts");
    expect(pierreDiff).toHaveAttribute("data-item-id", "item-1");
    expect(pierreDiff).toHaveAttribute("data-item-revision", "1");
    expect(pierreDiff).toHaveAttribute("data-item-status", "completed");
  });

  it("opens file operations in Files at the relevant source line", async () => {
    const openReference = vi.fn(() => true);
    const view = render(
      <WorkspaceFileLinkProvider handler={{ openReference }}>
        <ConversationItemView
          item={{
            ...common,
            kind: "file_read",
            phase: "completed",
            path: { text: "src/reader.ts" },
            range: { startLine: 12, endLine: 18 },
            contentPreview: { text: "export function read() {}" },
          }}
        />
      </WorkspaceFileLinkProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Read/ }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open src/reader.ts in Files at line 12",
      }),
    );
    expect(openReference).toHaveBeenLastCalledWith({
      reference: { kind: "workspace_relative", path: "src/reader.ts" },
      target: { kind: "source_line", lineNumber: 12 },
      presentation: "split",
    });

    view.rerender(
      <WorkspaceFileLinkProvider handler={{ openReference }}>
        <ConversationItemView
          item={{
            ...common,
            revision: 2,
            kind: "file_change",
            phase: "completed",
            operation: "move",
            effect: "applied",
            path: { text: "src/old.ts" },
            destinationPath: { text: "src/new.ts" },
            diff: { text: { text: "@@ -5 +18,2 @@\n-old\n+new" } },
          }}
        />
      </WorkspaceFileLinkProvider>,
    );
    const moveToggle = screen.getByRole("button", { name: /Move/ });
    if (moveToggle.getAttribute("aria-expanded") === "false") {
      fireEvent.click(moveToggle);
    }
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open src/new.ts in Files at line 18",
      }),
      { shiftKey: true },
    );
    expect(openReference).toHaveBeenLastCalledWith({
      reference: { kind: "workspace_relative", path: "src/new.ts" },
      target: { kind: "source_line", lineNumber: 18 },
      presentation: "single",
    });
  });

  it("persists line wrap and synchronizes every diff block", async () => {
    const item = (id: string, path: string): ConversationItem => ({
      ...common,
      id,
      kind: "file_change",
      phase: "completed",
      operation: "edit",
      effect: "applied",
      path: { text: path },
      diff: { text: { text: "@@ -1 +1 @@\n-old\n+new" } },
    });
    render(
      <>
        <ConversationItemView item={item("item-1", "src/one.ts")} />
        <ConversationItemView item={item("item-2", "src/two.ts")} />
      </>,
    );
    for (const operationToggle of screen.getAllByRole("button", {
      name: /Edit/,
    })) {
      fireEvent.click(operationToggle);
    }
    const wrapToggles = screen.getAllByRole("button", {
      name: /Line wrap on/,
    });
    expect(wrapToggles).toHaveLength(2);
    for (const toggle of wrapToggles) {
      expect(toggle).toHaveAttribute("aria-pressed", "true");
    }
    for (const pierreDiff of await screen.findAllByTestId(
      "pierre-file-change-diff",
    )) {
      expect(pierreDiff).toHaveAttribute("data-wrap", "wrap");
    }

    fireEvent.click(wrapToggles[0]!);
    expect(localStorage.getItem("sedes-diff-line-wrap")).toBe("false");
    await waitFor(() => {
      const scrollToggles = screen.getAllByRole("button", {
        name: /Horizontal scroll/,
      });
      expect(scrollToggles).toHaveLength(2);
      for (const toggle of scrollToggles) {
        expect(toggle).toHaveAttribute("aria-pressed", "false");
      }
      for (const pierreDiff of screen.getAllByTestId(
        "pierre-file-change-diff",
      )) {
        expect(pierreDiff).toHaveAttribute("data-wrap", "scroll");
      }
    });

    cleanup();
    render(<ConversationItemView item={item("item-3", "src/three.ts")} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    expect(
      screen.getByRole("button", { name: /Horizontal scroll/ }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      await screen.findByTestId("pierre-file-change-diff"),
    ).toHaveAttribute("data-wrap", "scroll");
  });

  it("falls back to raw patch text when the diff is not a Pierre candidate", () => {
    render(
      <ConversationItemView
        item={{
          ...common,
          kind: "file_change",
          phase: "completed",
          operation: "edit",
          effect: "applied",
          path: { text: "src/old.ts" },
          diff: { text: { text: "garbage\n?not a hunk" } },
        }}
      />,
    );
    const toggle = screen.getByRole("button", { name: /Edit/ });
    fireEvent.click(toggle);
    const raw = document.querySelector('[data-testid="bounded-text"].diff pre');
    expect(raw).toHaveTextContent("garbage");
    expect(document.querySelector('[data-testid="diff-block"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="pierre-file-change-diff"]'),
    ).toBeNull();
  });

  it("renders MCP arguments and result details without provider JSON", () => {
    render(
      <ConversationItemView
        item={{
          ...common,
          kind: "mcp",
          phase: "completed",
          server: { text: "documents" },
          toolName: { text: "find_record" },
          arguments: {
            kind: "object",
            entries: [
              { key: { text: "query" }, value: { text: "normalization" } },
            ],
          },
          result: {
            content: [{ kind: "text", value: { text: "One record found" } }],
            details: {
              kind: "object",
              entries: [
                { key: { text: "recordId" }, value: { text: "record-7" } },
              ],
            },
            isError: false,
          },
          durationMs: 1_250,
        }}
      />,
    );

    const toggle = screen.getByRole("button", { name: /find_record/ });
    expect(toggle).toHaveTextContent("documents");
    expect(toggle).not.toHaveTextContent("1.3 s");
    fireEvent.click(toggle);
    expect(screen.getByText("normalization")).toBeInTheDocument();
    expect(screen.getByText("One record found")).toBeInTheDocument();
    expect(screen.getByText("record-7")).toBeInTheDocument();
    expect(screen.queryByText(/\"server\":/)).not.toBeInTheDocument();
  });

  it("renders web search output and both terminal failure phases accessibly", () => {
    const { rerender } = render(
      <ConversationItemView
        item={{
          ...common,
          kind: "web_search",
          status: "failed",
          phase: "failed",
          query: { text: "durable event streams" },
          error: {
            category: "unavailable",
            code: "search_failed",
            message: { text: "Search provider unavailable" },
          },
          result: {
            content: [{ kind: "text", value: { text: "Partial result" } }],
            isError: true,
          },
        }}
      />,
    );

    const failed = screen.getByRole("button", { name: /Web search/ });
    expect(failed).toHaveAttribute("aria-expanded", "false");
    // The failure reason stays announced but leaves the visible header.
    expect(within(failed).getByText("Search provider unavailable")).toHaveClass(
      "sr-only",
    );
    expect(failed.closest("[data-operation-phase]")).toHaveAttribute(
      "data-operation-phase",
      "failed",
    );
    fireEvent.click(failed);
    expect(screen.getByRole("alert")).toHaveTextContent("Partial result");
    // The diagnostic keeps a sighted home at the top of the details.
    expect(document.querySelector(".op-error")).toHaveTextContent(
      "Search provider unavailable",
    );

    rerender(
      <ConversationItemView
        item={{
          ...common,
          kind: "file_read",
          status: "interrupted",
          phase: "interrupted",
          path: { text: "large.log" },
          error: {
            category: "interrupted",
            code: "interrupted",
            message: { text: "Stopped by user" },
          },
        }}
      />,
    );

    const interrupted = screen.getByRole("button", { name: /Read/ });
    expect(interrupted).toHaveTextContent("Interrupted. Stopped by user");
    expect(interrupted.closest("[data-operation-phase]")).toHaveAttribute(
      "data-operation-phase",
      "interrupted",
    );
  });

  it("describes inline and omitted tool-result images without exposing image payloads", () => {
    render(
      <ConversationItemView
        item={{
          ...common,
          kind: "tool",
          phase: "completed",
          toolName: { text: "capture" },
          title: { text: "Capture screenshot" },
          category: "other",
          result: {
            content: [
              {
                kind: "image_inline",
                mimeType: "image/png",
                dataBase64: "iVBORw==",
                decodedBytes: 256,
              },
              {
                kind: "image_omitted",
                mimeType: "image/webp",
                reason: "byte_limit",
              },
            ],
            isError: false,
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Capture screenshot/ }));
    expect(
      screen.getByText("Inline image/png image · 256 bytes"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Image omitted (byte_limit, image/webp)"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText("iVBORw==")).not.toBeInTheDocument();
  });

  it("uses strict safe Markdown behavior", () => {
    const { container } = render(
      <MarkdownContent>
        {
          "[unsafe](javascript:alert(1)) ![tracker](https://bad.example/pixel.png) <script>alert(1)</script>"
        }
      </MarkdownContent>,
    );
    expect(screen.getByText("unsafe")).toBeInTheDocument();
    expect(container.querySelector("a")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: "tracker" }),
    ).not.toBeInTheDocument();
    expect(container.querySelector('[src^="file:"]')).not.toBeInTheDocument();
    expect(container.querySelector("script")).not.toBeInTheDocument();
  });
});
