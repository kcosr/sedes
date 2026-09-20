// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/ApiClient.js";
import { emptyEnvironmentVariablesSnapshot, type EnvironmentVariablesPreviewResult } from "../../../shared/protocol/environment-variables.js";
import { useEnvironmentVariablePreview } from "./use-environment-variable-preview.js";

afterEach(cleanup);

it("aborts superseded previews and never exposes stale values or revisions", async () => {
  const requests: { signal: AbortSignal; resolve: (value: EnvironmentVariablesPreviewResult) => void }[] = [];
  const getEnvironmentVariablePreview = vi.fn((_query: unknown, signal: AbortSignal) =>
    new Promise<EnvironmentVariablesPreviewResult>(resolve => { requests.push({ signal, resolve }); }));
  const api = { getEnvironmentVariablePreview } as unknown as ApiClient;
  const { result, rerender, unmount } = renderHook(({ targetId, agentId }) =>
    useEnvironmentVariablePreview(api, targetId, agentId), { initialProps: { targetId: "target-a", agentId: "agent-a" } });
  expect(result.current.loading).toBe(true);
  rerender({ targetId: "target-a", agentId: "agent-b" });
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(requests[1]!.signal.aborted).toBe(false);
  const preview = (revision: number): EnvironmentVariablesPreviewResult => ({
    snapshot: emptyEnvironmentVariablesSnapshot(), revision: { configurationRevision: revision, agentRevision: revision }, startup: { supported: true },
  });
  await act(async () => requests[1]!.resolve(preview(2)));
  await waitFor(() => expect(result.current.result?.revision.configurationRevision).toBe(2));
  // Even an implementation that settles despite cancellation cannot replace
  // the reviewed values with the older Agent's preview.
  await act(async () => requests[0]!.resolve(preview(1)));
  expect(result.current.result?.revision.configurationRevision).toBe(2);
  rerender({ targetId: "target-b", agentId: "agent-b" });
  expect(result.current.result).toBeUndefined();
  expect(result.current.loading).toBe(true);
  expect(requests[1]!.signal.aborted).toBe(true);
  unmount();
  expect(requests[2]!.signal.aborted).toBe(true);
});
