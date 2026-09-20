import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { AuthenticationSettings, useAuthenticationControls } from "../authentication/AuthenticationSettings.js";
import { NotificationSettingsPage } from "./NotificationSettingsPage.js";
import type { NotificationSettingsStore } from "../stores/NotificationSettingsStore.js";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowLeft,
  Activity,
  ChevronRight,
  Bell,
  Server,
  Cable,
  KeyRound,
  MessageSquareText,
  SlidersHorizontal,
  Smartphone,
  SquareTerminal,
  SunMoon,
  Network,
  Boxes,
  Folder,
} from "lucide-react";
import { SEDES_VERSION } from "../../shared/version.js";
import { getAppearance, setAppearance } from "../app/appearance.js";
import {
  DEFAULT_ENVIRONMENT_TINT_SETTINGS,
  ENVIRONMENT_PALETTE_OPTIONS,
  ENVIRONMENT_TINT_COVERAGE_RANGE,
  ENVIRONMENT_TINT_FADE_IN_RANGE,
  ENVIRONMENT_TINT_INTENSITY_RANGE,
  getEnvironmentColorsEnabled,
  getEnvironmentPalette,
  getEnvironmentTintSettings,
  setEnvironmentColorsEnabled,
  setEnvironmentPalette,
  setEnvironmentTintSettings,
  subscribeEnvironmentColorsEnabled,
  subscribeEnvironmentPalette,
  subscribeEnvironmentTintSettings,
  type EnvironmentPaletteId,
  type EnvironmentTintSettings,
} from "../app/environment-palette.js";
import {
  getClickNamesToFilter,
  setClickNamesToFilter,
  subscribeClickNamesToFilter,
  getActivityDetail,
  getChatAtmosphereEnabled,
  getHistoryPageSize,
  getDiagnosticCategoryEnabled,
  getMobileComposerRefocusAfterSend,
  getMobileHistorySeekControl,
  getPanelPresentation,
  getRightOptionFocusesComposer,
  getSeekOnSubmit,
  getSmoothStreamingEnabled,
  getTerminalPreferences,
  getConfirmTerminalTermination,
  HISTORY_PAGE_SIZE_OPTIONS,
  setActivityDetail,
  setChatAtmosphereEnabled,
  setHistoryPageSize,
  setDiagnosticCategoryEnabled,
  setMobileComposerRefocusAfterSend,
  setMobileHistorySeekControl,
  setPanelPresentation,
  setRightOptionFocusesComposer,
  setSeekOnSubmit,
  setSmoothStreamingEnabled,
  setTerminalPreferences,
  setConfirmTerminalTermination,
  subscribeActivityDetail,
  subscribeChatAtmosphereEnabled,
  subscribeHistoryPageSize,
  subscribeDiagnosticCategoryEnabled,
  subscribeMobileComposerRefocusAfterSend,
  subscribeMobileHistorySeekControl,
  subscribePanelPresentation,
  subscribeRightOptionFocusesComposer,
  subscribeSeekOnSubmit,
  subscribeSmoothStreamingEnabled,
  subscribeTerminalPreferences,
  subscribeConfirmTerminalTermination,
  TERMINAL_MAXIMUM_FONT_SIZE,
  TERMINAL_MINIMUM_FONT_SIZE,
} from "../app/settings.js";
import type { PanelPresentation } from "../workspace-panels/panel-presentation.js";
import type { ActivityDetailMode } from "../../shared/protocol/conversation.js";
import {
  clearDiagnostics,
  copyDiagnostics,
  readDiagnostics,
} from "../app/diagnostics.js";
import type { Appearance } from "../types.js";
import type {
  ApplicationPreferences,
  UpdateApplicationPreferencesRequest,
} from "../../shared/protocol/application-preferences.js";
import { Button } from "@client/components/ui/button";
import { Checkbox } from "@client/components/ui/checkbox";
import { installNavigationBlocker, navigate, settingsPath } from "../app/router.js";
import type { SettingsPage } from "../app/settings-route.js";
import { SidebarNavTrigger } from "./SidebarNavTrigger.js";
import { Label } from "@client/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@client/components/ui/radio-group";
import {
  ServerSettingsForm,
  type ServerSettingsControls,
} from "./ServerSettingsForm.js";
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
import { ExecutionSettings, type ExecutionSettingsNavigation } from "./execution-settings/ExecutionSettings.js";
import { ProjectsSettingsPage } from "./execution-settings/ProjectsSettingsPage.js";
import type { HostPairingControls } from "./execution-settings/useHostPairings.js";
import type { ConfigurationControls } from "./execution-settings/useConfiguration.js";

export interface ApplicationPreferenceControls {
  read(): Promise<ApplicationPreferences>;
  update(
    request: UpdateApplicationPreferencesRequest,
  ): Promise<ApplicationPreferences>;
}

const commonPages: ReadonlyArray<{
  readonly id: SettingsPage;
  readonly label: string;
  readonly icon: React.ComponentType<{ size?: number | string }>;
}> = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "appearance", label: "Appearance", icon: SunMoon },
  { id: "mobile", label: "Mobile", icon: Smartphone },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
];

