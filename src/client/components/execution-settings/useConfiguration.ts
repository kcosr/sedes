import { useCallback, useEffect, useRef, useState } from "react";
import { configurationDocumentSchema, type ConfigurationRuntimeState } from "../../../shared/protocol/configuration-admin.js";
import { ApiError, type ApiClient } from "../../api/ApiClient.js";
import { errorMessage } from "./fields.js";
import type { Configuration, ConfigurationSnapshot } from "./types.js";

export type ConfigurationControls = Pick<ApiClient, "readConfiguration" | "saveConfiguration" | "configurationLifecycleImpact" | "configurationLifecycle" | "getLifecycleReceipt" | "listConfigurationOperations" | "inspectConfigurationOperation" | "acknowledgeConfigurationOperation">;

export function useConfiguration(controls: ConfigurationControls, isEditing = false, visible = true) {
  const [snapshot, setSnapshot] = useState<ConfigurationSnapshot>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lastSaveSucceeded, setLastSaveSucceeded] = useState<boolean>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [connectionStale, setConnectionStale] = useState(false);
  const readController = useRef<AbortController | undefined>(undefined);
  const readInFlight = useRef(false);
  const savingRef = useRef(false);
  const editingRef = useRef(isEditing);
  const snapshotRef = useRef(snapshot);
  editingRef.current = isEditing;
  snapshotRef.current = snapshot;
  const load = useCallback(async (background: boolean) => {
    if (background && (readInFlight.current || savingRef.current)) return false;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    readInFlight.current = true;
    if (!background) { setLoading(true); setError(""); }
    try {
      const next = await controls.readConfiguration(controller.signal);
      if (controller.signal.aborted) return false;
      const current = snapshotRef.current;
      if (background && editingRef.current && current) {
        if (current.revision !== next.revision) {
          setNeedsRefresh(true);
          setError("Configuration changed in another session. Discard edits and refresh before editing the latest revision.");
        }
        setSnapshot({ ...current, runtimes: next.runtimes });
      } else {
        setSnapshot(next);
        setNeedsRefresh(false);
        setError("");
      }
      setConnectionStale(false);
      setRefreshError("");
      return true;
    } catch (cause) {
      if (!controller.signal.aborted) {
        setConnectionStale(true);
        if (background) setRefreshError("Status refresh failed. Displayed runtime status may be out of date.");
        else setError(errorMessage(cause, "Could not load execution configuration."));
      }
      return false;
    } finally {
      if (readController.current === controller) {
        readInFlight.current = false;
        setLoading(false);
      }
    }
  }, [controls]);
  const refresh = useCallback(() => load(false), [load]);
  // Lifecycle receipts can settle while their detail is hidden by an editor.
  // Refresh runtime state without silently rebasing that editor's configuration.
  const refreshRuntime = useCallback(() => load(true), [load]);
  useEffect(() => () => {
    readController.current?.abort();
    readInFlight.current = false;
  }, [load]);
  useEffect(() => {
    if (!visible) return;
    void (snapshotRef.current ? load(true) : refresh());
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load(true);
    }, 5_000);
    return () => { window.clearInterval(interval); };
  }, [refresh, load, visible]);
  const save = async (configuration: Configuration): Promise<boolean> => {
    if (!snapshot || saving || needsRefresh || connectionStale) return false;
    const parsed = configurationDocumentSchema.safeParse(configuration);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => `${issue.path.join(" · ")}: ${issue.message}`).join("\n"));
      return false;
    }
    readController.current?.abort();
    readInFlight.current = false;
    setLoading(false);
    setSaving(true);
    setLastSaveSucceeded(undefined);
    savingRef.current = true;
    setError("");
    setNotice("");
    try {
      const next = await controls.saveConfiguration({ mutationId: crypto.randomUUID(), expectedRevision: snapshot.revision, configuration: parsed.data });
      setSnapshot(next);
      setNotice("Configuration saved. Runtime status shows whether the changes have been applied.");
      setLastSaveSucceeded(true);
      return true;
    } catch (cause) {
      setLastSaveSucceeded(false);
      if (cause instanceof ApiError && cause.status === 400) {
        setError(`${errorMessage(cause, "The configuration was rejected.")} Correct the configuration and save again. Your open editor has been preserved.`);
      } else {
        setError(`${errorMessage(cause, "The save result could not be confirmed.")} Refresh configuration before making another change. Your open editor has been preserved.`);
        setNeedsRefresh(true);
      }
      return false;
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  };
  const updateRuntime = (runtime: ConfigurationRuntimeState) => {
    // A read started before this command completed must not replace its newer outcome.
    readController.current?.abort();
    readInFlight.current = false;
    setLoading(false);
    setSnapshot((current) => current ? {
      ...current,
      runtimes: [...current.runtimes.filter((entry) => entry.resourceKind !== runtime.resourceKind || entry.resourceId !== runtime.resourceId), runtime],
    } : current);
  };
  return { snapshot, loading, saving, lastSaveSucceeded, error: error || refreshError, notice, needsRefresh: needsRefresh || connectionStale, refresh, refreshRuntime, save, updateRuntime };
}
