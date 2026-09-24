import { Gauge } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApiClient } from "../api/ApiClient.js";
import { SIDEBAR_NAV_MEDIA_QUERY } from "./SidebarNavTrigger.js";
import { useMediaQuery } from "../app/use-media-query.js";
import { BackendBrandIcon } from "./brand-icons.js";
import type { BackendBrand } from "../../shared/index.js";
import type {
  ProviderPulseAccount,
  ProviderPulseBalance,
  ProviderPulseResetCredits,
  ProviderPulseStatus,
} from "../../shared/protocol/provider-pulse.js";
import { useProviderPulse } from "../provider-pulse/use-provider-pulse.js";
import {
  accountShortLabel,
  accountUsageSummary,
  accountsByUpcomingReset,
  baselineFor,
  expiryText,
  remainingPercent,
  relativeTime,
  resetText,
  resetDayLabel,
  snapshotNote,
  usageBand,
  weekElapsedDays,
} from "../provider-pulse/presentation.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@client/components/ui/dialog";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@client/components/ui/dropdown-menu";

export function useUsageSheetLayout(): boolean {
  const mobileLayout = useMediaQuery(SIDEBAR_NAV_MEDIA_QUERY);
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  return mobileLayout || coarsePointer;
}

export function SidebarUsageSheetItem({
  onOpen,
}: {
  readonly onOpen: () => void;
}): React.JSX.Element {
  return (
    <DropdownMenuItem onSelect={onOpen}>
      <Gauge aria-hidden="true" />
      Accounts
    </DropdownMenuItem>
  );
}

