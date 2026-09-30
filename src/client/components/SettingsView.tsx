import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { AuthenticationSettings, useAuthenticationControls } from "../authentication/AuthenticationSettings.js";
import { NotificationSettingsPage } from "./NotificationSettingsPage.js";
import type { NotificationSettingsStore } from "../stores/NotificationSettingsStore.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ArrowLeft, ChevronLeft } from "lucide-react";
import { Button } from "@client/components/ui/button";
import { navigate, navigateUp, settingsPath, useRoute } from "../app/router.js";
import { isSettingsResourcePage, type SettingsPage } from "../app/settings-route.js";
import { SidebarNavTrigger } from "./SidebarNavTrigger.js";
import type { ServerSettingsControls } from "./ServerSettingsForm.js";
import {
  ToolClientsSettingsPage,
  type ToolClientSettingsControls,
} from "./tool-clients/ToolClientsSettingsPage.js";
import { CannedPromptsSettingsPage } from "./CannedPromptsSettingsPage.js";
import type { CannedPromptClientStore } from "../stores/CannedPromptClientStore.js";
import {
  ElectronConnectionSettings,
  type ElectronConnectionSettingsControls,
} from "./ElectronConnectionSettings.js";
import { ExecutionSettings } from "./execution-settings/ExecutionSettings.js";
import { ProjectsSettingsPage } from "./execution-settings/ProjectsSettingsPage.js";
import type { HostPairingControls } from "./execution-settings/useHostPairings.js";
import type { ConfigurationControls } from "./execution-settings/useConfiguration.js";
import { EntityList, EntityRow } from "./settings/EntityList.js";
import { SettingsPage as SettingsPageLayout } from "./settings/SettingsPage.js";
import { SettingsSection } from "./settings/SettingsSection.js";
import { isPlainClick, openSettingsEntry, settingsEntryHref } from "./settings/SettingsNav.js";
import {
  availableSettingsPages,
  groupSettingsEntries,
  type SettingsEntry,
  type SettingsPageEntry,
} from "./settings/settings-pages.js";
import {
  installSettingsPageReselectListener,
  readLastSettingsPage,
  rememberSettingsPage,
  settingsLandingRedirect,
  useSettingsNavInSidebar,
} from "./settings/settings-navigation.js";
import { useSettingsEscape } from "./settings/settings-escape.js";
import { AppearanceSettingsPage } from "./settings/pages/AppearanceSettingsPage.js";
import { DiagnosticsSettingsPage } from "./settings/pages/DiagnosticsSettingsPage.js";
import {
  GeneralSettingsPage,
  type ApplicationPreferenceControls,
} from "./settings/pages/GeneralSettingsPage.js";
import { MobileSettingsPage } from "./settings/pages/MobileSettingsPage.js";
import { ServerSettingsPage } from "./settings/pages/ServerSettingsPage.js";
import { TerminalSettingsPage } from "./settings/pages/TerminalSettingsPage.js";

/** The controls a client holds; each page needs some of them. */
export interface SettingsSources {
  readonly applicationStore?: ApplicationClientStore;
  readonly serverSettings?: ServerSettingsControls;
  readonly applicationPreferences?: ApplicationPreferenceControls;
  readonly cannedPrompts?: CannedPromptClientStore;
  readonly notifications?: NotificationSettingsStore;
  readonly toolClients?: ToolClientSettingsControls;
  readonly electronConnectionSettings?: ElectronConnectionSettingsControls;
  readonly configuration?: ConfigurationControls & HostPairingControls;
}

/** The settings pages this client can show, in nav order. */
export function useSettingsPages(sources: SettingsSources): SettingsPageEntry[] {
  const pairedClients = Boolean(useAuthenticationControls());
  const prompts = Boolean(sources.cannedPrompts);
  const notifications = Boolean(sources.notifications);
  const execution = Boolean(sources.configuration);
  const projects = Boolean(sources.applicationStore);
  const toolClients = Boolean(sources.toolClients);
  const electronConnection = Boolean(sources.electronConnectionSettings);
  const serverProfiles = Boolean(sources.serverSettings);
  return useMemo(
    () => availableSettingsPages({
      prompts, notifications, execution, projects, toolClients, pairedClients, electronConnection, serverProfiles,
    }),
    [prompts, notifications, execution, projects, toolClients, pairedClients, electronConnection, serverProfiles],
  );
}

/**
 * Routed settings surface. Preference ownership remains with each existing
 * store. With the desktop sidebar visible, the category nav lives in the
 * sidebar slot (ApplicationShell) and `/settings` opens a page; otherwise
 * `/settings` is the grouped list and each page links back to it.
 */
