import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { UsageQueryCache } from "../../stores/UsageQueryCache.js";
import type { UsageReport, UsageSummary, UsageTokenKind } from "../../../shared/protocol/usage-accounting.js";

export function RecordedUsage({ cache, turnId, active = true }: { cache: UsageQueryCache; turnId: string | null; active?: boolean }): React.JSX.Element {
  const state = useSyncExternalStore(useCallback(listener => cache.subscribe(turnId, listener), [cache, turnId]),
    useCallback(() => cache.getSnapshot(turnId), [cache, turnId]));
  useEffect(() => active ? cache.activate(turnId) : undefined, [cache, turnId, active]);
  return <div className="recorded-usage">
    {state.loading && <p role="status">Loading recorded usage…</p>}
    {state.error && <p role="status">{state.error}</p>}
    {state.missing && <p>No usage recorded for this turn</p>}
    {state.report && <UsageDetails report={state.report} />}
  </div>;
}
const labels: Record<UsageTokenKind, string> = {
  input: "Input (including cache)", uncachedInput: "Uncached input", cacheRead: "Cache read (input subset)",
  cacheWrite: "Cache write (input subset)", output: "Output", reasoning: "Reasoning (output subset)", total: "Reported total", requests: "Requests",
};
export function UsageDetails({ report }: { report: UsageReport }): React.JSX.Element {
  const { summary } = report;
  const conflict = summary.reasons.some(reason => ["counter_regression", "conflicting_evidence", "ordering_unknown", "source_reset"].includes(reason));
  const sdkNormalized = Object.values(summary.metrics).some(metric => metric.basis.includes("sdk_normalized"));
  return <>
    {report.inherited && <p>Inherited turn</p>}
    {report.support === "unsupported" && <p>Usage reporting is not supported</p>}
    {report.state === "unavailable" && report.support !== "unsupported" && <p>{report.turnId ? "No usage recorded for this turn" : "No usage recorded"}</p>}
    {report.captureState === "failed" && <p>Usage capture failed; recorded values may be incomplete.</p>}
    {report.turnState === "in_progress" && <p>Recorded so far</p>}
    {conflict ? <p>Usage reconciliation incomplete</p> : report.state === "partial" && <p>Usage may be incomplete</p>}
    {report.measurementScope === "main_loop" && <p>Main-loop usage only</p>}
    {report.measurementScope === "partial_interval" && <p>Recorded intervals only</p>}
    {sdkNormalized && <p title="The SDK normalizes these counts. Original provider-field presence is unknown.">SDK-normalized · original provider-field presence unknown</p>}
    <UsageValues summary={summary} />
    {summary.models.length > 0 && <p>Model / provider: {summary.models.map(({ model, provider }) => `${model ?? "Unknown model"} / ${provider ?? "Unknown provider"}`).join("; ")}</p>}
    {summary.reasons.includes("model_coverage_unknown") && <p>Model attribution may be incomplete.</p>}
    {summary.reasons.includes("child_coverage_unknown") && <p>Child-agent usage coverage is unknown.</p>}
    {report.lastRecordedAt && <p>Last recorded: <time dateTime={report.lastRecordedAt}>{new Date(report.lastRecordedAt).toLocaleString()}</time></p>}
    {report.legacy && <section><h4>Legacy usage — coverage unknown</h4><UsageValues summary={report.legacy} /></section>}
  </>;
}
function UsageValues({ summary }: { summary: UsageSummary }): React.JSX.Element {
  return <>
    <dl className="recorded-usage-values">{Object.entries(summary.metrics).filter(([key, metric]) => metric.value !== null || key === "input" || key === "output").map(([key, metric]) => <div key={key}>
      <dt>{labels[key as UsageTokenKind]}</dt><dd>{metric.value === null ? "—" : new Intl.NumberFormat().format(BigInt(metric.value))}{metric.quality === "partial" ? " (known subtotal)" : metric.quality === "conflict" ? " (last valid)" : ""}</dd>
    </div>)}</dl>
    {summary.costs.length === 0 ? <p>Cost unavailable</p> : <>
      {summary.costs.map((cost, index) => <p key={index} title={cost.provenance}>{cost.kind === "estimated" ? "Estimated cost" : "Reported cost"}: {cost.amount} {cost.currency}{cost.quality === "partial" ? " (known subtotal)" : ""}</p>)}
      <p>Billing status unknown</p>
      {summary.costQuality !== "complete" && <p>Some cost data is unavailable.</p>}
    </>}
  </>;
}
