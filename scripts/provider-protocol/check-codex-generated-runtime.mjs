import path from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = path.resolve(
  "dist/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js",
);
const binding = await import(pathToFileURL(modulePath).href);

if (binding.CODEX_APP_SERVER_RELEASE !== "0.163.0") {
  throw new Error("Built Codex binding selected the wrong release.");
}
if (binding.CODEX_CLIENT_REQUEST_METHODS.length !== 27) {
  throw new Error("Built Codex client-request registry is incomplete.");
}
if (binding.CODEX_SERVER_REQUEST_METHODS.length !== 10) {
  throw new Error("Built Codex server-request registry is incomplete.");
}
if (binding.CODEX_ADOPTED_SERVER_NOTIFICATION_METHODS.length !== 39) {
  throw new Error("Built Codex adopted notification registry is incomplete.");
}
if (binding.CODEX_SERVER_NOTIFICATION_METHODS.length !== 87) {
  throw new Error(
    "Built Codex notification admission registry is incomplete.",
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

for (const method of ["thread/archive", "thread/unarchive"]) {
  const codec = binding.defineCodexAppServerMethod({
    method,
    refineParams: (value) => value,
    refineResult: (value) => value,
  });
  if (codec.encodeParams({ threadId: "thread-1" }).threadId !== "thread-1") {
    throw new Error("Built Codex archive codec rejected its fixture.");
  }
}
for (const method of ["thread/archived", "thread/unarchived"]) {
  binding.decodeCodexServerNotificationParams(method, { threadId: "thread-1" });
}

binding.encodeCodexClientNotification("initialized");
binding.decodeCodexServerRequestParams("attestation/generate", {});
binding.encodeCodexServerRequestResult("attestation/generate", {
  token: "opaque",
});
binding.decodeCodexServerNotificationParams("skills/changed", {});
binding.decodeCodexServerNotificationParams("thread/prediction/updated", {
  threadId: "thread-1",
  sourceTurnId: "turn-1",
  result: { type: "completed", text: null },
});
for (const [method, params] of [
  ["thread/readState/changed", { threadId: "thread-1", readState: { firstUnread: { type: "turn", turnId: "turn-1" }, revision: "opaque-1" } }],
  ["turn/moderationMetadata", { threadId: "thread-1", turnId: "turn-1", metadata: null }],
  ["model/verification", { threadId: "thread-1", turnId: "turn-1", verifications: [] }],
  ["model/safetyBuffering/updated", { threadId: "thread-1", turnId: "turn-1", model: "gpt-5.6", useCases: [], reasons: [], showBufferingUi: false, fasterModel: null }],
]) {
  const decoded = binding.decodeCodexServerNotificationParams(method, params);
  binding.assertCodexAttestedServerNotificationParams(method, decoded);
}
if (!binding.isCodexServerNotificationMethod("thread/readState/changed")) {
  throw new Error("Built Codex binding did not admit the reviewed receipt notification.");
}
if (binding.isCodexServerNotificationMethod("unreviewed/experimental")) {
  throw new Error("Built Codex binding admitted an unknown notification.");
}
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
  "Built Codex 0.163.0 production binding executes stable and experimental profiles as ESM.",
);
