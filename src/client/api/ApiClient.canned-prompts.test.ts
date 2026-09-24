// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { SEDES_CLIENT_PROTOCOL_VERSION } from "../../shared/index.js";
import { SEDES_VERSION } from "../../shared/version.js";
import { ApiClient } from "./ApiClient.js";

const promptId = "10000000-0000-4000-8000-000000000001";
const prompt = {
  id: promptId,
  title: "Review",
  text: "Review this carefully.",
  position: 0,
  createdAt: 1,
  updatedAt: 1,
};

function session() {
  return {
    clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
    version: SEDES_VERSION,
    csrfToken: "a".repeat(32),
    providerPulseEnabled: false, experimentalUsageEnabled: false,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("ApiClient canned prompts", () => {
  it("loads the principal library without application bootstrap", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ revision: 1, items: [prompt] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new ApiClient().listCannedPrompts()).resolves.toEqual({
      revision: 1,
      items: [prompt],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      "/api/application/canned-prompts",
    );
  });

  it("uses CSRF, full replacement, encoded ids, and strict request fields", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/api/application/session")) {
          return Response.json(session());
        }
        expect(String(input)).toContain(
          `/api/application/canned-prompts/${promptId}`,
        );
        expect(init).toMatchObject({
          method: "PUT",
          headers: expect.objectContaining({
            "X-CSRF-Token": "a".repeat(32),
          }),
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          title: "Review",
          text: "Review this carefully.",
          expectedRevision: 1,
          mutationId: "30000000-0000-4000-8000-000000000001",
        });
        return Response.json({ revision: 2, items: [prompt], replayed: false });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new ApiClient().updateCannedPrompt(promptId, {
        title: "Review",
        text: "Review this carefully.",
        expectedRevision: 1,
        mutationId: "30000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toMatchObject({ revision: 2, replayed: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