/** Routed settings surface. Preference ownership remains with each existing store. */
export function SettingsView({
  page,
  onReturn,
  returnLabel = "Back to workspace",
  serverSettings,
  applicationPreferences,
  cannedPrompts,
  notifications,
  toolClients,
  electronConnectionSettings,
  configuration,
  applicationStore,
}: {
  applicationStore?: ApplicationClientStore;
  page?: SettingsPage;
  onReturn: () => void;
  returnLabel?: string;
  serverSettings?: ServerSettingsControls;
  applicationPreferences?: ApplicationPreferenceControls;
  cannedPrompts?: CannedPromptClientStore;
  notifications?: NotificationSettingsStore;
  toolClients?: ToolClientSettingsControls;
  electronConnectionSettings?: ElectronConnectionSettingsControls;
  configuration?: ConfigurationControls & HostPairingControls;
}): React.JSX.Element {
  const hasCannedPrompts = Boolean(cannedPrompts);
  const executionNavigation = useRef<ExecutionSettingsNavigation>(null);
  const hasToolClients = Boolean(toolClients);
  const authentication = useAuthenticationControls();
  const hasElectronConnectionSettings = Boolean(electronConnectionSettings);
  const hasServerSettings =
    Boolean(serverSettings) && !hasElectronConnectionSettings;
  const pages = [
    ...commonPages.slice(0, 2),
    ...(hasCannedPrompts
      ? [
          {
            id: "prompts" as const,
            label: "Prompts",
            icon: MessageSquareText,
          },
        ]
      : []),
    ...(notifications
      ? [{ id: "notifications" as const, label: "Notifications", icon: Bell }]
      : []),
    ...commonPages.slice(2),
    ...(configuration ? [
      { id: "environments" as const, label: "Environments", icon: Network },
      { id: "backends" as const, label: "Backends", icon: Boxes },
    ] : []),
    ...(applicationStore ? [{ id: "projects" as const, label: "Projects", icon: Folder }] : []),
    ...(hasToolClients
      ? [
          {
            id: "tool_clients" as const,
            label: "Tool clients",
            icon: KeyRound,
          },
        ]
      : []),
    ...(authentication ? [{ id: "paired_clients" as const, label: "Paired clients", icon: KeyRound }] : []),
    ...(hasElectronConnectionSettings
      ? [{ id: "connection" as const, label: "Connection", icon: Cable }]
      : []),
    ...(hasServerSettings
      ? [{ id: "server" as const, label: "Server", icon: Server }]
      : []),
    { id: "diagnostics" as const, label: "Diagnostics", icon: Activity },
  ];
  const content = useRef<HTMLElement>(null);
  const internalPageChange = useRef<SettingsPage | undefined>(undefined);
  const internalNavigation = useRef(false);
  const available = page === undefined || pages.some(entry => entry.id === page);
  useEffect(() => {
    if (!available) navigate(settingsPath(), { replace: true });
  }, [available]);
  useEffect(() => installNavigationBlocker((_current, _next, proceed) => {
    const execution = executionNavigation.current;
    // Internal execution navigation has already passed its draft guard.
    if (internalNavigation.current || !execution?.blocksNavigation()) return true;
    execution.requestLeave(proceed);
    return false;
  }), []);
  useEffect(() => {
    if (!available) return;
    const internal = internalPageChange.current === page;
    internalPageChange.current = undefined;
    if (page === "environments" || page === "backends") {
      if (!internal) executionNavigation.current?.openPage(page);
    } else {
      content.current?.scrollTo?.({ top: 0 });
      const heading = content.current?.querySelector<HTMLElement>("h1, h2, h3");
      if (heading) heading.tabIndex = -1;
      (heading ?? content.current)?.focus({ preventScroll: true });
    }
  }, [page, available]);
  const selectPage = (next?: SettingsPage) => {
    if (next === page) {
      if (next === "environments" || next === "backends") executionNavigation.current?.openPage(next);
      return;
    }
    navigate(settingsPath(next));
  };
  const currentLabel = pages.find(entry => entry.id === page)?.label;
  return (
    <main className="settings-view" data-testid="settings-view" data-page={page ?? "home"} aria-label="Settings">
      <header className="settings-view-header">
        <SidebarNavTrigger />
        <Button variant="ghost" className="settings-return" data-testid="settings-return" onClick={onReturn}>
          <ArrowLeft size={16} aria-hidden="true" />{returnLabel}
        </Button>
        <span className="settings-view-heading">Settings</span>
        <select className="settings-category-picker" aria-label="Settings category" value={available ? page ?? "" : ""}
          onChange={event => selectPage(event.target.value ? event.target.value as SettingsPage : undefined)}>
          <option value="">All settings</option>
          {pages.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select>
      </header>
      <div className="settings-view-body">
        <nav className="settings-nav" aria-label="Settings pages">
          <button type="button" className="settings-page-link" data-active={page === undefined ? "true" : "false"}
            aria-current={page === undefined ? "page" : undefined} onClick={() => selectPage()}>All settings</button>
          <div className="settings-nav-pages">
            {pages.map(({ id, label, icon: Icon }) => (
              <button key={id} type="button" aria-current={page === id ? "page" : undefined}
                className="settings-page-link" data-testid="settings-page" data-page={id}
                data-active={page === id ? "true" : "false"} onClick={() => selectPage(id)}>
                <Icon size={16} />{label}
              </button>
            ))}
          </div>
        </nav>
        <section ref={content} className="settings-content" tabIndex={-1} aria-label={currentLabel ?? "All settings"}>
          <div className="settings-page-body">
          {page === undefined || !available ? <>
            <h1 className="settings-home-title" tabIndex={-1}>Settings</h1>
            <p className="settings-home-description">Manage your workspace, connections, and preferences.</p>
            <div className="settings-category-list">
              {pages.map(({ id, label, icon: Icon }) => <button key={id} type="button" onClick={() => selectPage(id)}>
                <Icon size={20} aria-hidden="true" /><span>{label}</span><ChevronRight size={16} aria-hidden="true" />
              </button>)}
            </div>
          </> : null}
          {page === "general" ? (
            <GeneralPage applicationPreferences={applicationPreferences} />
          ) : page === "diagnostics" ? (
            <DiagnosticsPage applicationStore={applicationStore} />
          ) : page === "appearance" ? (
            <AppearancePage />
          ) : page === "prompts" && cannedPrompts ? (
            <CannedPromptsSettingsPage store={cannedPrompts} />
          ) : page === "notifications" && notifications ? (
            <NotificationSettingsPage store={notifications} />
          ) : page === "mobile" ? (
            <MobilePage />
          ) : page === "terminal" ? (
            <TerminalPage />
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
          ) : page === "server" && hasServerSettings && serverSettings ? (
            <ServerPage controls={serverSettings} />
          ) : null}
          {configuration ? <div hidden={page !== "environments" && page !== "backends"}>
            <ExecutionSettings controls={configuration} initialPage={page === "backends" ? "backends" : "environments"}
              visible={page === "environments" || page === "backends"}
              navigationRef={executionNavigation} onPageChange={next => {
                if (next === page) return;
                internalPageChange.current = next;
                internalNavigation.current = true;
                try { navigate(settingsPath(next)); }
                finally { internalNavigation.current = false; }
                if (window.location.pathname !== settingsPath(next)) internalPageChange.current = undefined;
              }} />
          </div> : null}
          </div>
        </section>
      </div>
    </main>
  );
}

function MobilePage(): React.JSX.Element {
  const [refocusAfterSend, setRefocusAfterSendState] = useState(
    getMobileComposerRefocusAfterSend,
  );
  useEffect(
    () => subscribeMobileComposerRefocusAfterSend(setRefocusAfterSendState),
    [],
  );
  const [historySeekControl, setHistorySeekControlState] = useState(
    getMobileHistorySeekControl,
  );
  useEffect(
    () => subscribeMobileHistorySeekControl(setHistorySeekControlState),
    [],
  );
  return (
    <>
      <h3 className="settings-page-title" tabIndex={-1}>Mobile</h3>
      <div className="settings-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-mobile-composer-refocus-after-send"
            className="settings-row-label"
          >
            Refocus composer after sending
          </Label>
          <p
            id="setting-mobile-composer-refocus-after-send-description"
            className="settings-row-description"
          >
            After Send, Queue, or Steer on a mobile layout, return focus to the
            message field so the on-screen keyboard remains available.
          </p>
        </div>
        <Checkbox
          id="setting-mobile-composer-refocus-after-send"
          data-testid="mobile-composer-refocus-after-send-toggle"
          aria-describedby="setting-mobile-composer-refocus-after-send-description"
          checked={refocusAfterSend}
          onCheckedChange={(checked) => {
            const next = checked === true;
            setRefocusAfterSendState(next);
            setMobileComposerRefocusAfterSend(next);
          }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-mobile-history-seek-control"
            className="settings-row-label"
          >
            Show history seek control
          </Label>
          <p
            id="setting-mobile-history-seek-control-description"
            className="settings-row-description"
          >
            Show the draggable history control beside the conversation on mobile
            layouts.
          </p>
        </div>
        <Checkbox
          id="setting-mobile-history-seek-control"
          data-testid="mobile-history-seek-control-toggle"
          aria-describedby="setting-mobile-history-seek-control-description"
          checked={historySeekControl}
          onCheckedChange={(checked) => {
            const next = checked === true;
            setHistorySeekControlState(next);
            setMobileHistorySeekControl(next);
          }}
        />
      </div>
    </>
  );
}

function TerminalPage(): React.JSX.Element {
  const [confirmTermination, setConfirmTerminationState] = useState(
    getConfirmTerminalTermination,
  );
  useEffect(
    () => subscribeConfirmTerminalTermination(setConfirmTerminationState),
    [],
  );
  const [preferences, setPreferencesState] = useState(getTerminalPreferences);
  useEffect(() => subscribeTerminalPreferences(setPreferencesState), []);
  const fontSizes = Array.from(
    { length: TERMINAL_MAXIMUM_FONT_SIZE - TERMINAL_MINIMUM_FONT_SIZE + 1 },
    (_, index) => TERMINAL_MINIMUM_FONT_SIZE + index,
  );
  const scrollbackOptions = [
    1_000, 2_000, 4_000, 8_000, 12_000, 16_000, 20_000,
  ];
  return (
    <>
      <h3 className="settings-page-title" tabIndex={-1}>Terminal</h3>
      <div className="settings-row">
        <div className="settings-row-text">
          <Label htmlFor="setting-terminal-cursor-blink" className="settings-row-label">
            Cursor blink
          </Label>
          <p id="setting-terminal-cursor-blink-description" className="settings-row-description">
            Blink the cursor in the Codex TUI and regular terminals. Off by default
            on Windows to reduce idle rendering. Applies to this client only.
          </p>
        </div>
        <Checkbox id="setting-terminal-cursor-blink" data-testid="terminal-cursor-blink-toggle"
          aria-describedby="setting-terminal-cursor-blink-description"
          checked={preferences.cursorBlink}
          onCheckedChange={(checked) => setTerminalPreferences({ ...preferences, cursorBlink: checked === true })}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-confirm-terminal-termination"
            className="settings-row-label"
          >
            Confirm before ending active terminals
          </Label>
          <p
            id="setting-confirm-terminal-termination-description"
            className="settings-row-description"
          >
            Ask whether to close the tab or end an active terminal. When off,
            the tab’s X ends local terminals or disconnects remote terminals and
            removes their history immediately. Remote processes may continue running.
            Ended terminals are always removed without confirmation. Applies to
            this client only.
          </p>
        </div>
        <Checkbox
          id="setting-confirm-terminal-termination"
          data-testid="confirm-terminal-termination-toggle"
          aria-describedby="setting-confirm-terminal-termination-description"
          checked={confirmTermination}
          onCheckedChange={(checked) => {
            setConfirmTerminalTermination(checked === true);
          }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-terminal-font-size"
            className="settings-row-label"
          >
            Font size
          </Label>
          <p className="settings-row-description">
            Text size for the TUI and managed terminals on this browser.
          </p>
        </div>
        <select
          id="setting-terminal-font-size"
          data-testid="terminal-font-size-setting"
          className="settings-native-select"
          value={preferences.fontSize}
          onChange={(event) => {
            const next = {
              ...preferences,
              fontSize: Number(event.target.value),
            };
            setTerminalPreferences(next);
          }}
        >
          {fontSizes.map((fontSize) => (
            <option value={fontSize} key={fontSize}>
              {fontSize} px
            </option>
          ))}
        </select>
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-terminal-scrollback"
            className="settings-row-label"
          >
            Scrollback
          </Label>
          <p className="settings-row-description">
            Maximum terminal lines retained in this browser’s memory.
          </p>
        </div>
        <select
          id="setting-terminal-scrollback"
          data-testid="terminal-scrollback-setting"
          className="settings-native-select"
          value={preferences.scrollback}
          onChange={(event) => {
            const next = {
              ...preferences,
              scrollback: Number(event.target.value),
            };
            setTerminalPreferences(next);
          }}
        >
          {scrollbackOptions.map((lines) => (
            <option value={lines} key={lines}>
              {lines.toLocaleString()} lines
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

function ServerPage({
  controls,
}: {
  controls: ServerSettingsControls;
}): React.JSX.Element {
  return (
    <>
      <h3 className="settings-page-title" tabIndex={-1}>Server</h3>
      <ServerSettingsForm controls={controls} />
    </>
  );
}

function GeneralPage({
  applicationPreferences,
}: {
  applicationPreferences?: ApplicationPreferenceControls;
}): React.JSX.Element {
  const clickNamesToFilter = useSyncExternalStore(
    subscribeClickNamesToFilter,
    getClickNamesToFilter,
  );
  const [activityDetail, setActivityDetailState] =
    useState<ActivityDetailMode>(getActivityDetail);
  const [historyPageSize, setHistoryPageSizeState] =
    useState(getHistoryPageSize);
  const [seekOnSubmit, setSeekOnSubmitState] = useState(getSeekOnSubmit);
  const [panelPresentation, setPanelPresentationState] =
    useState(getPanelPresentation);
  const [rightOptionFocusesComposer, setRightOptionFocusesComposerState] =
    useState(getRightOptionFocusesComposer);
  useEffect(() => subscribeSeekOnSubmit(setSeekOnSubmitState), []);
  useEffect(() => subscribePanelPresentation(setPanelPresentationState), []);
  useEffect(
    () =>
      subscribeRightOptionFocusesComposer(setRightOptionFocusesComposerState),
    [],
  );
  useEffect(() => subscribeHistoryPageSize(setHistoryPageSizeState), []);
  useEffect(() => subscribeActivityDetail(setActivityDetailState), []);
  return (
    <>
      <h3 className="settings-page-title" tabIndex={-1}>General</h3>
      <div className="settings-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-click-names-to-filter"
            className="settings-row-label"
          >
            Click project and environment names to filter
          </Label>
          <p
            id="click-names-to-filter-description"
            className="settings-row-description"
          >
            Make project and environment names on sidebar thread cards clickable.
            Click or tap a name to filter the thread list.
          </p>
        </div>
        <Checkbox
          id="setting-click-names-to-filter"
          aria-describedby="click-names-to-filter-description"
          checked={clickNamesToFilter}
          onCheckedChange={(value) => setClickNamesToFilter(value === true)}
        />
      </div>
      {applicationPreferences ? (
        <OpenAIComposerSkillPreference controls={applicationPreferences} />
      ) : null}
      <div className="settings-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-panel-presentation"
            className="settings-row-label"
          >
            Opening panels
          </Label>
          <p
            id="setting-panel-presentation-description"
            className="settings-row-description"
          >
            Choose whether Chat, Files, and Terminal replace the workbench or
            open together. Hold Shift while opening to use the other behavior
            once. Narrow layouts always use the full workbench; this setting
            applies when there is room to show panels together.
          </p>
        </div>
        <select
          id="setting-panel-presentation"
          data-testid="panel-presentation-setting"
          className="settings-native-select"
          aria-describedby="setting-panel-presentation-description"
          value={panelPresentation}
          onChange={(event) =>
            setPanelPresentation(event.target.value as PanelPresentation)
          }
        >
          <option value="split">Open together</option>
          <option value="single">Replace the workbench</option>
        </select>
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-activity-detail"
            className="settings-row-label"
          >
            Activity detail
          </Label>
          <p
            id="setting-activity-detail-description"
            className="settings-row-description"
          >
            Summaries show activity counts, status, elapsed time, and explicit
            provider reasoning summaries when available. The server omits
            detailed reasoning, tool inputs, and tool output before sending the
            conversation to this browser, reducing transfer size.
          </p>
        </div>
        <select
          id="setting-activity-detail"
          data-testid="activity-detail-setting"
          className="settings-native-select"
          aria-describedby="setting-activity-detail-description"
          value={activityDetail}
          onChange={(event) => {
            const next = event.target.value as ActivityDetailMode;
            setActivityDetailState(next);
            setActivityDetail(next);
          }}
        >
          <option value="full">Detailed activity</option>
          <option value="summary">Activity summaries</option>
        </select>
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-right-option-focuses-composer"
            className="settings-row-label"
          >
            Right Option focuses composer
          </Label>
          <p
            id="setting-right-option-focuses-composer-description"
            className="settings-row-description"
          >
            Press the physical right Option or Alt key to focus the chat
            composer before dictation. Off by default because right Alt types
            AltGr characters on some keyboard layouts.
          </p>
        </div>
        <Checkbox
          id="setting-right-option-focuses-composer"
          data-testid="right-option-focuses-composer-toggle"
          aria-describedby="setting-right-option-focuses-composer-description"
          checked={rightOptionFocusesComposer}
          onCheckedChange={(checked) => {
            const next = checked === true;
            setRightOptionFocusesComposerState(next);
            setRightOptionFocusesComposer(next);
          }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-history-page-size"
            className="settings-row-label"
          >
            Earlier messages
          </Label>
          <p className="settings-row-description">
            Number of earlier conversation turns loaded at a time on this
            browser.
          </p>
        </div>
        <select
          id="setting-history-page-size"
          data-testid="history-page-size-setting"
          className="settings-native-select"
          value={historyPageSize}
          onChange={(event) =>
            setHistoryPageSize(
              Number(event.target.value) as 5 | 10 | 25 | 50 | 100,
            )
          }
        >
          {HISTORY_PAGE_SIZE_OPTIONS.map((turns) => (
            <option value={turns} key={turns}>
              {turns} turns
            </option>
          ))}
        </select>
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-seek-on-submit"
            className="settings-row-label"
          >
            Seek on send
          </Label>
          <p
            id="setting-seek-on-submit-description"
            className="settings-row-description"
          >
            After you send a message, it stays pinned at the top while the reply
            streams. The reserved space remains until you scroll the last
            message to the composer or send again.
          </p>
        </div>
        <Checkbox
          id="setting-seek-on-submit"
          data-testid="seek-on-submit-toggle"
          aria-describedby="setting-seek-on-submit-description"
          checked={seekOnSubmit}
          onCheckedChange={(checked) => {
            const next = checked === true;
            setSeekOnSubmitState(next);
            setSeekOnSubmit(next);
          }}
        />
      </div>
    </>
  );
}

function DiagnosticsPage({
  applicationStore,
}: {
  applicationStore?: ApplicationClientStore;
}): React.JSX.Element {
  const [seekDiagnostics, setSeekDiagnosticsState] = useState(() =>
    getDiagnosticCategoryEnabled("seek"),
  );
  const [composerInputDiagnostics, setComposerInputDiagnosticsState] =
    useState(() => getDiagnosticCategoryEnabled("composer_input"));
  const [streamingDiagnostics, setStreamingDiagnosticsState] = useState(() =>
    getDiagnosticCategoryEnabled("streaming"),
  );
  const [threadLoadDiagnostics, setThreadLoadDiagnosticsState] = useState(() =>
    getDiagnosticCategoryEnabled("thread_load"),
  );
  const [diagnosticStatus, setDiagnosticStatus] = useState("");
  useEffect(
    () => subscribeDiagnosticCategoryEnabled("seek", setSeekDiagnosticsState),
    [],
  );
  useEffect(
    () =>
      subscribeDiagnosticCategoryEnabled(
        "composer_input",
        setComposerInputDiagnosticsState,
      ),
    [],
  );
  useEffect(
    () =>
      subscribeDiagnosticCategoryEnabled(
        "streaming",
        setStreamingDiagnosticsState,
      ),
    [],
  );
  useEffect(
    () =>
      subscribeDiagnosticCategoryEnabled(
        "thread_load",
        setThreadLoadDiagnosticsState,
      ),
    [],
  );
  const diagnosticCount = readDiagnostics().length;
  return (
    <>
      <h3 className="settings-page-title" tabIndex={-1}>Diagnostics</h3>
      <div className="settings-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-composer-input-diagnostics"
            className="settings-row-label"
          >
            Composer input diagnostics
          </Label>
          <p
            id="setting-composer-input-diagnostics-description"
            className="settings-row-description"
          >
            Record keyboard, dictation, focus, and send timing without message
            text. Enable it when investigating text reappearing after sending.
          </p>
        </div>
        <Checkbox
          id="setting-composer-input-diagnostics"
          data-testid="composer-input-diagnostics-toggle"
          aria-describedby="setting-composer-input-diagnostics-description"
          checked={composerInputDiagnostics}
          onCheckedChange={(checked) => {
            const next = checked === true;
            setDiagnosticStatus("");
            setComposerInputDiagnosticsState(next);
            setDiagnosticCategoryEnabled("composer_input", next);
          }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-streaming-diagnostics"
            className="settings-row-label"
          >
            Streaming diagnostics
          </Label>
          <p
            id="setting-streaming-diagnostics-description"
            className="settings-row-description"
          >
            Record content-free SSE arrival gaps, the running-turn batch timer
            and apply duration, text commits, and delayed animation frames.
            Enable it only for one reproduction of uneven streaming.
          </p>
        </div>
        <Checkbox
          id="setting-streaming-diagnostics"
          data-testid="streaming-diagnostics-toggle"
          aria-describedby="setting-streaming-diagnostics-description"
          checked={streamingDiagnostics}
          onCheckedChange={(checked) => {
            const next = checked === true;
            setDiagnosticStatus("");
            setStreamingDiagnosticsState(next);
            setDiagnosticCategoryEnabled("streaming", next);
          }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-thread-load-diagnostics"
            className="settings-row-label"
          >
            Thread loading diagnostics
          </Label>
          <p
            id="setting-thread-load-diagnostics-description"
            className="settings-row-description"
          >
            Time an accepted thread navigation through server runtime acquire,
            snapshot transfer and parsing, store validation, React commit, and a
            post-paint frame. The trace contains counts and timings, never
            conversation content or provider identifiers.
          </p>
        </div>
        <Checkbox
          id="setting-thread-load-diagnostics"
          data-testid="thread-load-diagnostics-toggle"
          aria-describedby="setting-thread-load-diagnostics-description"
          checked={threadLoadDiagnostics}
          onCheckedChange={(checked) => {
            const next = checked === true;
            setDiagnosticStatus("");
            setThreadLoadDiagnosticsState(next);
            setDiagnosticCategoryEnabled("thread_load", next);
          }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-seek-diagnostics"
            className="settings-row-label"
          >
            Seek diagnostics
          </Label>
          <p
            id="setting-seek-diagnostics-description"
            className="settings-row-description"
          >
            Record the bounded geometry and lifecycle trace for seek-on-send.
            This category can stay off while thread loading is measured.
          </p>
        </div>
        <Checkbox
          id="setting-seek-diagnostics"
          data-testid="seek-diagnostics-toggle"
          aria-describedby="setting-seek-diagnostics-description"
          checked={seekDiagnostics}
          onCheckedChange={(checked) => {
            const next = checked === true;
            setDiagnosticStatus("");
            setSeekDiagnosticsState(next);
            setDiagnosticCategoryEnabled("seek", next);
          }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label">Diagnostics buffer</span>
          <p className="settings-row-description">
            Clear the shared browser-local buffer, reproduce the issue, then
            copy it here. It retains at most 1,200 entries.
          </p>
        </div>
        <div className="settings-diagnostic-controls">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={diagnosticCount === 0}
            onClick={() => {
              clearDiagnostics();
              setDiagnosticStatus("Copy buffer cleared.");
            }}
          >
            Clear copy buffer
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={diagnosticCount === 0}
            onClick={() => {
              void copyDiagnostics()
                .then(() => setDiagnosticStatus("Log copied."))
                .catch(() =>
                  setDiagnosticStatus(
                    "Copy failed. Try copying the log again.",
                  ),
                );
            }}
          >
            Copy log ({diagnosticCount})
          </Button>
          {diagnosticStatus && (
            <span className="settings-diagnostic-status" role="status">
              {diagnosticStatus}
            </span>
          )}
        </div>
      </div>
      <SedesVersionRow applicationStore={applicationStore} />
    </>
  );
}

/**
 * The build identity to quote in a bug report. The server version is shown only
 * when it differs from this client's, so a same-build install stays quiet.
 */
function SedesVersionRow({
  applicationStore,
}: {
  applicationStore?: ApplicationClientStore;
}): React.JSX.Element {
  const serverVersion = useSyncExternalStore(
    useCallback(
      (listener: () => void) => applicationStore?.subscribe(listener) ?? noop,
      [applicationStore],
    ),
    () => applicationStore?.getSnapshot().serverVersion,
  );
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-row-label">Version</span>
        <p className="settings-row-description" data-testid="sedes-version">
          Sedes {SEDES_VERSION}
          {serverVersion && serverVersion !== SEDES_VERSION
            ? ` · server Sedes ${serverVersion}`
            : ""}
        </p>
      </div>
    </div>
  );
}

function noop(): void {}

function OpenAIComposerSkillPreference({
  controls,
}: {
  controls: ApplicationPreferenceControls;
}): React.JSX.Element {
  const [preferences, setPreferences] = useState<ApplicationPreferences>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      setPreferences(await controls.read());
    } catch {
      setError("Could not load this account preference.");
    }
  }, [controls]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <Label
          htmlFor="setting-show-openai-composer-skills"
          className="settings-row-label"
        >
          Show OpenAI skills in composer
        </Label>
        <p
          id="setting-show-openai-composer-skills-description"
          className="settings-row-description"
        >
          Show OpenAI Templates, Sites, and Visualize skills across every Codex
          connection for this account.
        </p>
        {error ? (
          <p className="settings-row-description" role="alert">
            {error}{" "}
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={() => void load()}
            >
              Retry
            </Button>
          </p>
        ) : null}
      </div>
      <Checkbox
        id="setting-show-openai-composer-skills"
        data-testid="show-openai-composer-skills-toggle"
        aria-describedby="setting-show-openai-composer-skills-description"
        checked={preferences?.showOpenAIComposerSkills ?? false}
        disabled={!preferences || saving}
        onCheckedChange={(checked) => {
          if (!preferences || saving) return;
          const previous = preferences;
          const showOpenAIComposerSkills = checked === true;
          setPreferences({ ...previous, showOpenAIComposerSkills });
          setSaving(true);
          setError("");
          void controls
            .update({
              showOpenAIComposerSkills,
              expectedRevision: previous.revision,
            })
            .then(setPreferences)
            .catch(() => {
              setPreferences(previous);
              setError("Could not save this account preference.");
            })
            .finally(() => setSaving(false));
        }}
      />
    </div>
  );
}

function AppearancePage(): React.JSX.Element {
  const [appearance, setAppearanceState] = useState<Appearance>(getAppearance);
  const [environmentColorsEnabled, setEnvironmentColorsEnabledState] = useState(
    getEnvironmentColorsEnabled,
  );
  const [environmentPalette, setEnvironmentPaletteState] =
    useState<EnvironmentPaletteId>(getEnvironmentPalette);
  const [environmentTintSettings, setEnvironmentTintSettingsState] =
    useState<EnvironmentTintSettings>(getEnvironmentTintSettings);
  const [smoothStreaming, setSmoothStreamingState] = useState(
    getSmoothStreamingEnabled,
  );
  const [chatAtmosphere, setChatAtmosphereState] = useState(
    getChatAtmosphereEnabled,
  );
  useEffect(() => {
    const onChange = () => setAppearanceState(getAppearance());
    window.addEventListener("appearance-change", onChange);
    return () => window.removeEventListener("appearance-change", onChange);
  }, []);
  useEffect(() => subscribeEnvironmentPalette(setEnvironmentPaletteState), []);
  useEffect(
    () => subscribeEnvironmentColorsEnabled(setEnvironmentColorsEnabledState),
    [],
  );
  useEffect(
    () => subscribeEnvironmentTintSettings(setEnvironmentTintSettingsState),
    [],
  );
  useEffect(() => subscribeSmoothStreamingEnabled(setSmoothStreamingState), []);
  useEffect(() => subscribeChatAtmosphereEnabled(setChatAtmosphereState), []);
  return (
    <>
      <h3 className="settings-page-title" tabIndex={-1}>Appearance</h3>
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label">Theme</span>
          <p
            id="setting-appearance-description"
            className="settings-row-description"
          >
            Follow the system appearance, or force light or dark.
          </p>
        </div>
        <RadioGroup
          className="settings-radio-group"
          value={appearance}
          aria-label="Theme"
          aria-describedby="setting-appearance-description"
          onValueChange={(next) => {
            const value = next as Appearance;
            setAppearanceState(value);
            setAppearance(value);
          }}
        >
          {(
            [
              ["system", "System"],
              ["light", "Light"],
              ["dark", "Dark"],
            ] as const
          ).map(([value, label]) => (
            <div className="settings-radio-option" key={value}>
              <RadioGroupItem
                value={value}
                id={`setting-appearance-${value}`}
              />
              <Label htmlFor={`setting-appearance-${value}`}>{label}</Label>
            </div>
          ))}
        </RadioGroup>
      </div>
      <div className="settings-row settings-environment-colors-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-environment-colors-enabled"
            className="settings-row-label"
          >
            Environment colors
          </Label>
          <p
            id="setting-environment-colors-description"
            className="settings-row-description"
          >
            Choose the palette and visibility used to distinguish execution
            environments. Colors are evenly distributed from the complete
            configured environment list without storing individual assignments.
          </p>
        </div>
        <Checkbox
          id="setting-environment-colors-enabled"
          data-testid="environment-colors-enabled-toggle"
          aria-describedby="setting-environment-colors-description"
          checked={environmentColorsEnabled}
          onCheckedChange={(checked) => {
            const enabled = checked === true;
            setEnvironmentColorsEnabledState(enabled);
            setEnvironmentColorsEnabled(enabled);
          }}
        />
        <div
          className="settings-environment-color-controls"
          data-disabled={environmentColorsEnabled ? undefined : "true"}
        >
          <div className="settings-environment-color-field">
            <span
              id="setting-environment-palette-label"
              className="settings-control-label"
            >
              Palette
            </span>
            <RadioGroup
              className="settings-radio-group settings-palette-group"
              value={environmentPalette}
              aria-labelledby="setting-environment-palette-label"
              aria-describedby="setting-environment-colors-description"
              disabled={!environmentColorsEnabled}
              onValueChange={(next) => {
                const palette = next as EnvironmentPaletteId;
                setEnvironmentPaletteState(palette);
                setEnvironmentPalette(palette);
              }}
            >
              {ENVIRONMENT_PALETTE_OPTIONS.map((option) => (
                <div className="settings-radio-option" key={option.id}>
                  <RadioGroupItem
                    value={option.id}
                    id={`setting-environment-palette-${option.id}`}
                  />
                  <Label
                    className="settings-palette-label"
                    htmlFor={`setting-environment-palette-${option.id}`}
                    title={option.description}
                  >
                    <span>{option.label}</span>
                    <span
                      className="settings-palette-preview"
                      aria-hidden="true"
                    >
                      {Array.from(
                        { length: 4 },
                        (_, index) => (option.rotation + index * 90) % 360,
                      ).map((hue) => (
                        <span
                          key={hue}
                          style={
                            {
                              "--environment-hue": hue,
                              "--environment-chroma": option.chroma,
                            } as React.CSSProperties
                          }
                        />
                      ))}
                    </span>
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>
          <div className="settings-environment-color-field settings-environment-slider-field">
            <div className="settings-environment-slider-heading">
              <Label
                htmlFor="setting-environment-intensity"
                className="settings-control-label"
              >
                Intensity
              </Label>
              <output
                htmlFor="setting-environment-intensity"
                className="settings-environment-slider-value"
              >
                {environmentTintSettings.intensity}% →{" "}
                {Math.round(environmentTintSettings.intensity / 3)}%
              </output>
            </div>
            <input
              id="setting-environment-intensity"
              className="settings-environment-slider"
              type="range"
              min={ENVIRONMENT_TINT_INTENSITY_RANGE.min}
              max={ENVIRONMENT_TINT_INTENSITY_RANGE.max}
              step={ENVIRONMENT_TINT_INTENSITY_RANGE.step}
              value={environmentTintSettings.intensity}
              aria-describedby="setting-environment-intensity-description"
              aria-valuetext={`${environmentTintSettings.intensity}% peak opacity and ${Math.round(environmentTintSettings.intensity / 3)}% trailing opacity`}
              disabled={!environmentColorsEnabled}
              onChange={(event) => {
                const settings = {
                  ...environmentTintSettings,
                  intensity: Number(event.currentTarget.value),
                };
                setEnvironmentTintSettingsState(settings);
                setEnvironmentTintSettings(settings);
              }}
            />
            <p
              id="setting-environment-intensity-description"
              className="settings-environment-slider-description"
            >
              Sets the peak opacity; the softer tail follows at one third.
            </p>
          </div>
          <div className="settings-environment-color-field settings-environment-slider-field">
            <div className="settings-environment-slider-heading">
              <Label
                htmlFor="setting-environment-fade-in"
                className="settings-control-label"
              >
                Row fade-in
              </Label>
              <output
                htmlFor="setting-environment-fade-in"
                className="settings-environment-slider-value"
              >
                {environmentTintSettings.fadeIn}%
              </output>
            </div>
            <input
              id="setting-environment-fade-in"
              className="settings-environment-slider"
              type="range"
              min={ENVIRONMENT_TINT_FADE_IN_RANGE.min}
              max={ENVIRONMENT_TINT_FADE_IN_RANGE.max}
              step={ENVIRONMENT_TINT_FADE_IN_RANGE.step}
              value={environmentTintSettings.fadeIn}
              aria-describedby="setting-environment-fade-in-description"
              aria-valuetext={`${environmentTintSettings.fadeIn}% row fade-in distance`}
              disabled={!environmentColorsEnabled}
              onChange={(event) => {
                const settings = {
                  ...environmentTintSettings,
                  fadeIn: Number(event.currentTarget.value),
                };
                setEnvironmentTintSettingsState(settings);
                setEnvironmentTintSettings(settings);
              }}
            />
            <p
              id="setting-environment-fade-in-description"
              className="settings-environment-slider-description"
            >
              Sets how gradually each row tint reaches full intensity. A single
              selected environment starts at full intensity at the sidebar edge.
            </p>
          </div>
          <div className="settings-environment-color-field settings-environment-slider-field">
            <div className="settings-environment-slider-heading">
              <Label
                htmlFor="setting-environment-coverage"
                className="settings-control-label"
              >
                Coverage
              </Label>
              <output
                htmlFor="setting-environment-coverage"
                className="settings-environment-slider-value"
              >
                {environmentTintSettings.coverage}%
              </output>
            </div>
            <input
              id="setting-environment-coverage"
              className="settings-environment-slider"
              type="range"
              min={ENVIRONMENT_TINT_COVERAGE_RANGE.min}
              max={ENVIRONMENT_TINT_COVERAGE_RANGE.max}
              step={ENVIRONMENT_TINT_COVERAGE_RANGE.step}
              value={environmentTintSettings.coverage}
              aria-describedby="setting-environment-coverage-description"
              aria-valuetext={`Rows fully clear by ${environmentTintSettings.coverage}%`}
              disabled={!environmentColorsEnabled}
              onChange={(event) => {
                const settings = {
                  ...environmentTintSettings,
                  coverage: Number(event.currentTarget.value),
                };
                setEnvironmentTintSettingsState(settings);
                setEnvironmentTintSettings(settings);
              }}
            />
            <p
              id="setting-environment-coverage-description"
              className="settings-environment-slider-description"
            >
              Sets where each row tint becomes fully transparent.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={
              !environmentColorsEnabled ||
              (environmentTintSettings.intensity ===
                DEFAULT_ENVIRONMENT_TINT_SETTINGS.intensity &&
                environmentTintSettings.fadeIn ===
                  DEFAULT_ENVIRONMENT_TINT_SETTINGS.fadeIn &&
                environmentTintSettings.coverage ===
                  DEFAULT_ENVIRONMENT_TINT_SETTINGS.coverage)
            }
            onClick={() => {
              setEnvironmentTintSettingsState(
                DEFAULT_ENVIRONMENT_TINT_SETTINGS,
              );
              setEnvironmentTintSettings(DEFAULT_ENVIRONMENT_TINT_SETTINGS);
            }}
          >
            Reset tint controls
          </Button>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-chat-atmosphere"
            className="settings-row-label"
          >
            Animated chat background
          </Label>
          <p
            id="setting-chat-atmosphere-description"
            className="settings-row-description"
          >
            Draw a subtle animated point field behind conversations. Reduce
            Motion always disables this effect.
          </p>
        </div>
        <Checkbox
          id="setting-chat-atmosphere"
          data-testid="chat-atmosphere-toggle"
          aria-describedby="setting-chat-atmosphere-description"
          checked={chatAtmosphere}
          onCheckedChange={(checked) => {
            const next = checked === true;
            setChatAtmosphereState(next);
            setChatAtmosphereEnabled(next);
          }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-smooth-streaming"
            className="settings-row-label"
          >
            Smooth streaming
          </Label>
          <p
            id="setting-smooth-streaming-description"
            className="settings-row-description"
          >
            Fade in new response text and ease live-edge following. If your
            system's Reduce Motion preference is on, updates appear without
            these animations.
          </p>
        </div>
        <Checkbox
          id="setting-smooth-streaming"
          data-testid="smooth-streaming-toggle"
          aria-describedby="setting-smooth-streaming-description"
          checked={smoothStreaming}
          onCheckedChange={(checked) => {
            const next = checked === true;
            setSmoothStreamingState(next);
            setSmoothStreamingEnabled(next);
          }}
        />
      </div>
    </>
  );
}
