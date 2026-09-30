import "./settings.css";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { useId } from "react";
import { navigate, settingsPath } from "../../app/router.js";
import type { SettingsPage } from "../../app/settings-route.js";
import {
  groupSettingsEntries,
  type SettingsEntry,
  type SettingsPageEntry,
} from "./settings-pages.js";
import { requestSettingsPageReselect } from "./settings-navigation.js";

/** A plain left click that the app should route itself. */
export function isPlainClick(event: React.MouseEvent<HTMLElement>): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function settingsEntryHref(entry: SettingsEntry): string {
  return entry.kind === "page" ? settingsPath(entry.id) : entry.href;
}

/**
 * Opens a settings entry: another page pushes its route; the page already
 * shown (at its root) asks the page to return to its start instead of
 * stacking a duplicate history entry.
 */
export function openSettingsEntry(entry: SettingsEntry): void {
  const href = settingsEntryHref(entry);
  if (entry.kind === "page" && window.location.pathname === href) {
    requestSettingsPageReselect(entry.id);
    return;
  }
  navigate(href);
}

/**
 * The settings category nav in the desktop sidebar slot: a return row, then
 * the pages by group. Rows reuse the sidebar's thread-row anatomy.
 */
export function SettingsNav({
  pages,
  page,
  returnLabel,
  onReturn,
  ref,
}: {
  readonly pages: readonly SettingsPageEntry[];
  readonly page?: SettingsPage;
  readonly returnLabel: string;
  readonly onReturn: () => void;
  readonly ref?: React.Ref<HTMLElement>;
}): React.JSX.Element {
  const id = useId();
  const groups = groupSettingsEntries(pages);
  return (
    <nav
      ref={ref}
      data-slot="settings-nav"
      data-testid="settings-nav"
      aria-label="Settings pages"
    >
      <div data-slot="settings-nav-header">
        <button
          type="button"
          data-slot="settings-nav-link"
          data-variant="return"
          data-testid="settings-return"
          onClick={onReturn}
        >
          <ArrowLeft aria-hidden="true" />
          <span>{returnLabel}</span>
        </button>
      </div>
      <div data-slot="settings-nav-scroll">
        <h2 data-slot="settings-nav-title">Settings</h2>
        {groups.map((group) => (
          <div
            key={group.id}
            data-slot="settings-nav-group"
            role="group"
            aria-labelledby={`${id}${group.id}`}
          >
            <h3 id={`${id}${group.id}`} data-slot="settings-nav-group-label">
              {group.label}
            </h3>
            <ul data-slot="settings-nav-list">
              {group.entries.map((entry) => {
                const Icon = entry.icon;
                const current = entry.kind === "page" && entry.id === page;
                return (
                  <li key={entry.id}>
                    <a
                      data-slot="settings-nav-link"
                      data-testid={entry.kind === "page" ? "settings-page" : "settings-link"}
                      data-page={entry.id}
                      href={settingsEntryHref(entry)}
                      aria-current={current ? "page" : undefined}
                      onClick={(event) => {
                        if (!isPlainClick(event)) return;
                        event.preventDefault();
                        openSettingsEntry(entry);
                      }}
                    >
                      <Icon aria-hidden="true" />
                      <span>{entry.label}</span>
                      {entry.kind === "link" ? (
                        <ArrowUpRight
                          aria-hidden="true"
                          data-slot="settings-nav-external"
                        />
                      ) : null}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
