// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NormalizedDraft,
  NormalizedThreadSnapshot,
  QueuedInputSummary,
} from "../../../shared/index.js";
import type {
  PendingComposerTransfer,
  ThreadClientState,
  ThreadClientStore,
} from "../../stores/ThreadClientStore.js";
import { PendingInputStrip } from "./PendingInputStrip.js";

afterEach(cleanup);

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

function queued(
  id: string,
  sequence: number,
  state: QueuedInputSummary["state"],
  overrides: Partial<QueuedInputSummary> = {},
): QueuedInputSummary {
  return {
    id,
    deliveryOperationId: `operation-${id}`,
    resolvedDeliveryMode: "queue",
    sequence,
    state,
    origin: "user",
    isHead: sequence === 1,
    preview: { text: `Prompt ${id}` },
    attachmentCount: 0,
    taskCount: 0,
    createdAt: "2026-08-08T01:00:00.000Z",
    ...overrides,
  };
}

function snapshot(
  queue: NormalizedThreadSnapshot["queue"],
  options: {
    readonly steerAvailable?: boolean;
    readonly failureId?: string;
  } = {},
): NormalizedThreadSnapshot {
  return {
    queue,
    attention: {
      ...(options.failureId
        ? {
            queueFailure: {
              queuedInputId: options.failureId,
              failedAt: "2026-08-08T01:05:00.000Z",
              diagnostic: { text: "Provider rejected the queued input." },
            },
          }
        : {}),
    },
    capabilities: {
      operations: [{ id: "recover_uncertain", available: true, label: { text: "Reconcile operation" } }],
      deliveryModes: [
        {
          id: "steer",
          steerTarget: "turn" as const,
          label: { text: "Steer" },
          available: options.steerAvailable ?? true,
          ...((options.steerAvailable ?? true)
            ? {}
            : { unavailableReason: { text: "No active running turn." } }),
        },
      ],
    },
  } as unknown as NormalizedThreadSnapshot;
}

function transfer(
  operationId: string,
  mode: PendingComposerTransfer["mode"],
  overrides: Partial<PendingComposerTransfer> = {},
): PendingComposerTransfer {
  const captured: NormalizedDraft = {
    text: `Local ${mode} prompt`,
    contextExcerpts: [],
    attachments: [],
    taskReferences: [],
    revision: 1,
  };
  return {
    operationId,
    mode,
    captured,
    capturedPresentation: {},
    startedAt: 1,
    presentationSequence: 1,
    baselineThreadRevision: 1,
    baselineOrderedTurnIds: [],
    baselineTailTurnItemIds: [],
    acceptanceEvidence: "none",
    presentation:
      mode === "submit"
        ? "transcript"
        : mode === "steer"
          ? "pending_steer"
          : "pending_queue",
    requestState: "requesting",
    authorityState: "client_only",
    ...(mode === "steer" ? { steerPhase: "sending" as const } : {}),
    rollbackRequired: false,
    rollbackApplied: false,
    lateMaterializationRequiresComposerReconciliation: false,
    retainTombstoneAfterRollback: false,
    ...overrides,
  };
}

class FakeStripStore {
  state: ThreadClientState;
  readonly cancelQueuedInput = vi.fn(async (id: string) => {
    this.replaceQueue(
      this.state.snapshot!.queue.filter((item) => item.id !== id),
    );
  });
  readonly steerQueuedInput = vi.fn(async (id: string) => {
    this.replaceQueue(
      this.state.snapshot!.queue.filter((item) => item.id !== id),
    );
  });
  readonly recoverUncertain = vi.fn(async (): Promise<void> => undefined);
  readonly dismissQueueFailure = vi.fn(async () => undefined);
  readonly #listeners = new Set<() => void>();

