import type { Request, RequestHandler } from "express";
import { z } from "zod";
import {
  configurationOperationRecoveryAcknowledgeRequestSchema,
  configurationOperationRecoveryAcknowledgmentSchema,
  configurationOperationRecoveryInspectionSchema,
  configurationOperationRecoveryKindSchema,
  configurationOperationRecoveryListSchema,
} from "../../shared/protocol/configuration-operation-recovery.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { ConfigurationOperationRecoveryService } from "./configuration-operation-recovery-service.js";

const environmentParams = z.strictObject({ environmentId: z.string().uuid() });
const operationParams = environmentParams.extend({ kind: configurationOperationRecoveryKindSchema, receiptId: z.string().uuid() });
export function registerConfigurationOperationRecoveryRoutes(
  routes: { get(path: string, ...handlers: RequestHandler[]): void; post(path: string, ...handlers: RequestHandler[]): void },
  scope: (request: Request) => Promise<RequestScope>, service: ConfigurationOperationRecoveryService,
): void {
  const base = "/api/configuration/environments/:environmentId/operations";
  routes.get(base, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const { environmentId } = environmentParams.parse(request.params);
    response.json(configurationOperationRecoveryListSchema.parse(await service.list(await scope(request), environmentId)));
  });
  routes.get(`${base}/:kind/:receiptId`, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const { environmentId, ...reference } = operationParams.parse(request.params);
    response.json(configurationOperationRecoveryInspectionSchema.parse(await service.inspect(await scope(request), environmentId, reference)));
  });
  routes.post(`${base}/:kind/:receiptId/acknowledge`, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const { environmentId, ...reference } = operationParams.parse(request.params);
    const body = configurationOperationRecoveryAcknowledgeRequestSchema.parse(request.body);
    response.json(configurationOperationRecoveryAcknowledgmentSchema.parse(await service.acknowledge(await scope(request), environmentId, reference, body)));
  });
}