export function SidebarUsageSheet({
  api,
  open,
  onOpenChange,
}: {
  readonly api: ApiClient;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const pulse = useProviderPulse(api);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  useEffect(() => {
    if (open) void pulse.load();
    else {
      pulse.stop();
      setExpandedId(null);
    }
  }, [open, pulse.load, pulse.stop]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sidebar-usage-sheet"
        overlayClassName="sidebar-usage-sheet-overlay"
      >
        <DialogTitle>Accounts</DialogTitle>
        <DialogDescription className="sr-only">
          Remaining provider quota for configured provider accounts.
        </DialogDescription>
        <div className="sidebar-usage-sheet-body">
          <UsageList
            pulse={pulse}
            expandedId={expandedId}
            onToggle={(accountId) =>
              setExpandedId((current) =>
                current === accountId ? null : accountId,
              )
            }
            inline
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function SidebarUsageMenu({
  api,
}: {
  readonly api: ApiClient;
}): React.JSX.Element {
  const pulse = useProviderPulse(api);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <DropdownMenuSub
      onOpenChange={(open) => {
        if (open) void pulse.load();
        else {
          pulse.stop();
          setExpandedId(null);
        }
      }}
    >
      <DropdownMenuSubTrigger>
        <Gauge aria-hidden="true" />
        Accounts
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="sidebar-usage-menu"
        sideOffset={6}
        collisionPadding={8}
      >
        <UsageList
          pulse={pulse}
          expandedId={expandedId}
          onToggle={(accountId) =>
            setExpandedId((current) =>
              current === accountId ? null : accountId,
            )
          }
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function UsageList({
  pulse,
  expandedId,
  onToggle,
  inline = false,
}: {
  readonly pulse: ReturnType<typeof useProviderPulse>;
  readonly expandedId: string | null;
  readonly onToggle: (accountId: string) => void;
  readonly inline?: boolean;
}): React.JSX.Element {
  const accounts = accountsByUpcomingReset(pulse.status?.accounts ?? []);
  return (
    <>
      {inline ? null : <DropdownMenuLabel>Weekly remaining</DropdownMenuLabel>}
      {pulse.loading && !pulse.status ? (
        <div className="sidebar-usage-empty">Loading usage…</div>
      ) : pulse.error && !pulse.status ? (
        <div className="sidebar-usage-empty">{pulse.error}</div>
      ) : accounts.length === 0 ? (
        <div className="sidebar-usage-empty">No provider accounts.</div>
      ) : inline ? (
        accounts.map((account) => (
          <MobileAccountBlock
            key={account.id}
            account={account}
            status={pulse.status}
            expanded={expandedId === account.id}
            checking={pulse.checkingIds.has(account.id)}
            snapshotting={pulse.snapshotting}
            onToggle={() => onToggle(account.id)}
            onCheck={() => void pulse.checkAccount(account.id)}
            onSnapshot={() => void pulse.snapshot()}
          />
        ))
      ) : (
        accounts.map((account) => (
          <DesktopAccountSubmenu
            key={account.id}
            account={account}
            status={pulse.status}
            checking={pulse.checkingIds.has(account.id)}
            snapshotting={pulse.snapshotting}
            onCheck={() => void pulse.checkAccount(account.id)}
            onSnapshot={() => void pulse.snapshot()}
          />
        ))
      )}
      {inline ? (
        <div className="sidebar-usage-rule" />
      ) : (
        <DropdownMenuSeparator />
      )}
      {pulse.error && pulse.status ? (
        <div className="sidebar-usage-empty">{pulse.error}</div>
      ) : null}
      <UsageActions
        checkLabel={pulse.checkingIds.size > 0 ? "Checking…" : "Check"}
        snapshotLabel={pulse.snapshotting ? "Saving…" : "Snapshot"}
        checkDisabled={pulse.checkingIds.size > 0}
        snapshotDisabled={pulse.snapshotting}
        onCheck={() => void pulse.checkAll()}
        onSnapshot={() => void pulse.snapshot()}
        menu={!inline}
      />
    </>
  );
}

function DesktopAccountSubmenu({
  account,
  status,
  checking,
  snapshotting,
  onCheck,
  onSnapshot,
}: {
  readonly account: ProviderPulseAccount;
  readonly status: ProviderPulseStatus | undefined;
  readonly checking: boolean;
  readonly snapshotting: boolean;
  readonly onCheck: () => void;
  readonly onSnapshot: () => void;
}): React.JSX.Element {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="sidebar-usage-account">
        <ProviderMark provider={account.provider} brand={account.brand} />
        <span className="sidebar-usage-account-name">
          {accountShortLabel(account)}
        </span>
        <AccountUsageSummary account={account} />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="sidebar-usage-detail"
        sideOffset={6}
        collisionPadding={8}
      >
        <AccountDetail
          account={account}
          status={status}
          checking={checking}
          snapshotting={snapshotting}
          onCheck={onCheck}
          onSnapshot={onSnapshot}
          menuActions
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function MobileAccountBlock({
  account,
  status,
  expanded,
  checking,
  snapshotting,
  onToggle,
  onCheck,
  onSnapshot,
}: {
  readonly account: ProviderPulseAccount;
  readonly status: ProviderPulseStatus | undefined;
  readonly expanded: boolean;
  readonly checking: boolean;
  readonly snapshotting: boolean;
  readonly onToggle: () => void;
  readonly onCheck: () => void;
  readonly onSnapshot: () => void;
}): React.JSX.Element {
  return (
    <div className="sidebar-usage-mobile-account" data-open={expanded}>
      <button
        type="button"
        className="sidebar-usage-account-button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`usage-account-${account.id}`}
      >
        <ProviderMark provider={account.provider} brand={account.brand} />
        <span className="sidebar-usage-account-name">
          {accountShortLabel(account)}
        </span>
        <AccountUsageSummary account={account} />
      </button>
      <div id={`usage-account-${account.id}`} hidden={!expanded}>
        {expanded ? (
          <AccountDetail
            account={account}
            status={status}
            checking={checking}
            snapshotting={snapshotting}
            onCheck={onCheck}
            onSnapshot={onSnapshot}
          />
        ) : null}
      </div>
    </div>
  );
}

function AccountUsageSummary({
  account,
}: {
  readonly account: ProviderPulseAccount;
}): React.JSX.Element {
  const summary = accountUsageSummary(account);
  const dayLabel = resetDayLabel(summary.resetsAt);
  const fullReset = dayLabel ? resetText(summary.resetsAt) : undefined;
  const accessibleReset =
    dayLabel && fullReset ? `${dayLabel}; ${fullReset}` : undefined;
  return (
    <span className="sidebar-usage-summary">
      <span
        className="sidebar-usage-reset-day"
        aria-label={accessibleReset}
        title={fullReset}
      >
        {dayLabel ?? ""}
      </span>
      <span
        className="sidebar-usage-remaining"
        data-band={usageBand(summary.remainingPercent)}
      >
        {summary.remainingPercent === undefined
          ? "—"
          : `${Math.round(summary.remainingPercent)}%`}
      </span>
    </span>
  );
}

function AccountDetail({
  account,
  status,
  checking,
  snapshotting,
  onCheck,
  onSnapshot,
  menuActions = false,
}: {
  readonly account: ProviderPulseAccount;
  readonly status: ProviderPulseStatus | undefined;
  readonly checking: boolean;
  readonly snapshotting: boolean;
  readonly onCheck: () => void;
  readonly onSnapshot: () => void;
  readonly menuActions?: boolean;
}): React.JSX.Element {
  const windows = account.usage.snapshot?.windows ?? [];
  const balances = account.usage.snapshot?.balances ?? [];
  const resetCredits = account.usage.snapshot?.resetCredits;
  return (
    <div className="sidebar-usage-detail-body">
      <div className="sidebar-usage-detail-head">
        <div className="sidebar-usage-detail-title">
          <ProviderMark provider={account.provider} brand={account.brand} />
          {account.label}
        </div>
        <div className="sidebar-usage-detail-sub">
          Checked {relativeTime(account.usage.lastSuccessAt)}
          {account.usage.health === "stale" ? " · stale" : ""}
        </div>
      </div>
      {windows.length === 0 && balances.length === 0 && !resetCredits ? (
        <div className="sidebar-usage-empty">
          {checking ? "Checking provider usage…" : "Usage unavailable."}
        </div>
      ) : (
        <>
          {windows.map((window) => {
            const remaining = remainingPercent(window);
            const baseline = baselineFor(
              status?.usageBaseline.metrics ?? [],
              account.id,
              "window",
              window.id,
            );
            const elapsed = weekElapsedDays(window);
            const note = snapshotNote(remaining, baseline);
            return (
              <div key={window.id} className="sidebar-usage-window">
                <div className="sidebar-usage-window-line">
                  <span>{window.label}</span>
                  <span
                    className="sidebar-usage-remaining"
                    data-band={usageBand(remaining)}
                  >
                    {remaining === undefined
                      ? "Unavailable"
                      : `${Math.round(remaining)}% left`}
                  </span>
                </div>
                <div className="sidebar-usage-detail-sub">
                  {resetText(window.resetsAt)}
                </div>
                {remaining !== undefined ? (
                  <div
                    className="sidebar-usage-bar"
                    data-band={usageBand(remaining)}
                  >
                    <i style={{ width: `${remaining}%` }} />
                  </div>
                ) : null}
                {elapsed !== undefined ? (
                  <div className="sidebar-usage-week" aria-hidden="true">
                    {Array.from({ length: 7 }, (_, index) => {
                      const fill = Math.max(0, Math.min(1, elapsed - index));
                      return (
                        <span
                          key={index}
                          style={
                            {
                              "--day-progress": `${fill * 100}%`,
                            } as React.CSSProperties
                          }
                        />
                      );
                    })}
                  </div>
                ) : null}
                {note ? (
                  <div className="sidebar-usage-detail-sub">{note}</div>
                ) : null}
              </div>
            );
          })}
          {resetCredits ? (
            <ResetCreditsDetail resetCredits={resetCredits} />
          ) : null}
          {balances.map((balance) => (
            <BalanceDetail
              key={balance.id}
              accountId={account.id}
              balance={balance}
              status={status}
            />
          ))}
        </>
      )}
      <UsageActions
        checkLabel={checking || account.usage.inFlight ? "Checking…" : "Check"}
        snapshotLabel={snapshotting ? "Saving…" : "Snapshot"}
        checkDisabled={checking || account.usage.inFlight}
        snapshotDisabled={snapshotting}
        onCheck={onCheck}
        onSnapshot={onSnapshot}
        menu={menuActions}
      />
    </div>
  );
}

function ResetCreditsDetail({
  resetCredits,
}: {
  readonly resetCredits: ProviderPulseResetCredits;
}): React.JSX.Element {
  const expiry = expiryText(resetCredits.nextExpiresAt);
  return (
    <div className="sidebar-usage-window">
      <div className="sidebar-usage-window-line">
        <span>Banked resets</span>
        <span className="sidebar-usage-remaining">
          {resetCredits.availableCount}{" "}
          {resetCredits.availableCount === 1 ? "reset" : "resets"}
        </span>
      </div>
      {expiry ? (
        <div className="sidebar-usage-detail-sub">{expiry}</div>
      ) : null}
    </div>
  );
}

function BalanceDetail({
  accountId,
  balance,
  status,
}: {
  readonly accountId: string;
  readonly balance: ProviderPulseBalance;
  readonly status: ProviderPulseStatus | undefined;
}): React.JSX.Element {
  const remaining = balance.remainingPercent;
  const baseline = baselineFor(
    status?.usageBaseline.metrics ?? [],
    accountId,
    "balance",
    balance.id,
  );
  const note = snapshotNote(remaining, baseline);
  return (
    <div className="sidebar-usage-window">
      <div className="sidebar-usage-window-line">
        <span>{balance.label}</span>
        <span
          className="sidebar-usage-remaining"
          data-band={usageBand(remaining)}
        >
          {balanceValue(balance)}
        </span>
      </div>
      {balance.resetsAt ? (
        <div className="sidebar-usage-detail-sub">
          {resetText(balance.resetsAt)}
        </div>
      ) : null}
      {remaining !== undefined ? (
        <div className="sidebar-usage-bar" data-band={usageBand(remaining)}>
          <i style={{ width: `${remaining}%` }} />
        </div>
      ) : null}
      {balance.used || balance.limit ? (
        <div className="sidebar-usage-detail-sub">
          {[
            balance.used && `${balance.used} used`,
            balance.limit && `${balance.limit} limit`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      ) : null}
      {note ? <div className="sidebar-usage-detail-sub">{note}</div> : null}
    </div>
  );
}

function balanceValue(balance: ProviderPulseBalance): string {
  if (balance.unlimited) return "Unlimited";
  if (balance.remainingPercent !== undefined) {
    return `${Math.round(balance.remainingPercent)}% left`;
  }
  if (balance.amount !== undefined) {
    const amount = new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 2,
    }).format(balance.amount);
    return [balance.currency, amount, balance.unit].filter(Boolean).join(" ");
  }
  return "Unavailable";
}

function UsageActions({
  checkLabel,
  snapshotLabel,
  checkDisabled,
  snapshotDisabled,
  onCheck,
  onSnapshot,
  menu = false,
}: {
  readonly checkLabel: string;
  readonly snapshotLabel: string;
  readonly checkDisabled: boolean;
  readonly snapshotDisabled: boolean;
  readonly onCheck: () => void;
  readonly onSnapshot: () => void;
  readonly menu?: boolean;
}): React.JSX.Element {
  if (menu) {
    return (
      <div className="sidebar-usage-actions">
        <DropdownMenuItem
          className="sidebar-usage-action"
          disabled={checkDisabled}
          onSelect={(event) => {
            event.preventDefault();
            onCheck();
          }}
        >
          {checkLabel}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="sidebar-usage-action"
          disabled={snapshotDisabled}
          onSelect={(event) => {
            event.preventDefault();
            onSnapshot();
          }}
        >
          {snapshotLabel}
        </DropdownMenuItem>
      </div>
    );
  }
  return (
    <div className="sidebar-usage-actions">
      <button
        type="button"
        disabled={checkDisabled}
        onPointerDown={(event) => event.preventDefault()}
        onClick={onCheck}
      >
        {checkLabel}
      </button>
      <button
        type="button"
        disabled={snapshotDisabled}
        onPointerDown={(event) => event.preventDefault()}
        onClick={onSnapshot}
      >
        {snapshotLabel}
      </button>
    </div>
  );
}

function ProviderMark({
  provider,
  brand,
}: {
  readonly provider: string;
  readonly brand?: BackendBrand;
}): React.JSX.Element {
  if (brand) return <BackendBrandIcon brand={brand} size={15} />;
  return (
    <span className="sidebar-usage-letter">
      {provider.slice(0, 1).toUpperCase()}
    </span>
  );
}
