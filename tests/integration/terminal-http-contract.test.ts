import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  terminalMutationResultSchema,
  type TerminalResource,
} from "../../src/shared/protocol/terminals.js";
import type { IdentityProvider } from "../../src/server/identity/identity-provider.js";
import { errorMiddleware } from "../../src/server/http/errors.js";
import type { TerminalAdmissionTokens } from "../../src/server/terminals/terminal-carrier.js";
import { createTerminalRouter } from "../../src/server/terminals/terminal-http.js";
import {
  TerminalServiceError,
  type TerminalService,
} from "../../src/server/terminals/terminal-service.js";

describe("terminal HTTP contract", () => {
  it("returns a created terminal in the receipted mutation envelope consumed by ApiClient", async () => {
    const terminal = resource();
    const create = vi.fn(async () => terminal);
    const app = express();
    app.use(express.json());
    app.use(
      createTerminalRouter({
        identity: {
          async resolve() {
            return { tenantId: "tenant", principalId: "principal" };
          },
        } as IdentityProvider<express.Request>,
        service: { create } as unknown as TerminalService,
        admissions: {} as TerminalAdmissionTokens,
      }),
    );
    const response = await request(app)
      .post(`/api/threads/${terminal.threadId}/terminals`)
      .send({
        mutationId: "99999999-9999-4999-8999-999999999999",
        displayName: "Shell",
        rows: 24,
        columns: 80,
      })
      .expect(201);
    expect(terminalMutationResultSchema.parse(response.body)).toEqual({ terminal });
    expect(create).toHaveBeenCalledOnce();
  });

  it("renames a terminal through the normalized mutation contract", async () => {
    const terminal = { ...resource(), displayName: "Build logs", lifecycleRevision: 4 };
    const rename = vi.fn(() => terminal);
    const app = terminalApp({ service: { rename } as unknown as TerminalService });

    const response = await request(app)
      .post(`/api/terminals/${terminal.terminalId}/actions/rename`)
      .send({
        mutationId: "99999999-9999-4999-8999-999999999999",
        expectedRevision: 3,
        displayName: "Build logs",
      })
      .expect(200);

    expect(terminalMutationResultSchema.parse(response.body)).toEqual({ terminal });
    expect(rename).toHaveBeenCalledWith(
      { tenantId: "tenant", principalId: "principal" },
      terminal.terminalId,
      {
        mutationId: "99999999-9999-4999-8999-999999999999",
        expectedRevision: 3,
        displayName: "Build logs",
      },
    );
  });

  it("ends and removes a terminal through one receipted mutation", async () => {
    const terminal = resource();
    const end = vi.fn(async () => undefined);
    const app = terminalApp({ service: { end } as unknown as TerminalService });

    const response = await request(app)
      .post(`/api/terminals/${terminal.terminalId}/actions/end`)
      .send({
        mutationId: "99999999-9999-4999-8999-999999999999",
        expectedRevision: 3,
      })
      .expect(200);

    expect(terminalMutationResultSchema.parse(response.body)).toEqual({
      terminal: null,
    });
    expect(end).toHaveBeenCalledWith(
      { tenantId: "tenant", principalId: "principal" },
      terminal.terminalId,
      {
        mutationId: "99999999-9999-4999-8999-999999999999",
        expectedRevision: 3,
      },
    );
  });

  it.each([
    [new TerminalServiceError("not_found", "missing"), 404, "not_found"],
    [new TerminalServiceError("conflict", "stale revision"), 409, "conflict"],
  ] as const)(
    "maps terminal service failures without leaking server details",
    async (failure, status, code) => {
      const terminal = resource();
      const app = terminalApp({
        service: {
          get() {
            throw failure;
          },
        } as unknown as TerminalService,
      });
      const response = await request(app)
        .get(`/api/terminals/${terminal.terminalId}`)
        .expect(status);
      expect(response.body).toMatchObject({
        error: { code, retryable: false },
      });
    },
  );

  it("has no terminal-specific HTTP Host restriction after shared application guards", async () => {
    const terminal = resource();
    const create = vi.fn(async () => terminal);
    const admission = {
      token: "a".repeat(43),
      expiresAt: "2026-08-27T00:00:15.000Z",
      terminalId: terminal.terminalId,
      incarnationId: terminal.incarnationId!,
      attachmentId: "77777777-7777-4777-8777-777777777777",
    };
    const issue = vi.fn(() => admission);
    const app = terminalApp({
      service: { create } as unknown as TerminalService,
      admissions: { issue } as unknown as TerminalAdmissionTokens,
    });

    const createResponse = await request(app)
      .post(`/api/threads/${terminal.threadId}/terminals`)
      .set("Host", "192.168.1.20:4784")
      .send({
        mutationId: "99999999-9999-4999-8999-999999999999",
        displayName: "Shell",
        rows: 24,
        columns: 80,
      })
      .expect(201);
    const admissionResponse = await request(app)
      .post(`/api/terminals/${terminal.terminalId}/admissions`)
      .set("Host", "192.168.1.20:4784")
      .send({
        producerId: "66666666-6666-4666-8666-666666666666",
        requestedRole: "observer",
        emulator: {
          family: "ghostty-web",
          version: "0.4.0",
          unicodeVersion: "11",
          restoreFormat: "ansi-checkpoint-v1",
        },
        restore: { kind: "checkpoint" },
      })
      .expect(201);

    expect(createResponse.body).toEqual({ terminal });
    expect(admissionResponse.body).toEqual(admission);
    expect(create).toHaveBeenCalledOnce();
    expect(issue).toHaveBeenCalledOnce();
  });
});

function terminalApp(input: {
  service: TerminalService;
  admissions?: TerminalAdmissionTokens;
}) {
  const app = express();
  app.use(express.json());
  app.use(
    createTerminalRouter({
      identity: {
        async resolve() {
          return { tenantId: "tenant", principalId: "principal" };
        },
      } as IdentityProvider<express.Request>,
      service: input.service,
      admissions: input.admissions ?? ({} as TerminalAdmissionTokens),
    }),
  );
  app.use(errorMiddleware);
  return app;
}

function resource(): TerminalResource {
  return {
    terminalId: "11111111-1111-4111-8111-111111111111",
    threadId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    environmentId: "44444444-4444-4444-8444-444444444444",
    environmentLabel: "Local",
    terminationEffect: "end_process",
    incarnationId: "55555555-5555-4555-8555-555555555555",
    displayName: "Shell",
    shellProfile: null,
    initialCwd: "/work",
    lifecycle: "running",
    lifecycleRevision: 3,
    rows: 24,
    columns: 80,
    initialRows: 24,
    initialColumns: 80,
    historyFloorSeq: 0,
    headSeq: 0,
    exitCode: null,
    exitSignal: null,
    publicReason: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    startedAt: "2026-08-27T00:00:00.001Z",
    exitedAt: null,
    updatedAt: "2026-08-27T00:00:00.001Z",
  };
}