  constructor(value: NormalizedThreadSnapshot) {
    this.state = {
      status: "ready",
      connection: "connected",
      authoritative: true,
      actionPending: false,
      pendingComposerTransfers: [],
      pendingQueuedSteers: [],
      historyLoading: false,
      forkAttempts: {},
      questionRequests: [],
      questionRevision: 0,
    questionStatuses: {},
      questionInboxOpenRevision: 0,
      questionInboxConsumedOpenRevision: 0,
      questionInboxClosedQuestionKeys: [],
      questionStatus: "ready",
      questionDrafts: {},
      pendingQuestionIds: [],
      pendingQuestionReplies: [],
      bookmarks: [],
      bookmarkRevision: 0,
      bookmarkStatus: "ready",
      pendingBookmarkTurnIds: [],
      stashes: [],
      snapshot: value,
    };
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = () => this.state;

  replaceQueue(queue: NormalizedThreadSnapshot["queue"]): void {
    this.state = {
      ...this.state,
      snapshot: { ...this.state.snapshot!, queue },
    };
    for (const listener of this.#listeners) listener();
  }

  setPendingSteer(phase: "sending" | "steering" | "unconfirmed"): void {
    this.state = {
      ...this.state,
      pendingComposerTransfers: [
        transfer("steer-operation", "steer", {
          captured: {
            text: "Please adjust the current approach",
            contextExcerpts: [],
            attachments: [],
            taskReferences: [],
            revision: 1,
          },
          steerPhase: phase,
        }),
      ],
    };
  }

  setTransfers(transfers: readonly PendingComposerTransfer[]): void {
    this.state = { ...this.state, pendingComposerTransfers: transfers };
    for (const listener of this.#listeners) listener();
  }
}

function renderStrip(
  store: FakeStripStore,
  disabled = false,
  restore: {
    readonly available?: boolean;
    readonly unavailableReason?: string;
    readonly onRestore?: (id: string) => Promise<void>;
  } = {},
  optimisticTranscriptPresentationVisible = true,
) {
  const input = document.createElement("textarea");
  document.body.append(input);
  const composerInput = { current: input };
  const onRestore = vi.fn(
    restore.onRestore ??
      (async (id: string) => {
        store.replaceQueue(
          store.state.snapshot!.queue.filter((item) => item.id !== id),
        );
      }),
  );
  const view = render(
    <PendingInputStrip
      store={store as unknown as ThreadClientStore}
      disabled={disabled}
      composerInput={composerInput}
      restoreAvailable={restore.available ?? true}
      restoreUnavailableReason={
        restore.unavailableReason ?? "The composer is not empty."
      }
      onRestore={onRestore}
      optimisticTranscriptPresentationVisible={
        optimisticTranscriptPresentationVisible
      }
    />,
  );
  return { ...view, input, onRestore };
}

describe("PendingInputStrip", () => {
  it("keeps queue recovery visible with later messages and clears it only after reconciliation", async () => {
    const store = new FakeStripStore(snapshot([queued("head", 1, "uncertain"), queued("later", 2, "pending")]));
    const { input } = renderStrip(store);
    input.value = "Unsent draft";
    expect(screen.getByTestId("queue-paused").textContent).toContain("cannot dispatch until this is resolved");
    expect(screen.getByText("Prompt later")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reconcile delivery" })));
    expect(store.recoverUncertain).toHaveBeenCalledOnce();
    expect(screen.getByTestId("queue-paused")).toBeTruthy();
    expect(input.value).toBe("Unsent draft");
    act(() => store.replaceQueue([queued("later", 2, "pending")]));
    expect(screen.queryByTestId("queue-paused")).toBeNull();
    expect(screen.getByText("Prompt later")).toBeTruthy();
    expect(input.value).toBe("Unsent draft");
  });

  it("prevents duplicate reconciliation while preserving the paused queue", async () => {
    const store = new FakeStripStore(snapshot([queued("head", 1, "uncertain")]));
    let resolve!: () => void;
    store.recoverUncertain.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    renderStrip(store);
    const button = screen.getByRole("button", { name: "Reconcile delivery" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(store.recoverUncertain).toHaveBeenCalledOnce();
    await act(async () => resolve());
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("queue-paused")).toBeTruthy();
  });

  it("keeps the paused explanation visible while disconnected", () => {
    const store = new FakeStripStore(snapshot([queued("head", 1, "uncertain")]));
    store.state = { ...store.state, connection: "disconnected", authoritative: false };
    renderStrip(store);
    expect(screen.getByTestId("queue-paused")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Reconcile delivery" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows recovery even when the uncertain input already appears in history", () => {
    const value = snapshot([queued("head", 1, "uncertain")]);
    const store = new FakeStripStore({ ...value, itemsById: {
      message: { kind: "user_message", deliveryOperationId: "operation-head" },
    } } as unknown as NormalizedThreadSnapshot);
    renderStrip(store);
    expect(screen.getByTestId("queue-paused")).toBeTruthy();
    expect(screen.queryByText("Prompt head")).toBeNull();
  });

  it("preserves recovery guidance and queued inputs after a reconciliation error", async () => {
    const store = new FakeStripStore(snapshot([queued("head", 1, "uncertain"), queued("later", 2, "pending")]));
    store.recoverUncertain.mockRejectedValueOnce(new Error("Backend unavailable"));
    renderStrip(store);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reconcile delivery" })));
    expect(screen.getByRole("alert").textContent).toBe("Backend unavailable");
    expect(store.state.snapshot!.queue).toHaveLength(2);
    expect(screen.getByTestId("queue-paused")).toBeTruthy();
  });

  it("labels callback results and does not offer composer or steer actions", () => {
    const callback = queued("callback", 1, "pending", {
      origin: "agent_result",
      inputOrigin: {
        kind: "agent_result",
        callbackId: "callback-1",
        sourceThreadId: "worker-thread",
        sourceThreadLabel: { text: "Research agent" },
      },
      preview: { text: "The investigation is complete." },
    });
    const store = new FakeStripStore(snapshot([callback]));
    renderStrip(store);

    const row = screen.getByRole("listitem");
    expect(row).toHaveAttribute("data-input-origin", "agent_result");
    expect(row).toHaveTextContent("Agent result · Research agent");
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
  });

  it("labels a durable question reply while retaining ordinary user queue controls", () => {
    const reply = queued("question-reply", 1, "pending", {
      origin: "user",
      inputOrigin: {
        kind: "question_response", requestId: "request-1", sourceItemId: "source-1",
        answers: [{ questionIndex: 0, question: "Which region?", answer: "eu-west-1" }],
      },
      preview: { text: "Question: Which region? Answer: eu-west-1" },
    });
    renderStrip(new FakeStripStore(snapshot([reply])));
    const row = screen.getByRole("listitem");
    expect(row).toHaveAttribute("data-input-origin", "user");
    expect(within(row).getByText("Question answered")).toHaveAttribute("title", "Question answered");
    expect(within(row).getByRole("button", { name: /Delete queued input/ })).toBeEnabled();
  });

  it("shows immediate question Sending and uses typed previews for admission receipts", () => {
    const store = new FakeStripStore(snapshot([]));
    const answers = [{questionIndex:0, question:"Which region?", answer:"west"}];
    store.state = {...store.state, pendingQuestionReplies:[{id:"reply-1",requestId:"request-1",answers}]};
    const view = renderStrip(store);
    expect(screen.getByRole("listitem")).toHaveAttribute("data-pending-question-reply-id", "reply-1");
    expect(screen.getByRole("status")).toHaveTextContent("Sending");
    expect(screen.getByText("Which region?: west")).toBeInTheDocument();
    const receipt = queued("reply", 1, "dispatching", {deliveryMode:"steer", resolvedDeliveryMode:"steer", requestedDeliveryMode:"steer", inputOrigin:{kind:"question_response",requestId:"request-1",sourceItemId:"source-1",answers}, preview:{text:"User responded to a question:"}});
    act(() => {
      store.state = {...store.state, pendingQuestionReplies:[{id:"reply-1",requestId:"request-1",answers,queuedInput:receipt}]};
      store.replaceQueue([]);
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Steering")).toBeInTheDocument();
    expect(screen.queryByText("User responded to a question:")).not.toBeInTheDocument();
    view.unmount();
  });

  it("disables receipt-only queue actions until the canonical projection arrives", () => {
    const store = new FakeStripStore(snapshot([]));
    const receipt = queued("reply", 1, "pending");
    store.state = {...store.state, pendingQuestionReplies:[{
      id:"reply", requestId:"request", answers:[{questionIndex:0, question:"Where?",answer:"West"}], queuedInput:receipt,
    }]};
    renderStrip(store);
    const actions = within(screen.getByRole("listitem")).getAllByRole("button");
    expect(actions).toHaveLength(3);
    actions.forEach((action) => expect(action).toBeDisabled());
    act(() => {
      store.state = {...store.state, pendingQuestionReplies:[]};
      store.replaceQueue([receipt]);
    });
    within(screen.getByRole("listitem")).getAllByRole("button").forEach((action) => expect(action).toBeEnabled());
  });

  it("shows the normalized attachment count for a queued prompt", () => {
    const store = new FakeStripStore(
      snapshot([queued("files", 1, "pending", { attachmentCount: 2 })]),
    );
    renderStrip(store);
    expect(screen.getByText("2 files")).toBeInTheDocument();
  });

  it("renders an immediate local Queue row after existing authoritative rows", () => {
    const store = new FakeStripStore(
      snapshot([queued("existing", 1, "pending")]),
    );
    store.setTransfers([transfer("local-queue", "queue")]);

    renderStrip(store);

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-queued-input-id", "existing");
    expect(rows[1]).toHaveAttribute(
      "data-pending-queue-operation-id",
      "local-queue",
    );
    expect(rows[1]).toHaveTextContent("Local queue prompt");
    expect(within(rows[1]!).queryAllByRole("button")).toHaveLength(0);
  });

  it("replaces only an exactly correlated local Queue row with server authority", () => {
    const store = new FakeStripStore(
      snapshot([
        queued("unrelated", 1, "pending", {
          deliveryOperationId: "another-operation",
        }),
      ]),
    );
    store.setTransfers([transfer("local-queue", "queue")]);
    renderStrip(store);

    expect(
      document.querySelector('[data-pending-queue-operation-id="local-queue"]'),
    ).toBeInTheDocument();
    expect(
      document.querySelector(
        '[data-delivery-operation-id="another-operation"]',
      ),
    ).toBeInTheDocument();

    act(() =>
      store.replaceQueue([
        queued("authoritative", 2, "pending", {
          deliveryOperationId: "local-queue",
        }),
      ]),
    );

    expect(
      document.querySelector('[data-pending-queue-operation-id="local-queue"]'),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-delivery-operation-id="local-queue"]'),
    ).toHaveAttribute("data-queued-input-id", "authoritative");
  });

  it.each([
    ["pending", undefined],
    ["dispatching", "submit"],
  ] as const)(
    "suppresses an exact healthy bound-submit %s row while its bubble owns presentation",
    (queueState, deliveryMode) => {
      const store = new FakeStripStore(
        snapshot([
          queued("bound-submit", 1, queueState, {
            deliveryOperationId: "submit-operation",
            ...(deliveryMode ? { deliveryMode } : {}),
          }),
        ]),
      );
      store.setTransfers([transfer("submit-operation", "submit")]);

      renderStrip(store);

      expect(
        screen.queryByTestId("pending-input-strip"),
      ).not.toBeInTheDocument();
      expect(
        document.querySelector(
          '[data-delivery-operation-id="submit-operation"]',
        ),
      ).not.toBeInTheDocument();
    },
  );

  it("keeps a healthy submit queue row visible when historical focus hides the optimistic bubble", () => {
    const store = new FakeStripStore(
      snapshot([
        queued("bound-submit", 1, "dispatching", {
          deliveryOperationId: "submit-operation",
          deliveryMode: "submit",
        }),
      ]),
    );
    store.setTransfers([transfer("submit-operation", "submit")]);

    renderStrip(store, false, {}, false);

    expect(
      document.querySelector('[data-delivery-operation-id="submit-operation"]'),
    ).toHaveTextContent("Sending");
  });

  it.each([
    ["retry_wait", undefined, "Retry scheduled"],
    ["uncertain", "submit", "Delivery unconfirmed"],
    ["failed", undefined, "Failed"],
  ] as const)(
    "exposes an exact bound-submit %s row as the sole truthful surface",
    (queueState, deliveryMode, label) => {
      const store = new FakeStripStore(
        snapshot([
          queued("bound-submit", 1, queueState, {
            deliveryOperationId: "submit-operation",
            ...(deliveryMode ? { deliveryMode } : {}),
          }),
        ]),
      );
      store.setTransfers([
        transfer("submit-operation", "submit", {
          authorityState: "queue_owned",
        }),
      ]);

      renderStrip(store);

      const row = document.querySelector(
        '[data-delivery-operation-id="submit-operation"]',
      );
      expect(row).toBeInTheDocument();
      expect(row).toHaveTextContent(label);
    },
  );

  it("keeps a demoted submit row visible when retry returns to dispatching", () => {
    const store = new FakeStripStore(
      snapshot([
        queued("bound-submit", 1, "dispatching", {
          deliveryOperationId: "submit-operation",
          deliveryMode: "submit",
        }),
      ]),
    );
    store.setTransfers([
      transfer("submit-operation", "submit", {
        authorityState: "queue_owned",
      }),
    ]);

    renderStrip(store);

    expect(
      document.querySelector('[data-delivery-operation-id="submit-operation"]'),
    ).toHaveTextContent("Sending");
  });

  it("does not duplicate an exact authoritative queue projection for a direct Steer", () => {
    const store = new FakeStripStore(
      snapshot([
        queued("steer-dispatch", 1, "dispatching", {
          deliveryOperationId: "steer-operation",
          deliveryMode: "steer",
        }),
      ]),
    );
    store.setPendingSteer("steering");

    renderStrip(store);

    expect(
      document.querySelector(
        '[data-pending-steer-operation-id="steer-operation"]',
      ),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-delivery-operation-id="steer-operation"]'),
    ).toHaveTextContent("Steering");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("keeps a Queue-to-Steer card visible after its queue row is accepted", () => {
    const store = new FakeStripStore(snapshot([]));
    store.state = {
      ...store.state,
      pendingQueuedSteers: [
        {
          operationId: "queued-steer-operation",
          queuedInputId: "queued-1",
          preview: "Move this into the turn",
          attachmentCount: 0,
          taskCount: 0,
          startedAt: 1,
          presentationSequence: 2,
          phase: "steering",
          requestState: "receipt_received",
        },
      ],
    };

    renderStrip(store);

    const card = document.querySelector(
      '[data-pending-steer-operation-id="queued-steer-operation"]',
    );
    expect(card).toHaveTextContent("Move this into the turn");
    expect(card).toHaveTextContent("Steering");
    expect(
      within(card as HTMLElement).queryByRole("button"),
    ).not.toBeInTheDocument();
  });

  it("replaces the original Queue row with a Steer notification immediately", () => {
    const store = new FakeStripStore(
      snapshot([
        queued("queued-1", 1, "pending", {
          deliveryOperationId: "original-queue-operation",
          attachmentCount: 2,
          taskCount: 1,
        }),
      ]),
    );
    store.state = {
      ...store.state,
      pendingQueuedSteers: [
        {
          operationId: "queued-steer-operation",
          queuedInputId: "queued-1",
          preview: "Prompt queued-1",
          attachmentCount: 2,
          taskCount: 1,
          startedAt: 1,
          presentationSequence: 2,
          phase: "sending",
          requestState: "requesting",
        },
      ],
    };

    renderStrip(store);

    expect(
      document.querySelector('[data-queued-input-id="queued-1"]'),
    ).not.toBeInTheDocument();
    const card = document.querySelector(
      '[data-pending-steer-operation-id="queued-steer-operation"]',
    );
    expect(card).toHaveTextContent("Prompt queued-1");
    expect(card).toHaveTextContent("2 files");
    expect(card).toHaveTextContent("1 task");
    expect(card).toHaveTextContent("Sending steer");
    expect(
      within(card as HTMLElement).queryByRole("button"),
    ).not.toBeInTheDocument();
  });

  it("suppresses a stale exact queue row once the provider user item materializes", () => {
    const value = snapshot([
      queued("accepted", 1, "dispatching", {
        deliveryOperationId: "materialized-operation",
        deliveryMode: "submit",
      }),
    ]);
    const store = new FakeStripStore({
      ...value,
      itemsById: {
        "user-item": {
          id: "user-item",
          kind: "user_message",
          deliveryOperationId: "materialized-operation",
        },
      },
    } as unknown as NormalizedThreadSnapshot);

    renderStrip(store);

    expect(screen.queryByTestId("pending-input-strip")).not.toBeInTheDocument();
    expect(
      document.querySelector(
        '[data-delivery-operation-id="materialized-operation"]',
      ),
    ).not.toBeInTheDocument();
  });

  it("does not recreate local presentation after cancelling a queue-owned submit", async () => {
    const store = new FakeStripStore(
      snapshot([
        queued("bound-submit", 1, "retry_wait", {
          deliveryOperationId: "submit-operation",
        }),
      ]),
    );
    store.setTransfers([
      transfer("submit-operation", "submit", {
        authorityState: "queue_owned",
      }),
    ]);
    renderStrip(store);

    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", {
          name: "Delete queued input: Prompt bound-submit",
        }),
      ),
    );

    expect(screen.queryByTestId("pending-input-strip")).not.toBeInTheDocument();
    expect(
      document.querySelector(
        '[data-pending-queue-operation-id="submit-operation"]',
      ),
    ).not.toBeInTheDocument();
  });

  it("does not recreate local presentation after restoring a queue-owned submit", async () => {
    const store = new FakeStripStore(
      snapshot([
        queued("bound-submit", 1, "retry_wait", {
          deliveryOperationId: "submit-operation",
        }),
      ]),
    );
    store.setTransfers([
      transfer("submit-operation", "submit", {
        authorityState: "queue_owned",
      }),
    ]);
    renderStrip(store);

    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", {
          name: "Restore queued input to composer: Prompt bound-submit",
        }),
      ),
    );

    expect(screen.queryByTestId("pending-input-strip")).not.toBeInTheDocument();
    expect(
      document.querySelector(
        '[data-pending-queue-operation-id="submit-operation"]',
      ),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["sending", "Sending steer", "true"],
    ["steering", "Steering", "false"],
    ["unconfirmed", "Steer unconfirmed", "false"],
  ] as const)(
    "renders a direct %s steer before queued rows with truthful state",
    (phase, label, busy) => {
      const store = new FakeStripStore(
        snapshot([queued("head", 1, "pending")]),
      );
      store.setPendingSteer(phase);

      renderStrip(store);

      const rows = screen.getAllByRole("listitem");
      expect(rows[0]).toHaveAttribute(
        "data-pending-steer-operation-id",
        "steer-operation",
      );
      expect(rows[0]).toHaveTextContent("You");
      expect(rows[0]).toHaveTextContent("Please adjust the current approach");
      expect(rows[0]).toHaveTextContent(label);
      expect(rows[0]).toHaveAttribute("aria-busy", busy);
      expect(within(rows[0]!).getByRole("status")).toHaveTextContent(label);
      expect(rows[1]).toHaveAttribute("data-queued-input-id", "head");

      expect(within(rows[0]!).queryByRole("button")).not.toBeInTheDocument();
    },
  );

  it("renders the closed action set and truthful delivery statuses in order", async () => {
    const store = new FakeStripStore(
      snapshot(
        [
          queued("head", 1, "pending"),
          queued("later", 2, "retry_wait", {
            nextAttemptAt: "2026-08-08T01:10:00.000Z",
          }),
          queued("automation", 3, "pending", { origin: "automation" }),
          queued("agent", 4, "pending", {
            origin: "agent_control",
            initiatingAgentThreadId: "controller-thread",
            inputOrigin: {
              kind: "agent_message",
              sourceThreadId: "controller-thread",
              sourceThreadLabel: { text: "Main implementation" },
            },
          }),
          queued("client", 5, "pending", {
            origin: "principal_client_control",
            initiatingToolClientId: "10000000-0000-4000-8000-000000000099",
          }),
          queued("steering", 6, "dispatching", { deliveryMode: "steer" }),
          queued("sending", 7, "dispatching", { deliveryMode: "submit" }),
          queued("unconfirmed", 8, "uncertain", { deliveryMode: "submit" }),
          queued("steer-unconfirmed", 9, "uncertain", {
            deliveryMode: "steer",
          }),
          queued("failed", 10, "failed", {
            diagnostic: { text: "Provider rejected the queued input." },
          }),
        ],
        { failureId: "failed" },
      ),
    );

    renderStrip(store);

    expect(
      screen.getByRole("region", { name: "Pending inputs" }),
    ).toBeVisible();
    expect(
      screen.getAllByRole("listitem").map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("Prompt head"),
      expect.stringContaining("Prompt later"),
      expect.stringContaining("Prompt automation"),
      expect.stringContaining("Prompt agent"),
      expect.stringContaining("Prompt client"),
      expect.stringContaining("Prompt steering"),
      expect.stringContaining("Prompt sending"),
      expect.stringContaining("Prompt unconfirmed"),
      expect.stringContaining("Prompt steer-unconfirmed"),
      expect.stringContaining("Prompt failed"),
    ]);
    expect(screen.queryByText("Queued")).not.toBeInTheDocument();
    expect(
      screen.getByText("Agent message · Main implementation"),
    ).toBeVisible();
    expect(screen.getByText("Tool client")).toBeVisible();
    expect(screen.getByText("Retry scheduled")).toBeVisible();
    expect(screen.getByText("Steering")).toBeVisible();
    expect(screen.getByText("Sending")).toBeVisible();
    expect(screen.getByText("Delivery unconfirmed")).toBeVisible();
    expect(screen.getByText("Steer unconfirmed")).toBeVisible();
    expect(screen.getByText("Failed")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Steer queued input into active turn: Prompt head",
      }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", {
        name: "Steer queued input into active turn: Prompt later",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /Delete queued input/ }),
    ).toHaveLength(3);
    expect(
      screen.getAllByRole("button", {
        name: /Restore queued input to composer:/,
      }),
    ).toHaveLength(3);
    const dismissFailure = screen.getByRole("button", {
      name: "Dismiss queued input failure: Prompt failed",
    });
    expect(dismissFailure).toBeEnabled();
    await act(async () => fireEvent.click(dismissFailure));
    expect(store.dismissQueueFailure).toHaveBeenCalledWith("failed");
  });

  it("keeps an unavailable head Steer action disabled with the normalized reason", () => {
    const store = new FakeStripStore(
      snapshot([queued("head", 1, "pending")], { steerAvailable: false }),
    );
    renderStrip(store);

    const steer = screen.getByRole("button", {
      name: "Steer queued input into active turn: Prompt head",
    });
    expect(steer).toBeDisabled();
    expect(steer).toHaveAttribute("title", "No active running turn.");
  });

  it("restores a mutable row through the composer callback without redirecting row focus", async () => {
    const store = new FakeStripStore(snapshot([queued("head", 1, "pending")]));
    let resolve!: () => void;
    const restore = new Promise<void>((done) => {
      resolve = done;
    });
    const { input, onRestore } = renderStrip(store, false, {
      onRestore: async (id) => {
        await restore;
        store.replaceQueue(
          store.state.snapshot!.queue.filter((item) => item.id !== id),
        );
      },
    });
    const button = screen.getByRole("button", {
      name: "Restore queued input to composer: Prompt head",
    });

    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button.closest("li")).toHaveAttribute("aria-busy", "true");
    expect(onRestore).toHaveBeenCalledWith("head");
    await act(async () => resolve());

    expect(input).not.toHaveFocus();
    expect(
      screen.getByText("Restored queued input 1 to the composer: Prompt head"),
    ).toHaveClass("sr-only");
  });

  it("keeps Restore visible but disabled with the composer reason", () => {
    const store = new FakeStripStore(snapshot([queued("head", 1, "pending")]));
    renderStrip(store, false, {
      available: false,
      unavailableReason: "Clear the composer before restoring a queued input.",
    });

    const restore = screen.getByRole("button", {
      name: "Restore queued input to composer: Prompt head",
    });
    expect(restore).toBeDisabled();
    expect(restore).toHaveAttribute(
      "title",
      "Clear the composer before restoring a queued input.",
    );
  });

  it("keeps pending and failure feedback row-scoped", async () => {
    let rejectHead!: (error: Error) => void;
    const store = new FakeStripStore(
      snapshot([queued("head", 1, "pending"), queued("later", 2, "pending")]),
    );
    store.cancelQueuedInput.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectHead = reject;
        }),
    );
    renderStrip(store);

    const headDelete = screen.getByRole("button", {
      name: "Delete queued input: Prompt head",
    });
    fireEvent.click(headDelete);
    expect(headDelete).toBeDisabled();
    expect(headDelete.closest("li")).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("button", { name: "Delete queued input: Prompt later" }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete queued input: Prompt later" }),
    );
    expect(store.cancelQueuedInput).toHaveBeenCalledTimes(2);

    await act(async () => rejectHead(new Error("Revision changed.")));
    expect(screen.getByRole("alert")).toHaveTextContent("Revision changed.");
    expect(
      screen.getByRole("button", { name: "Delete queued input: Prompt head" }),
    ).toBeEnabled();
  });

  it("moves fine-pointer focus to the next row after authoritative removal", async () => {
    const store = new FakeStripStore(
      snapshot([queued("head", 1, "pending"), queued("later", 2, "pending")]),
    );
    renderStrip(store);
    const deleteHead = screen.getByRole("button", {
      name: "Delete queued input: Prompt head",
    });
    deleteHead.focus();

    await act(async () => fireEvent.click(deleteHead));

    expect(
      screen.getByRole("button", { name: "Delete queued input: Prompt later" }),
    ).toHaveFocus();
  });

  it("does not force composer focus after the last row is removed on a coarse pointer", async () => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    const store = new FakeStripStore(snapshot([queued("head", 1, "pending")]));
    const { input } = renderStrip(store);
    const deleteHead = screen.getByRole("button", {
      name: "Delete queued input: Prompt head",
    });
    deleteHead.focus();

    await act(async () => fireEvent.click(deleteHead));

    expect(input).not.toHaveFocus();
    expect(screen.queryByTestId("pending-input-strip")).not.toBeInTheDocument();
    expect(screen.getByText("Deleted queued input 1: Prompt head")).toHaveClass(
      "sr-only",
    );
  });
});
