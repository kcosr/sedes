import { defineCodexAppServerMethod, type OfficialCodexClientRequestParams } from "../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";

/** The adopted subset deliberately excludes the native model/reviewer controls. */
export function refineCodexTurnSettingsUpdate(value: OfficialCodexClientRequestParams<"turn/settings/update">) {
  if (Object.keys(value).length !== 3 || !Object.keys(value).every(key => ["threadId", "turnId", "serviceTier"].includes(key)) ||
      ![value.threadId, value.turnId].every(id => typeof id === "string" && id.length > 0 && id.length <= 512) ||
      !["default", "priority", "ultrafast"].includes(value.serviceTier as string)) {
    throw new Error("codex_turn_settings_update_subset_invalid");
  }
  return value;
}
export const codexTurnSettingsUpdateMethod = defineCodexAppServerMethod({
  method: "turn/settings/update",
  refineParams: refineCodexTurnSettingsUpdate,
  refineResult: value => {
    if (Object.keys(value).length !== 1 || (value.status !== "applied" && value.status !== "targetUnavailable")) {
      throw new Error("codex_turn_settings_update_result_invalid");
    }
    return value;
  },
});
export const CODEX_STEP_MODEL_SWITCHING_CONFIG = Object.freeze({ "features.step_model_switching": true });
