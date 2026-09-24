import type { UsageAnalyticsResponse } from "../../shared/protocol/usage-analytics.js";
import { ShareBar } from "./charts/ShareBar.js";
import { OTHER_COLOR, UNKNOWN_COLOR, seriesColor } from "./charts/chart-kit.js";
import { GRANULARITY_NOUN, formatCount, formatCountPrecise, formatWholePercent, toNumber } from "./usage-format.js";
import { UsageCard } from "./usage-ui.js";

function Meter({ label, share, detail }: { readonly label: string; readonly share: number | null; readonly detail: string }) {
  return (
    <div className="usage-meter">
      <div className="usage-meter-heading"><span>{label}</span><strong>{share === null ? "—" : formatWholePercent(share)}</strong></div>
      <span className="usage-meter-track" aria-hidden="true"><i style={{ width: `${Math.round((share ?? 0) * 100)}%` }} /></span>
      <p>{detail}</p>
    </div>
  );
}

export function UsageCoverage({ data }: { readonly data: UsageAnalyticsResponse }) {
  const tokens = toNumber(data.totals.tokens);
  const share = (unknown: number) => tokens > 0 ? Math.max(0, 1 - unknown / tokens) : null;
  const records = toNumber(data.totals.increments);
  const placement = data.placement;
  const period = GRANULARITY_NOUN[data.bucket];
  const coverage = data.coverage;
  return (
    <div className="usage-coverage">
      <UsageCard className="usage-card-wide" title="How each token's time is known"
        subtitle="Charts place usage only where its time is proven. Totals for the range include every recovered interval that fits inside it.">
        <ShareBar label="Time placement" segments={[
          { id: "reported", label: "Reported by the source", value: toNumber(placement.reported), color: seriesColor(0),
            display: formatCountPrecise(placement.reported), note: "Entries that carry their own timestamps, such as Pi messages." },
          { id: "observed", label: "Observed live", value: toNumber(placement.observed), color: seriesColor(2),
            display: formatCountPrecise(placement.observed), note: "Cumulative counters received while Sedes stayed attached." },
          { id: "interval", label: "Recovered within one " + period, value: toNumber(placement.interval), color: seriesColor(3),
            display: formatCountPrecise(placement.interval), note: `Counted after a capture gap; the whole gap fits one ${period}.` },
          { id: "spanning", label: "Recovered across " + period + "s", value: toNumber(placement.spanning), color: OTHER_COLOR,
            display: formatCountPrecise(placement.spanning), note: "In the range totals, but not drawn; a coarser granularity may place it." },
        ]} />
        {toNumber(placement.straddling) > 0 ? (
          <p className="usage-footnote">
            {formatCountPrecise(placement.straddling)} tokens recovered in this range began before it. They count in neither the range totals nor the chart; a wider range includes them.
          </p>
        ) : null}
        {toNumber(placement.unplaced) > 0 ? (
          <p className="usage-footnote">
            <i className="usage-key" style={{ background: UNKNOWN_COLOR }} aria-hidden="true" />
            {formatCountPrecise(placement.unplaced)} tokens were already on a session's counter when Sedes began capturing it. They count in session totals but belong to no time range.
          </p>
        ) : null}
      </UsageCard>

      <div className="usage-two-column">
        <UsageCard title="Attribution" subtitle="Share of tokens in this range with each detail recorded.">
          <div className="usage-meters">
            <Meter label="Estimated cost" share={share(toNumber(data.totals.uncostedTokens))}
              detail={toNumber(data.totals.uncostedTokens) > 0 ? `${formatCount(data.totals.uncostedTokens)} tokens have no cost estimate. Codex does not report cost, and Sedes does not price usage itself.` : "Every token in range has a source estimate."} />
            <Meter label="Model" share={share(toNumber(coverage.modelUnknownTokens))}
              detail="Reported by the source, or the provider-confirmed model while capture stayed continuous." />
            <Meter label="Reasoning effort" share={share(toNumber(coverage.effortUnknownTokens))}
              detail="The effort or thinking level in effect when the usage was recorded. Older records have none." />
            <Meter label="Cache breakdown" share={records > 0 ? 1 - toNumber(data.totals.missing.cacheRead) / records : null}
              detail="Records that report how much input came from the provider's cache." />
          </div>
        </UsageCard>
        <UsageCard title="Thread accounting" subtitle="Threads with usage in this range.">
          <dl className="usage-quality">
            <div><dt>Threads with usage</dt><dd>{formatCount(coverage.threads)}</dd></div>
            <div><dt>Partial accounting</dt><dd>{formatCount(coverage.partialThreads)}</dd>
              <p>Capture gaps or unproven baselines. Recorded values are real; some work may be missing.</p></div>
            <div><dt>Needs reconciliation</dt><dd>{formatCount(coverage.conflictThreads)}</dd>
              <p>Conflicting or regressing counters. The last valid checkpoint is kept.</p></div>
            <div><dt>Usage not reported</dt><dd>{formatCount(coverage.unsupportedThreads)}</dd>
              <p>Active Grok threads. Grok does not report usage, so it appears nowhere on this page.</p></div>
          </dl>
        </UsageCard>
      </div>

      <UsageCard className="usage-card-wide" title="About these numbers">
        <ul className="usage-notes">
          <li><strong>Tokens</strong> are input plus output. Cache reads and writes are part of input, and reasoning is part of output, so the parts are never added again.</li>
          <li><strong>Cost</strong> comes from provider or SDK estimates. It is not an invoice and says nothing about subscription billing.</li>
          <li>Missing values stay unknown. A dash or an unknown row never means zero.</li>
          <li>Subagent usage belongs to its session, not to the turn that launched it. Forked threads do not count copied history again.</li>
          <li>Usage is recorded on the Sedes server. Work done while Sedes was not attached appears only when a later checkpoint recovers it.</li>
        </ul>
      </UsageCard>
    </div>
  );
}
