import path from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = path.resolve(
  "dist/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js",
);
const binding = await import(pathToFileURL(modulePath).href);

if (binding.CODEX_APP_SERVER_RELEASE !== "0.153.0") {
  throw new Error("Built Codex binding selected the wrong release.");
}
if (binding.CODEX_CLIENT_REQUEST_METHODS.length !== 24) {
  throw new Error("Built Codex client-request registry is incomplete.");
}
if (binding.CODEX_SERVER_REQUEST_METHODS.length !== 10) {
  throw new Error("Built Codex server-request registry is incomplete.");
}
if (binding.CODEX_ADOPTED_SERVER_NOTIFICATION_METHODS.length !== 31) {
  throw new Error("Built Codex adopted notification registry is incomplete.");
}
if (binding.CODEX_SERVER_NOTIFICATION_METHODS.length !== 83) {
  throw new Error(
    "Built Codex stable notification admission registry is incomplete.",
  );
}

const settings = binding.defineCodexAppServerMethod({
  method: "thread/settings/update",
  refineParams: (value) => value,
  refineResult: (value) => value,
});
const encodedSettings = settings.encodeParams({
  threadId: "thread-1",
  effort: "high",
});
if (encodedSettings.threadId !== "thread-1") {
  throw new Error(
    "Built experimental Codex request codec rejected its fixture.",
  );
}
settings.decodeResult({});

binding.encodeCodexClientNotification("initialized");
binding.decodeCodexServerRequestParams("attestation/generate", {});
binding.encodeCodexServerRequestResult("attestation/generate", {
  token: "opaque",
});
binding.decodeCodexServerNotificationParams("skills/changed", {});
if (
  !binding.validateCodexServerNotificationEnvelope(
    "mcpServer/oauthLogin/completed",
    { name: "server-1", threadId: null, success: true },
  )
) {
  throw new Error(
    "Built Codex stable notification admission rejected its fixture.",
  );
}

let rejected = false;
try {
  binding.encodeCodexServerRequestResult("attestation/generate", { token: 3 });
} catch (error) {
  rejected =
    error instanceof binding.CodexAppServerBindingError &&
    error.cause === undefined;
}
if (!rejected) {
  throw new Error(
    "Built Codex binding did not emit a bounded validation error.",
  );
}

console.log(
  "Built Codex 0.153.0 production binding executes stable and experimental profiles as ESM.",
);
