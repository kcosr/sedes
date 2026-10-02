import type { AuthenticationAdmission } from "../authentication/authentication-admission.js";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import {
  createTerminalAdmissionRequestSchema,
  createTerminalRequestSchema,
  renameTerminalRequestSchema,
  terminalAdmissionSchema,
  terminalListResultSchema,
  terminalMutationRequestSchema,
  terminalMutationResultSchema,
  terminalResourceSchema,
  terminalRouteParametersSchema,
} from "../../shared/protocol/terminals.js";
import { threadIdSchema } from "../../shared/protocol/domain.js";
import { ApiError } from "../http/errors.js";
import type { IdentityProvider } from "../identity/identity-provider.js";
import type { HttpRequestOperationGate } from "../runtime/application-shutdown.js";
import type { TerminalAdmissionTokens } from "./terminal-carrier.js";
import type { TerminalService } from "./terminal-service.js";

const threadParametersSchema = z.strictObject({ threadId: threadIdSchema });

export function createTerminalRouter(input: {
  readonly identity: IdentityProvider<Parameters<RequestHandler>[0]>;
  readonly service: TerminalService;
  readonly admissions: TerminalAdmissionTokens;
  readonly authentication?: AuthenticationAdmission;
  readonly requestOperations?: HttpRequestOperationGate;
}): Router {
  const router = Router();
  if (input.requestOperations) {
    router.use((request, response, next) => {
      void input.requestOperations!
        .run(
          () =>
            new Promise<void>((resolve) => {
              let settled = false;
              const settle = () => {
                if (settled) return;
                settled = true;
                resolve();
              };
              response.once("finish", settle);
              response.once("close", settle);
              next();
            }),
        )
        .catch(next);
    });
  }
  router.get("/api/threads/:threadId/terminals", async (request, response) => {
    const scope = await input.identity.resolve(request);
    const { threadId } = threadParametersSchema.parse(request.params);
    response.json(
      terminalListResultSchema.parse({ terminals: input.service.list(scope, threadId) }),
    );
  });
  router.post("/api/threads/:threadId/terminals", async (request, response) => {
    const scope = await input.identity.resolve(request);
    const { threadId } = threadParametersSchema.parse(request.params);
    const body = createTerminalRequestSchema.parse(request.body);
    const terminal = await input.service.create(scope, threadId, body);
    response.status(201).json(
      terminalMutationResultSchema.parse({ terminal }),
    );
  });
  router.get("/api/terminals/:terminalId", async (request, response) => {
    const scope = await input.identity.resolve(request);
    const { terminalId } = terminalRouteParametersSchema.parse(request.params);
    response.json(terminalResourceSchema.parse(input.service.get(scope, terminalId)));
  });
  router.post("/api/terminals/:terminalId/admissions", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const scope = await input.identity.resolve(request);
    const { terminalId } = terminalRouteParametersSchema.parse(request.params);
    const body = createTerminalAdmissionRequestSchema.parse(request.body);
    const client = input.authentication?.required ? input.authentication.clientForRequest(request) : undefined;
    if (input.authentication?.required && !client) {
      throw new ApiError(401, "unauthorized", "Pair this client before connecting.");
    }
    const admission = input.admissions.issue({ scope, terminalId, ...body });
    if (client) {
      input.authentication!.bindTicket(
        admission.token, client.id, Date.parse(admission.expiresAt),
      );
    }
    response.status(201).json(terminalAdmissionSchema.parse(admission));
  });
  router.post("/api/terminals/:terminalId/actions/rename", async (request, response) => {
    const scope = await input.identity.resolve(request);
    const { terminalId } = terminalRouteParametersSchema.parse(request.params);
    const body = renameTerminalRequestSchema.parse(request.body);
    response.json(
      terminalMutationResultSchema.parse({
        terminal: input.service.rename(scope, terminalId, body),
      }),
    );
  });
  router.post("/api/terminals/:terminalId/actions/end", async (request, response) => {
    const scope = await input.identity.resolve(request);
    const { terminalId } = terminalRouteParametersSchema.parse(request.params);
    const body = terminalMutationRequestSchema.parse(request.body);
    await input.service.end(scope, terminalId, body);
    response.json(
      terminalMutationResultSchema.parse({
        terminal: null,
      }),
    );
  });
  router.post("/api/terminals/:terminalId/actions/delete", async (request, response) => {
    const scope = await input.identity.resolve(request);
    const { terminalId } = terminalRouteParametersSchema.parse(request.params);
    const body = terminalMutationRequestSchema.parse(request.body);
    await input.service.delete(scope, terminalId, body);
    response.json(terminalMutationResultSchema.parse({ terminal: null }));
  });
  return router;
}
