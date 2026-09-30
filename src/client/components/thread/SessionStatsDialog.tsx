import { useSyncExternalStore } from "react";
import { RecordedUsage } from "./RecordedUsage.js";
import type { UsageQueryCache } from "../../stores/UsageQueryCache.js";
import type {
  NormalizedThreadExecutionWorkspace,
  NormalizedThreadSavedAgentOrigin,
  UsageSnapshot,
} from "../../../shared/index.js";
import { Copy } from "lucide-react";
import { Button } from "@client/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogSection,
  DialogTitle,
} from "@client/components/ui/dialog";
import { Tag } from "@client/components/ui/tag";

export function SessionStatsDialog({
  open,
  onOpenChange,
  sedesThreadId,
  backendSessionId,
  createdWithAgent,
  executionWorkspace,
  environmentKind,
  usage,
  usageCache,
  liveAvailable = true,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sedesThreadId: string;
  backendSessionId?: string;
  createdWithAgent?: NormalizedThreadSavedAgentOrigin;
  executionWorkspace: NormalizedThreadExecutionWorkspace;
  environmentKind: "local" | "ssh" | "outbound";
  usage: UsageSnapshot;
  usageCache: UsageQueryCache;
  liveAvailable?: boolean;
  /** Focus target on close; the opening menu row unmounts with its menu. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const usageEnabled = useSyncExternalStore(usageCache.subscribeEnabled, usageCache.getEnabled);
  const hostKind =
    environmentKind === "local"
      ? "Local"
      : environmentKind === "ssh"
        ? "SSH"
        : "Outbound";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        layer="over-dialog"
        returnFocusRef={returnFocusRef}
      >
        <DialogHeader>
          <DialogTitle>Session stats</DialogTitle>
          <DialogDescription>
            Session identifiers, recorded usage, and live context.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <DialogSection title="Identifiers">
            <div className="session-stats-card">
              <IdentifierRow label="Sedes thread ID" value={sedesThreadId} />
              {backendSessionId && (
                <IdentifierRow
                  label="Backend session ID"
                  value={backendSessionId}
                />
              )}
            </div>
          </DialogSection>
          {createdWithAgent && (
            <DialogSection title="Origin">
              <div className="session-stats-card">
                <div className="session-identifier-row">
                  <span className="session-identifier-label">
                    Created with
                  </span>
                  <span className="session-origin-value">
                    {createdWithAgent.name.text} · revision{" "}
                    {createdWithAgent.revision}
                    {createdWithAgent.available ? "" : " (deleted)"}
                  </span>
                </div>
              </div>
            </DialogSection>
          )}
          {executionWorkspace.kind === "isolated" && (
            <DialogSection title="Isolated workspace">
              <div className="session-stats-card">
                <IdentifierRow
                  label={`${hostKind} host home path`}
                  value={executionWorkspace.hostPaths.home}
                />
                <IdentifierRow
                  label={`${hostKind} host workspace path`}
                  value={executionWorkspace.hostPaths.workspace}
                />
              </div>
            </DialogSection>
          )}
          {usageEnabled && (
            <DialogSection
              title={
                <>
                  Recorded session usage <Tag>Experimental</Tag>
                </>
              }
            >
              <div className="session-stats-card session-recorded-usage">
                {open && <RecordedUsage cache={usageCache} turnId={null} />}
              </div>
            </DialogSection>
          )}
          <DialogSection title="Live context and transcript">
            {liveAvailable ? (
              <StatsGrid usage={usage} />
            ) : (
              <p className="session-stats-empty">
                Live context and transcript counters are unavailable while
                disconnected.
              </p>
            )}
          </DialogSection>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function IdentifierRow({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div className="session-identifier-row">
      <span className="session-identifier-label">{label}</span>
      <code>{value}</code>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void copyIdentifier(value);
        }}
      >
        <Copy aria-hidden="true" />
        Copy
      </Button>
    </div>
  );
}

async function copyIdentifier(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Direct HTTP browser contexts may expose Clipboard but reject its use.
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  try {
    document.execCommand?.("copy");
  } finally {
    input.remove();
  }
}

function StatsGrid({ usage }: { usage: UsageSnapshot }): React.JSX.Element {
  const counters = usage.counters;
  const hasCounters =
    counters !== undefined && Object.values(counters).some(isReported);
  const hasTools =
    isReported(counters?.toolCalls) ||
    isReported(counters?.toolResults) ||
    isReported(counters?.compactions);
  const hasMessages =
    isReported(counters?.totalMessages) ||
    isReported(counters?.userMessages) ||
    isReported(counters?.assistantMessages);
  const hasUsage = usage.context !== undefined;
  const contextPercent =
    usage.context?.percent ??
    (usage.context?.usedTokens === undefined || usage.context.windowTokens === 0
      ? undefined
      : (usage.context.usedTokens / usage.context.windowTokens) * 100);
  if (!hasCounters && !hasUsage) {
    return (
      <p className="session-stats-empty">
        Live context and transcript counters are unavailable.
      </p>
    );
  }
  return (
    <div className="session-stats-grid">
      {hasMessages && (
        <StatGroup title="Messages">
          <OptionalStat label="Total" value={counters?.totalMessages} />
          <OptionalStat label="You" value={counters?.userMessages} />
          <OptionalStat label="Assistant" value={counters?.assistantMessages} />
        </StatGroup>
      )}
      {hasTools && (
        <StatGroup title="Tools">
          <OptionalStat label="Calls" value={counters?.toolCalls} />
          <OptionalStat label="Results" value={counters?.toolResults} />
          <OptionalStat label="Compactions" value={counters?.compactions} />
        </StatGroup>
      )}
      {hasUsage && (
        <StatGroup title="Usage">
          {usage.context && (
            <Stat
              label="Context"
              value={`${number(usage.context.usedTokens)} / ${number(
                usage.context.windowTokens,
              )}`}
            />
          )}
          {contextPercent !== undefined && (
            <Stat
              label="Context used"
              value={`${contextPercent.toFixed(2)}%`}
            />
          )}
        </StatGroup>
      )}
    </div>
  );
}

function StatGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="session-stat-group" data-testid="session-stat-group">
      <h4>{title}</h4>
      <dl>{children}</dl>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function OptionalStat({
  label,
  value,
}: {
  label: string;
  value: number | undefined;
}): React.JSX.Element | null {
  return value === undefined ? null : (
    <Stat label={label} value={number(value)} />
  );
}

function isReported(value: number | undefined): value is number {
  return value !== undefined;
}

function number(value: number | undefined): string {
  return value === undefined
    ? "Unavailable"
    : new Intl.NumberFormat().format(value);
}
