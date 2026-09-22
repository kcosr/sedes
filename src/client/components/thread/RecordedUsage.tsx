import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { UsageQueryCache } from "../../stores/UsageQueryCache.js";
import type { UsageReport, UsageSummary, UsageTokenKind } from "../../../shared/protocol/usage-accounting.js";

export function RecordedUsage({ cache, turnId, active = true }: { cache: UsageQueryCache; turnId: string | null; active?: boolean }): React.JSX.Element {
  const state = useSyncExternalStore(useCallback(listener => cache.subscribe(turnId, listener), [cache, turnId]),
    useCallback(() => cache.getSnapshot(turnId), [cache, turnId]));
  useEffect(() => active ? cache.activate(turnId) : undefined, [cache, turnId, active]);
  return <div className="recorded-usage">
    {state.loading && <p className="recorded-usage-note" role="status">Loading usage…</p>}
    {state.error && <p className="recorded-usage-note" role="status">{state.error}</p>}
    {state.missing && <p className="recorded-usage-note">No usage recorded for this turn</p>}
    {state.report && <UsageDetails report={state.report} />}
  </div>;
}

const labels: Record<UsageTokenKind, string> = {
  input: "Input", uncachedInput: "Uncached input", cacheRead: "Cached input",
  cacheWrite: "Cache write", output: "Output", reasoning: "Reasoning", total: "Total tokens", requests: "Requests",
};
const subsetFields = new Set<UsageTokenKind>(["cacheRead", "cacheWrite", "reasoning"]);

export function UsageDetails({ report }: { report: UsageReport }): React.JSX.Element {
  const { summary } = report;
  const conflict = Object.values(summary.metrics).some(metric => metric.quality === "conflict") || summary.costQuality === "conflict" || summary.reasons.some(reason => ["counter_regression", "conflicting_evidence", "ordering_unknown", "source_reset"].includes(reason));
  const partial = report.state === "partial" || report.captureState === "failed";
  const quality = conflict ? "Needs reconciliation" : report.turnState === "in_progress" ? "So far" : partial ? "Partial" : undefined;
  const scope = report.measurementScope === "main_loop" ? "Main agent only" : report.measurementScope === "partial_interval" ? "Recorded intervals" : undefined;
  const knownModels = [...new Set(summary.models.map(({ model, provider }) => model ?? provider).filter((value): value is string => value !== null))];
  if (report.support === "unsupported") return <p className="recorded-usage-note">Usage reporting is not supported</p>;
  return <>
    {(quality || report.inherited || scope) && <div className="recorded-usage-badges">
      {quality && <span className="recorded-usage-badge" title={conflict ? "The last valid counts are shown while conflicting usage is unresolved." : "Only recorded usage is included; totals may be incomplete."}>{quality}</span>}
      {report.inherited && <span className="recorded-usage-badge">Inherited</span>}
      {scope && <span className="recorded-usage-scope">{scope}</span>}
    </div>}
    {report.state === "unavailable" && <p className="recorded-usage-note">{report.turnId ? "No usage recorded for this turn" : "No usage recorded"}</p>}
    <UsageValues summary={summary} />
    {knownModels.length > 0 && <p className="recorded-usage-model" title="Observed model or provider">{knownModels.join(" · ")}</p>}
    {report.turnId === null && report.lastRecordedAt && <p className="recorded-usage-note">Recorded <time dateTime={report.lastRecordedAt}>{new Date(report.lastRecordedAt).toLocaleString()}</time></p>}
    {report.legacy && <section className="recorded-usage-legacy"><h4>Legacy usage</h4><p className="recorded-usage-note">Coverage unknown</p><UsageValues summary={report.legacy} />{report.legacyRecordedAt && <p className="recorded-usage-note">Recorded <time dateTime={report.legacyRecordedAt}>{new Date(report.legacyRecordedAt).toLocaleString()}</time></p>}</section>}
  </>;
}

function UsageValues({ summary }: { summary: UsageSummary }): React.JSX.Element {
  const keys: UsageTokenKind[] = ["input", "cacheRead", "cacheWrite", "output", "reasoning", "requests"];
  if (summary.metrics.input.value === null && summary.metrics.uncachedInput.value !== null) keys.splice(1, 0, "uncachedInput");
  if (summary.metrics.input.value === null && summary.metrics.output.value === null && summary.metrics.total.value !== null) keys.push("total");
  return <>
    <dl className="recorded-usage-values">{keys.filter(key => key === "input" || key === "output" || (summary.metrics[key].value !== null && summary.metrics[key].value !== "0")).map(key => {
      const metric = summary.metrics[key];
      const detail = metric.quality === "conflict" ? "Last valid count" : metric.quality === "partial" ? "Known subtotal" : undefined;
      return <div key={key} data-subset={subsetFields.has(key) || undefined}>
        <dt title={key === "input" ? "Includes cached input" : subsetFields.has(key) ? `Included in ${key === "reasoning" ? "output" : "input"}` : undefined}>{labels[key]}</dt>
        <dd title={detail}>{metric.value === null ? "—" : new Intl.NumberFormat().format(BigInt(metric.value))}</dd>
      </div>;
    })}</dl>
    {summary.costs.length === 0 ? <p className="recorded-usage-note recorded-usage-cost">Cost unavailable</p> : <dl className="recorded-usage-costs">{summary.costs.map((cost, index) => <div key={index}>
      <dt>{cost.kind === "estimated" ? "Estimated cost" : "Reported cost"}</dt>
      <dd title={`${cost.currency} · ${cost.provenance}${cost.quality === "partial" ? " · Known subtotal" : ""}`}>{cost.currency === "USD" ? `$${cost.amount}` : `${cost.amount} ${cost.currency}`}</dd>
    </div>)}</dl>}
  </>;
}
