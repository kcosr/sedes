import type { Request, RequestHandler } from "express";
import {
  acceptHostRegistrationRequestSchema, acceptHostRegistrationResultSchema,
  changeHostPairingRequestSchema, changeHostPairingResultSchema,
  denyHostRegistrationRequestSchema, hostPairingListSchema, hostRegistrationSchema,
  type AcceptHostRegistrationRequest, type AcceptHostRegistrationResult,
  type ChangeHostPairingRequest, type ChangeHostPairingResult,
  type DenyHostRegistrationRequest, type HostPairingList, type HostRegistration,
} from "../../shared/protocol/host-pairing.js";
import type { RequestScope } from "../identity/identity-provider.js";

/** Management authority is resolved by the server, never by submitted host metadata. */
export interface HostPairingAdministration {
  list(scope: RequestScope): Promise<HostPairingList>;
  accept(scope: RequestScope, request: AcceptHostRegistrationRequest): Promise<AcceptHostRegistrationResult>;
  deny(scope: RequestScope, request: DenyHostRegistrationRequest): Promise<HostRegistration>;
  revoke(scope: RequestScope, request: ChangeHostPairingRequest): Promise<ChangeHostPairingResult>;
  reapprove(scope: RequestScope, request: ChangeHostPairingRequest): Promise<ChangeHostPairingResult>;
}

interface Routes {
  get(path: string, ...handlers: RequestHandler[]): void;
  post(path: string, ...handlers: RequestHandler[]): void;
}

export function registerHostPairingRoutes(routes: Routes,
  scope: (request: Request) => Promise<RequestScope>, service: HostPairingAdministration): void {
  routes.get("/api/host-registrations", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(hostPairingListSchema.parse(await service.list(await scope(request))));
  });
  routes.post("/api/host-registrations/accept", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(acceptHostRegistrationResultSchema.parse(await service.accept(
      await scope(request), acceptHostRegistrationRequestSchema.parse(request.body))));
  });
  routes.post("/api/host-registrations/deny", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(hostRegistrationSchema.parse(await service.deny(
      await scope(request), denyHostRegistrationRequestSchema.parse(request.body))));
  });
  routes.post("/api/host-pairings/revoke", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(changeHostPairingResultSchema.parse(await service.revoke(
      await scope(request), changeHostPairingRequestSchema.parse(request.body))));
  });
  routes.post("/api/host-pairings/reapprove", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(changeHostPairingResultSchema.parse(await service.reapprove(
      await scope(request), changeHostPairingRequestSchema.parse(request.body))));
  });
}