export function SettingsView({
  page,
  onReturn,
  returnLabel = "Back to workspace",
  ...sources
}: SettingsSources & {
  page?: SettingsPage;
  onReturn: () => void;
  returnLabel?: string;
}): React.JSX.Element {
  const {
    applicationStore,
    serverSettings,
    applicationPreferences,
    cannedPrompts,
    notifications,
    toolClients,
    electronConnectionSettings,
    configuration,
  } = sources;
  const pages = useSettingsPages(sources);
  const navInSidebar = useSettingsNavInSidebar();
  const route = useRoute();
  // Escape goes up a level, to the same places as the "‹" links and the return control.
  useSettingsEscape({ location: route.name === "settings" ? route : { page }, navInSidebar, onReturn });
  const content = useRef<HTMLElement>(null);
  const available = page === undefined || pages.some(entry => entry.id === page);
  const pageIds = pages.map(entry => entry.id).join(" ");
  useLayoutEffect(() => {
    if (!available) {
      navigate(settingsPath(), { replace: true });
      return;
    }
    if (page !== undefined) return;
    const target = settingsLandingRedirect({
      navInSidebar,
      lastPage: readLastSettingsPage(),
      available: pageIds.split(" ") as SettingsPage[],
    });
    if (target) navigate(settingsPath(target), { replace: true });
  }, [available, page, navInSidebar, pageIds]);
  useEffect(() => {
    if (page !== undefined && available) rememberSettingsPage(page);
  }, [page, available]);
  const focusPageStart = useCallback(() => {
    content.current?.scrollTo?.({ top: 0 });
    const heading = content.current?.querySelector<HTMLElement>("h1, h2, h3");
    if (heading) heading.tabIndex = -1;
    (heading ?? content.current)?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    // Environments and Backends route their own selection, scroll and focus.
    if (!available || isSettingsResourcePage(page)) return;
    if (page !== undefined || !navInSidebar) focusPageStart();
    // Only a page change moves focus; the nav moving in or out does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, available, focusPageStart]);
  // The nav link of the page already shown, at its root, returns it to its
  // start. From one of its entities the link is a route to the list instead.
  useEffect(() => installSettingsPageReselectListener(window, (selected) => {
    if (selected === page) focusPageStart();
  }), [page, focusPageStart]);
  const current = pages.find(entry => entry.id === page);
  const showList = (page === undefined || !available) && !navInSidebar;
  return (
    <main className="settings-view" data-testid="settings-view" data-page={page ?? "home"}
      data-nav={navInSidebar ? "sidebar" : "compact"} aria-label="Settings">
      {navInSidebar ? null : (
        <header className="settings-view-header">
          <SidebarNavTrigger />
          {current ? (
            <a className="settings-view-back" href={settingsPath()} data-testid="settings-list-link"
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                // Back through the page (and its entities) to the list when
                // opened from it, so the link and Back walk the same history.
                navigateUp(settingsPath());
              }}>
              <ChevronLeft aria-hidden="true" />Settings
            </a>
          ) : (
            <Button variant="ghost" className="settings-view-back" data-testid="settings-return" onClick={onReturn}>
              <ArrowLeft aria-hidden="true" />{returnLabel}
            </Button>
          )}
        </header>
      )}
      <section ref={content} className="settings-content" tabIndex={-1} aria-label={current?.label ?? "Settings"}>
        {showList ? <SettingsHome pages={pages} onOpen={openSettingsEntry} /> : null}
        {page === "general" ? (
          <GeneralSettingsPage applicationPreferences={applicationPreferences} />
        ) : page === "diagnostics" ? (
          <DiagnosticsSettingsPage applicationStore={applicationStore} />
        ) : page === "appearance" ? (
          <AppearanceSettingsPage />
        ) : page === "prompts" && cannedPrompts ? (
          <CannedPromptsSettingsPage store={cannedPrompts} />
        ) : page === "notifications" && notifications ? (
          <NotificationSettingsPage store={notifications} />
        ) : page === "mobile" ? (
          <MobileSettingsPage />
        ) : page === "terminal" ? (
          <TerminalSettingsPage />
        ) : page === "projects" && applicationStore ? (
          <ProjectsSettingsPage store={applicationStore} />
        ) : page === "tool_clients" && toolClients ? (
          <ToolClientsSettingsPage controls={toolClients} />
        ) : page === "paired_clients" ? (
          <AuthenticationSettings />
        ) : page === "connection" && electronConnectionSettings ? (
          <ElectronConnectionSettings
            controls={electronConnectionSettings}
            onSwitched={onReturn}
          />
        ) : page === "server" && available && serverSettings ? (
          <ServerSettingsPage controls={serverSettings} />
        ) : null}
        {configuration ? <div hidden={!isSettingsResourcePage(page)}>
          <ExecutionSettings controls={configuration} />
        </div> : null}
      </section>
    </main>
  );
}

/** `/settings` without the sidebar nav: every page by group, with what it holds. */
function SettingsHome({
  pages,
  onOpen,
}: {
  readonly pages: readonly SettingsPageEntry[];
  readonly onOpen: (entry: SettingsEntry) => void;
}): React.JSX.Element {
  return (
    <SettingsPageLayout title="Settings" description="Preferences for this device, your account, where agents run, and access.">
      {groupSettingsEntries(pages).map((group) => (
        <SettingsSection key={group.id} title={group.label} card>
          <EntityList>
            {group.entries.map((entry) => {
              const Icon = entry.icon;
              return (
                <EntityRow
                  key={entry.id}
                  data-testid={entry.kind === "page" ? "settings-page" : "settings-link"}
                  data-page={entry.id}
                  icon={<Icon />}
                  title={entry.label}
                  subtitle={entry.description}
                  href={settingsEntryHref(entry)}
                  chevron
                  onSelect={(event) => {
                    if (!isPlainClick(event)) return;
                    event.preventDefault();
                    onOpen(entry);
                  }}
                />
              );
            })}
          </EntityList>
        </SettingsSection>
      ))}
    </SettingsPageLayout>
  );
}
