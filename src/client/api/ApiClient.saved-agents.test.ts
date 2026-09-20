// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./ApiClient.js";

afterEach(() => vi.unstubAllGlobals());

describe("ApiClient Saved Agents", () => {
  it("loads a bounded searched page without bootstrapping mutation state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Reviewer",
              backendTypeId: "pi",
              backend: {
                typeId: "pi",
                label: { text: "Pi" },
                brand: "pi",
              },
              overrideCount: 1,
              sedesTools: null,
              revision: 0,
              createdAt: "2026-08-08T00:00:00.000Z",
              updatedAt: "2026-08-08T00:00:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const page = await new ApiClient().listSavedAgents({
      targetId: "target-codex-local",
      nameSearch: "review",
      pageSize: 25,
    });

    expect(page.items[0]?.name).toBe("Reviewer");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(
      "/api/agents?targetId=target-codex-local&nameSearch=review&pageSize=25",
    );
    expect(init).toMatchObject({ credentials: "same-origin" });
  });
});
