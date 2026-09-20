import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  servers.clear();
});

describe("measure-thread-load", () => {
  it("requests the explicit full activity projection", async () => {
    const paths: string[] = [];
    const authorizations: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      authorizations.push(request.headers.authorization);
      if (request.url === "/api/application/session") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
        return;
      }
      if (
        request.url ===
        "/api/threads/thread%2Fwith%20spaces/events?activityDetail=full"
      ) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(
          'event: thread\ndata: {"event":{"type":"snapshot","snapshot":{"orderedTurnIds":[],"itemsById":{}}}}\n\n',
        );
        return;
      }
      response.writeHead(400);
      response.end();
    });
    servers.add(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP test server address.");
    }

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "scripts/measure-thread-load.mjs",
        "thread/with spaces",
        "--repeats=1",
        `--url=http://127.0.0.1:${address.port}`,
      ],
      { cwd: process.cwd(), env: { ...process.env, SEDES_AUTH_TOKEN: "a".repeat(43) } },
    );

    expect(JSON.parse(stdout)).toMatchObject({
      threadId: "thread/with spaces",
      thread: [{ turns: 0, items: 0 }],
    });
    expect(paths).toEqual([
      "/api/application/session",
      "/api/threads/thread%2Fwith%20spaces/events?activityDetail=full",
    ]);
    expect(authorizations).toEqual([`Bearer ${"a".repeat(43)}`, `Bearer ${"a".repeat(43)}`]);
    expect(stdout).not.toContain("a".repeat(43));
  });

  it("rejects redirects without forwarding credentials", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(302, { Location: "/redirected" }); response.end();
    });
    servers.add(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing server address");
    await expect(execFileAsync(process.execPath, ["scripts/measure-thread-load.mjs", "thread", `--url=http://127.0.0.1:${address.port}`], {
      cwd: process.cwd(), env: { ...process.env, SEDES_AUTH_TOKEN: "a".repeat(43) },
    })).rejects.toThrow();
    expect(requests).toBe(1);
  });
});
