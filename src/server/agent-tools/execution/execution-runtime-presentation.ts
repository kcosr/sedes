import type { ConfigurationRuntimeState } from "../../../shared/protocol/configuration-admin.js";

/** Runtime state is useful to agents; arbitrary provider diagnostics are not a
 * safe channel for configured literals or credential contents. */
export function presentExecutionRuntime(runtime: ConfigurationRuntimeState) {
  const { lastError: _lastError, effects, supportedActions, ...visible } = runtime;
  return {
    ...visible,
    supportedActions: supportedActions.filter(action => action !== "confirm_retirement"),
    ...(effects ? { effects: effects.map(({ detail: _detail, ...effect }) => effect) } : {}),
  };
}
