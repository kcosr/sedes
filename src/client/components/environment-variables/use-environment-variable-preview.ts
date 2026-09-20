import { useEffect, useState } from "react";
import type { EnvironmentVariablesPreviewResult } from "../../../shared/protocol/environment-variables.js";
import type { ApiClient } from "../../api/ApiClient.js";
import { messageFrom } from "../../stores/ApplicationClientStore.js";

export function useEnvironmentVariablePreview(api: ApiClient, targetId: string | undefined, agentId?: string, refresh = 0) {
  const [state, setState] = useState<{ key: string; result?: EnvironmentVariablesPreviewResult; error?: string }>({ key: "" });
  const key = targetId ? `${targetId}:${agentId ?? ""}:${refresh}` : "";
  useEffect(() => {
    if (!targetId) { setState({ key: "" }); return; }
    const abort = new AbortController();
    setState({ key });
    void api.getEnvironmentVariablePreview({ targetId, ...(agentId ? { agentId } : {}) }, abort.signal)
      .then(result => { if (!abort.signal.aborted) setState({ key, result }); })
      .catch(cause => { if (!abort.signal.aborted) setState({ key, error: messageFrom(cause) }); });
    return () => abort.abort();
  }, [api, targetId, agentId, refresh, key]);
  return state.key === key ? { ...state, loading: Boolean(targetId) && !state.result && !state.error } : { loading: Boolean(targetId), result: undefined, error: undefined };
}
