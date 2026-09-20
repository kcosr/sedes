import type { Request, RequestHandler } from "express";
import { z } from "zod";
import {
  configurationLifecycleImpactRequestSchema, configurationLifecycleImpactSchema,
  configurationLifecycleRequestSchema, configurationLifecycleResultSchema,
  configurationSnapshotSchema, saveConfigurationRequestSchema,
} from "../../shared/protocol/configuration-admin.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { ConfigurationAdminService } from "./configuration-admin-service.js";

interface ConfigurationRoutes {
  get(path: string, ...handlers: RequestHandler[]): void;
  put(path: string, ...handlers: RequestHandler[]): void;
  post(path: string, ...handlers: RequestHandler[]): void;
}

export function registerConfigurationAdminRoutes(routes: ConfigurationRoutes,
  scope: (request: Request) => Promise<RequestScope>, service: ConfigurationAdminService): void {
  routes.get("/api/configuration", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(configurationSnapshotSchema.parse(await service.get(await scope(request))));
  });
  routes.put("/api/configuration", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(configurationSnapshotSchema.parse(await service.save(await scope(request), saveConfigurationRequestSchema.parse(request.body))));
  });
  routes.post("/api/configuration/lifecycle/impact", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(configurationLifecycleImpactSchema.parse(await service.impact(await scope(request), configurationLifecycleImpactRequestSchema.parse(request.body))));
  });
  routes.post("/api/configuration/lifecycle", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(configurationLifecycleResultSchema.parse(await service.lifecycle(await scope(request), configurationLifecycleRequestSchema.parse(request.body))));
  });
  routes.get("/api/configuration/lifecycle/:mutationId", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const { mutationId } = z.strictObject({ mutationId: z.string().uuid() }).parse(request.params);
    response.json(configurationLifecycleResultSchema.parse(await service.lifecycleReceipt(await scope(request), mutationId)));
  });
}
