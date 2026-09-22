import { RecordedUsage } from "./RecordedUsage.js";
import type { UsageQueryCache } from "../../stores/UsageQueryCache.js";
import * as Dialog from "@radix-ui/react-dialog";
import type {
  NormalizedThreadExecutionWorkspace,
  NormalizedThreadSavedAgentOrigin,
  UsageSnapshot,
} from "../../../shared/index.js";
import { Copy, X } from "lucide-react";
import { Button } from "@client/components/ui/button";

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
  /**
   * Radix returns dialog focus to `Dialog.Trigger`; this dialog is controlled
   * (opened from a menu row that unmounts with its menu), so without an
   * explicit target closing drops focus to `<body>`.
   */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="dialog-overlay"
          data-testid="dialog-overlay"
        />
        <Dialog.Content
          className="dialog-card session-stats-dialog"
          aria-describedby="session-stats-description"
          onCloseAutoFocus={(event) => {
            const target = returnFocusRef?.current;
            if (!target?.isConnected) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <Dialog.Title>Session stats</Dialog.Title>
          <Dialog.Description id="session-stats-description">
            Session identifiers, recorded usage, and live context.
          </Dialog.Description>
          <Dialog.Close asChild>
            <Button
              variant="ghost"
              size="icon"
              className="dialog-close"
              aria-label="Close"
            >
              <X size={18} strokeWidth={1.8} />
            </Button>
          </Dialog.Close>
          <section
            className="session-identifiers"
            aria-labelledby="session-identifiers-title"
          >
            <h3 id="session-identifiers-title">Identifiers</h3>
            <IdentifierRow label="Sedes thread ID" value={sedesThreadId} />
            {backendSessionId && (
              <IdentifierRow
                label="Backend session ID"
                value={backendSessionId}
              />
            )}
          </section>
          {createdWithAgent && (
            <section
              className="session-identifiers"
              aria-labelledby="session-origin-title"
            >
              <h3 id="session-origin-title">Origin</h3>
              <div className="session-identifier-row">
                <span className="session-identifier-label">Created with</span>
                <span className="session-origin-value">
                  {createdWithAgent.name.text} · revision{" "}
                  {createdWithAgent.revision}
                  {createdWithAgent.available ? "" : " (deleted)"}
                </span>
              </div>
            </section>
          )}
          {executionWorkspace.kind === "isolated" && (
            <section
              className="session-identifiers"
              aria-labelledby="session-workspace-paths-title"
            >
              <h3 id="session-workspace-paths-title">Isolated workspace</h3>
              <IdentifierRow
                label={`${environmentKind === "local" ? "Local" : environmentKind === "ssh" ? "SSH" : "Outbound"} host home path`}
                value={executionWorkspace.hostPaths.home}
              />
              <IdentifierRow
                label={`${environmentKind === "local" ? "Local" : environmentKind === "ssh" ? "SSH" : "Outbound"} host workspace path`}
                value={executionWorkspace.hostPaths.workspace}
              />
            </section>
          )}
          <section className="session-recorded-usage"><h3>Recorded session usage</h3>
            {open && <RecordedUsage cache={usageCache} turnId={null} />}
          </section>
          <section><h3>Live context and transcript</h3>
            {liveAvailable ? <StatsGrid usage={usage} /> : <p>Live context and transcript counters are unavailable while disconnected.</p>}
          </section>
          <div className="dialog-actions">
            <Dialog.Close asChild>
              <Button variant="secondary">Close</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
        size="sm"
        className="session-identifier-copy"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void copyIdentifier(value);
        }}
      >
        <Copy size={13} aria-hidden="true" />
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
      <h3>{title}</h3>
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
