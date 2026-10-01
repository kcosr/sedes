import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { BackendAgentToolRequestError, type TrustedAgentToolSource } from "../../agent-tools/adapters/backend-facade.js";
import { openCodeNativeAuthoritySchema } from "./opencode-native-codecs.js";
import type { OpenCodeNativeAuthority } from "./opencode-native-port.js";

const identity = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/u.test(value));
const sequence = z.number().int().nonnegative().safe();
/** Captured by the execution host when an invocation enters its admitted route. */
export const openCodeToolInvocationStampSchema = z.strictObject({
  authority: openCodeNativeAuthoritySchema.required({ session: true }),
  journalId: identity,
  throughSequence: sequence,
  nativeContinuity: identity,
  inputId: identity.nullable(),
  authorityEpoch: sequence,
  nativeConnected: z.boolean(),
});
export type OpenCodeToolInvocationStamp = Omit<Readonly<z.infer<typeof openCodeToolInvocationStampSchema>>, "authority"> & {
  readonly authority: OpenCodeNativeAuthority & { readonly session: NonNullable<OpenCodeNativeAuthority["session"]> };
};

export function parseOpenCodeToolInvocationStamp(value: unknown): OpenCodeToolInvocationStamp {
  const parsed = openCodeToolInvocationStampSchema.parse(value);
  Object.freeze(parsed.authority.session); Object.freeze(parsed.authority);
  return Object.freeze(parsed);
}

const invocations = new AsyncLocalStorage<OpenCodeToolInvocationStamp>();
/** Provider-private context never changes canonical tool input or source contracts. */
export function runWithOpenCodeInvocation<T>(stamp: OpenCodeToolInvocationStamp, run: () => T): T {
  return invocations.run(parseOpenCodeToolInvocationStamp(stamp), run);
}
/** Capture synchronously while resolving the source, before any asynchronous work. */
export function captureOpenCodeInvocation(): OpenCodeToolInvocationStamp | undefined {
  return invocations.getStore();
}
export function assertOpenCodeInvocationSource(stamp: OpenCodeToolInvocationStamp, source: TrustedAgentToolSource): void {
  const authority = stamp.authority;
  if (source.backendKind !== "opencode" || authority.tenantId !== source.scope.tenantId ||
      authority.principalId !== source.scope.principalId || authority.executionEnvironmentId !== source.sourceEnvironmentId ||
      authority.session.applicationThreadId !== source.sourceThreadId) throw openCodeToolInvocationDenied();
}
export function assertOpenCodeInvocationAuthority(stamp: OpenCodeToolInvocationStamp, authority: OpenCodeNativeAuthority): void {
  const expected = stamp.authority;
  if ((["tenantId", "principalId", "executionEnvironmentId", "backendInstanceId", "runtimeId", "nativeGeneration", "directory"] as const)
    .some(key => expected[key] !== authority[key]) || !authority.session ||
      (["applicationThreadId", "nativeSessionID", "bindingFingerprint"] as const)
        .some(key => expected.session[key] !== authority.session![key])) throw openCodeToolInvocationDenied();
}
export function openCodeToolInvocationDenied(): BackendAgentToolRequestError {
  return new BackendAgentToolRequestError({ code: "permission_denied", retryable: false,
    message: "An access decision requires the current user input proved by Sedes for this OpenCode invocation." });
}
