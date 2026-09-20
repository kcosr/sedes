import { isWindowsClient } from "../terminals/client-platform.js";
/**
 * Client-side app settings (localStorage-backed), in the style of
 * `appearance.ts`: one storage key per setting, typed accessors, and a
 * change event so consumers can react without prop drilling. Same-window
 * writes announce themselves via a CustomEvent (storage events do not fire
 * in the writing window); cross-window writes arrive via the storage event.
 */

import {
  THREAD_HISTORY_PAGE_SIZES,
  type ThreadHistoryPageSize,
} from "../../shared/protocol/api.js";
import type { ActivityDetailMode } from "../../shared/protocol/conversation.js";
import type { PanelPresentation } from "../workspace-panels/panel-presentation.js";

const seekOnSubmitKey = "sedes-seek-on-submit";
const diagnosticCategoryKeys = {
  composer_input: "sedes-diagnostics-composer-input",
  seek: "sedes-diagnostics-seek",
  streaming: "sedes-diagnostics-streaming",
  thread_load: "sedes-diagnostics-thread-load",
} as const;
const rightOptionFocusesComposerKey = "sedes-right-option-focuses-composer";
const mobileComposerRefocusAfterSendKey =
  "sedes-mobile-composer-refocus-after-send";
const mobileHistorySeekControlKey = "sedes-mobile-history-seek-control";
const smoothStreamingKey = "sedes-smooth-streaming";
const chatAtmosphereKey = "sedes-chat-atmosphere";
const settingsChangeEvent = "settings-change";
const terminalFontSizeKey = "sedes-terminal-font-size";
const terminalCursorBlinkKey = "sedes-terminal-cursor-blink";
const terminalScrollbackKey = "sedes-terminal-scrollback";
const terminalSettingsKey = "terminal";
const confirmTerminalTerminationKey = "sedes-confirm-terminal-termination";
const historyPageSizeKey = "sedes-history-page-size";
const diffLineWrapKey = "sedes-diff-line-wrap";
const activityDetailKey = "sedes-activity-detail";
const showPromptsTabKey = "sedes-show-prompts-tab";
const promptsPlacementKey = "sedes-prompts-placement";
const panelPresentationKey = "sedes-panel-presentation";
// Keep this preference’s storage identity when extending it to environments.
const clickNamesToFilterKey = "sedes-filter-by-project-name";

export const DEFAULT_ACTIVITY_DETAIL: ActivityDetailMode = "full";
export const DEFAULT_MOBILE_COMPOSER_REFOCUS_AFTER_SEND = true;
export const DEFAULT_MOBILE_HISTORY_SEEK_CONTROL = true;
export const DEFAULT_SHOW_PROMPTS_TAB = true;
export type PromptsPlacement = "above_composer" | "toolbar";
export const DEFAULT_PROMPTS_PLACEMENT: PromptsPlacement = "above_composer";
export const DEFAULT_PANEL_PRESENTATION: PanelPresentation = "split";

export function getPanelPresentation(): PanelPresentation {
  const value = localStorage.getItem(panelPresentationKey);
  return value === "single" || value === "split"
    ? value
    : DEFAULT_PANEL_PRESENTATION;
}

export function setPanelPresentation(value: PanelPresentation): void {
  if (value !== "single" && value !== "split") {
    throw new Error("Panel presentation is not supported.");
  }
  localStorage.setItem(panelPresentationKey, value);
  window.dispatchEvent(
    new CustomEvent(settingsChangeEvent, {
      detail: { key: panelPresentationKey },
    }),
  );
}

export function subscribePanelPresentation(
  listener: (value: PanelPresentation) => void,
): () => void {
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === panelPresentationKey) listener(getPanelPresentation());
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === panelPresentationKey) {
      listener(getPanelPresentation());
    }
  };
  window.addEventListener(settingsChangeEvent, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(settingsChangeEvent, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}

export type ActivityDetailChangeSource =
  "inline_activity" | "settings" | "storage";

export const HISTORY_PAGE_SIZE_OPTIONS = THREAD_HISTORY_PAGE_SIZES;
export type HistoryPageSize = ThreadHistoryPageSize;
export const DEFAULT_HISTORY_PAGE_SIZE: HistoryPageSize = 10;

export const TERMINAL_DEFAULT_FONT_SIZE = 13;
export const TERMINAL_MINIMUM_FONT_SIZE = 10;
export const TERMINAL_MAXIMUM_FONT_SIZE = 24;
export const TERMINAL_DEFAULT_SCROLLBACK = 8_000;
export const TERMINAL_MINIMUM_SCROLLBACK = 1_000;
export const TERMINAL_MAXIMUM_SCROLLBACK = 20_000;

export interface TerminalPreferences {
  readonly cursorBlink: boolean;
  readonly fontSize: number;
  readonly scrollback: number;
}

export function getActivityDetail(): ActivityDetailMode {
  const value = localStorage.getItem(activityDetailKey);
  return value === "summary" || value === "full"
    ? value
    : DEFAULT_ACTIVITY_DETAIL;
}

export function setActivityDetail(
  value: ActivityDetailMode,
  source: Exclude<ActivityDetailChangeSource, "storage"> = "settings",
): void {
  if (value !== "full" && value !== "summary") {
    throw new Error("Activity detail mode is not supported.");
  }
  localStorage.setItem(activityDetailKey, value);
  window.dispatchEvent(
    new CustomEvent(settingsChangeEvent, {
      detail: { key: activityDetailKey, source },
    }),
  );
}

export function subscribeActivityDetail(
  listener: (
    value: ActivityDetailMode,
    source: ActivityDetailChangeSource,
  ) => void,
): () => void {
  const onLocalChange = (event: Event) => {
    const detail = (
      event as CustomEvent<{
        key?: string;
        source?: Exclude<ActivityDetailChangeSource, "storage">;
      }>
    ).detail;
    if (detail?.key === activityDetailKey) {
      listener(getActivityDetail(), detail.source ?? "settings");
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === activityDetailKey) {
      listener(getActivityDetail(), "storage");
    }
  };
  window.addEventListener(settingsChangeEvent, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(settingsChangeEvent, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Confirmation is a per-client preference, independent of terminal ownership. */
export function getConfirmTerminalTermination(): boolean {
  return localStorage.getItem(confirmTerminalTerminationKey) !== "false";
}

export function setConfirmTerminalTermination(value: boolean): void {
  localStorage.setItem(confirmTerminalTerminationKey, value ? "true" : "false");
  window.dispatchEvent(
    new CustomEvent(settingsChangeEvent, {
      detail: { key: confirmTerminalTerminationKey },
    }),
  );
}

export function subscribeConfirmTerminalTermination(
  listener: (value: boolean) => void,
): () => void {
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === confirmTerminalTerminationKey) {
      listener(getConfirmTerminalTermination());
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === confirmTerminalTerminationKey) {
      listener(getConfirmTerminalTermination());
    }
  };
  window.addEventListener(settingsChangeEvent, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(settingsChangeEvent, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function getDiffLineWrap(): boolean {
  return localStorage.getItem(diffLineWrapKey) !== "false";
}

export function setDiffLineWrap(value: boolean): void {
  localStorage.setItem(diffLineWrapKey, value ? "true" : "false");
  window.dispatchEvent(
    new CustomEvent(settingsChangeEvent, { detail: { key: diffLineWrapKey } }),
  );
}

export function subscribeDiffLineWrap(
  listener: (value: boolean) => void,
): () => void {
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === diffLineWrapKey) listener(getDiffLineWrap());
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === diffLineWrapKey) {
      listener(getDiffLineWrap());
    }
  };
  window.addEventListener(settingsChangeEvent, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(settingsChangeEvent, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function getHistoryPageSize(): HistoryPageSize {
  const value = Number(localStorage.getItem(historyPageSizeKey));
  return HISTORY_PAGE_SIZE_OPTIONS.includes(value as HistoryPageSize)
    ? (value as HistoryPageSize)
    : DEFAULT_HISTORY_PAGE_SIZE;
}

export function setHistoryPageSize(value: HistoryPageSize): void {
  if (!HISTORY_PAGE_SIZE_OPTIONS.includes(value)) {
    throw new Error("History page size is not supported.");
  }
  localStorage.setItem(historyPageSizeKey, String(value));
  window.dispatchEvent(
    new CustomEvent(settingsChangeEvent, {
      detail: { key: historyPageSizeKey },
    }),
  );
}

export function subscribeHistoryPageSize(
  listener: (value: HistoryPageSize) => void,
): () => void {
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === historyPageSizeKey) listener(getHistoryPageSize());
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === historyPageSizeKey) {
      listener(getHistoryPageSize());
    }
  };
  window.addEventListener(settingsChangeEvent, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(settingsChangeEvent, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function getSeekOnSubmit(): boolean {
  return localStorage.getItem(seekOnSubmitKey) === "true";
}

export function setSeekOnSubmit(value: boolean): void {
  localStorage.setItem(seekOnSubmitKey, value ? "true" : "false");
  window.dispatchEvent(
    new CustomEvent(settingsChangeEvent, { detail: { key: seekOnSubmitKey } }),
  );
}

export function subscribeSeekOnSubmit(
  listener: (value: boolean) => void,
): () => void {
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === seekOnSubmitKey) listener(getSeekOnSubmit());
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === seekOnSubmitKey) {
      listener(getSeekOnSubmit());
    }
  };
  window.addEventListener(settingsChangeEvent, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(settingsChangeEvent, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function getRightOptionFocusesComposer(): boolean {
  return localStorage.getItem(rightOptionFocusesComposerKey) === "true";
}

export function setRightOptionFocusesComposer(value: boolean): void {
  localStorage.setItem(rightOptionFocusesComposerKey, value ? "true" : "false");
  window.dispatchEvent(
    new CustomEvent(settingsChangeEvent, {
      detail: { key: rightOptionFocusesComposerKey },
    }),
  );
}

export function subscribeRightOptionFocusesComposer(
  listener: (value: boolean) => void,
): () => void {
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === rightOptionFocusesComposerKey) {
      listener(getRightOptionFocusesComposer());
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === rightOptionFocusesComposerKey) {
      listener(getRightOptionFocusesComposer());
    }
  };
  window.addEventListener(settingsChangeEvent, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(settingsChangeEvent, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function getMobileComposerRefocusAfterSend(): boolean {
  const value = localStorage.getItem(mobileComposerRefocusAfterSendKey);
  if (value === "false") return false;
  if (value === "true") return true;
  return DEFAULT_MOBILE_COMPOSER_REFOCUS_AFTER_SEND;
}

export function setMobileComposerRefocusAfterSend(value: boolean): void {
  localStorage.setItem(
    mobileComposerRefocusAfterSendKey,
    value ? "true" : "false",
  );
  window.dispatchEvent(
    new CustomEvent(settingsChangeEvent, {
      detail: { key: mobileComposerRefocusAfterSendKey },
    }),
  );
}

export function subscribeMobileComposerRefocusAfterSend(
  listener: (value: boolean) => void,
): () => void {
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === mobileComposerRefocusAfterSendKey) {
      listener(getMobileComposerRefocusAfterSend());
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === mobileComposerRefocusAfterSendKey) {
      listener(getMobileComposerRefocusAfterSend());
    }
  };
  window.addEventListener(settingsChangeEvent, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(settingsChangeEvent, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function getMobileHistorySeekControl(): boolean {
  return localStorage.getItem(mobileHistorySeekControlKey) !== "false";
}

export function setMobileHistorySeekControl(value: boolean): void {
  localStorage.setItem(mobileHistorySeekControlKey, value ? "true" : "false");
  window.dispatchEvent(
    new CustomEvent(settingsChangeEvent, {
      detail: { key: mobileHistorySeekControlKey },
    }),
  );
}

export function subscribeMobileHistorySeekControl(
  listener: (value: boolean) => void,
): () => void {
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === mobileHistorySeekControlKey) {
      listener(getMobileHistorySeekControl());
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === mobileHistorySeekControlKey) {
      listener(getMobileHistorySeekControl());
    }
  };
  window.addEventListener(settingsChangeEvent, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(settingsChangeEvent, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Whether this browser shows prompt-library access in the composer. */
export function getShowPromptsTab(): boolean {
  const value = localStorage.getItem(showPromptsTabKey);
  if (value === "false") return false;
  if (value === "true") return true;
  return DEFAULT_SHOW_PROMPTS_TAB;
}

export function setShowPromptsTab(value: boolean): void {
  localStorage.setItem(showPromptsTabKey, value ? "true" : "false");
  window.dispatchEvent(
    new CustomEvent(settingsChangeEvent, {
      detail: { key: showPromptsTabKey },
    }),
  );
}

export function subscribeShowPromptsTab(
  listener: (value: boolean) => void,
): () => void {
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === showPromptsTabKey) listener(getShowPromptsTab());
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === showPromptsTabKey) {
      listener(getShowPromptsTab());
    }
  };
  window.addEventListener(settingsChangeEvent, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(settingsChangeEvent, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Where this browser places the Prompts control at every screen size. */
export function getPromptsPlacement(): PromptsPlacement {
  const value = localStorage.getItem(promptsPlacementKey);
  if (value === "toolbar") return value;
  return DEFAULT_PROMPTS_PLACEMENT;
}

export function setPromptsPlacement(value: PromptsPlacement): void {
  localStorage.setItem(promptsPlacementKey, value);
  window.dispatchEvent(
    new CustomEvent(settingsChangeEvent, {
      detail: { key: promptsPlacementKey },
    }),
  );
}

export function subscribePromptsPlacement(
  listener: (value: PromptsPlacement) => void,
): () => void {
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === promptsPlacementKey) {
      listener(getPromptsPlacement());
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === promptsPlacementKey) {
      listener(getPromptsPlacement());
    }
  };
  window.addEventListener(settingsChangeEvent, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(settingsChangeEvent, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Whether browser-local presentation animations should smooth streamed text
 * and live-edge following. Reduced-motion is applied separately by consumers
 * so this accessor always represents the user's stored preference.
 */
export function getSmoothStreamingEnabled(): boolean {
  const value = localStorage.getItem(smoothStreamingKey);
  if (value === "true") return true;
  if (value === "false") return false;
  return true;
}

export function setSmoothStreamingEnabled(value: boolean): void {
  localStorage.setItem(smoothStreamingKey, value ? "true" : "false");
  window.dispatchEvent(
    new CustomEvent(settingsChangeEvent, {
      detail: { key: smoothStreamingKey },
    }),
  );
}

export function subscribeSmoothStreamingEnabled(
  listener: (value: boolean) => void,
): () => void {
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === smoothStreamingKey) {
      listener(getSmoothStreamingEnabled());
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === smoothStreamingKey) {
      listener(getSmoothStreamingEnabled());
    }
  };
  window.addEventListener(settingsChangeEvent, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(settingsChangeEvent, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Whether to render the animated point field behind visible conversations. */
export function getChatAtmosphereEnabled(): boolean {
  return localStorage.getItem(chatAtmosphereKey) === "true";
}

export function setChatAtmosphereEnabled(value: boolean): void {
  localStorage.setItem(chatAtmosphereKey, value ? "true" : "false");
  window.dispatchEvent(
    new CustomEvent(settingsChangeEvent, {
      detail: { key: chatAtmosphereKey },
    }),
  );
}

export function subscribeChatAtmosphereEnabled(
  listener: (value: boolean) => void,
): () => void {
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === chatAtmosphereKey) {
      listener(getChatAtmosphereEnabled());
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === chatAtmosphereKey) {
      listener(getChatAtmosphereEnabled());
    }
  };
  window.addEventListener(settingsChangeEvent, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(settingsChangeEvent, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}

export type ClientDiagnosticCategory = keyof typeof diagnosticCategoryKeys;

export function getDiagnosticCategoryEnabled(
  category: ClientDiagnosticCategory,
): boolean {
  return localStorage.getItem(diagnosticCategoryKeys[category]) === "true";
}

export function setDiagnosticCategoryEnabled(
  category: ClientDiagnosticCategory,
  value: boolean,
): void {
  const key = diagnosticCategoryKeys[category];
  localStorage.setItem(key, value ? "true" : "false");
  window.dispatchEvent(
    new CustomEvent(settingsChangeEvent, {
      detail: { key },
    }),
  );
}

export function subscribeDiagnosticCategoryEnabled(
  category: ClientDiagnosticCategory,
  listener: (value: boolean) => void,
): () => void {
  const key = diagnosticCategoryKeys[category];
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === key) {
      listener(getDiagnosticCategoryEnabled(category));
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === key) {
      listener(getDiagnosticCategoryEnabled(category));
    }
  };
  window.addEventListener(settingsChangeEvent, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(settingsChangeEvent, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function getTerminalPreferences(): TerminalPreferences {
  const blink = localStorage.getItem(terminalCursorBlinkKey);
  return {
    cursorBlink: blink === "true" ? true : blink === "false" ? false : !isWindowsClient(),
    fontSize: boundedStoredInteger(
      terminalFontSizeKey,
      TERMINAL_MINIMUM_FONT_SIZE,
      TERMINAL_MAXIMUM_FONT_SIZE,
      TERMINAL_DEFAULT_FONT_SIZE,
    ),
    scrollback: boundedStoredInteger(
      terminalScrollbackKey,
      TERMINAL_MINIMUM_SCROLLBACK,
      TERMINAL_MAXIMUM_SCROLLBACK,
      TERMINAL_DEFAULT_SCROLLBACK,
    ),
  };
}

export function setTerminalPreferences(preferences: TerminalPreferences): void {
  if (
    typeof preferences.cursorBlink !== "boolean" ||
    !boundedInteger(
      preferences.fontSize,
      TERMINAL_MINIMUM_FONT_SIZE,
      TERMINAL_MAXIMUM_FONT_SIZE,
    ) ||
    !boundedInteger(
      preferences.scrollback,
      TERMINAL_MINIMUM_SCROLLBACK,
      TERMINAL_MAXIMUM_SCROLLBACK,
    )
  ) {
    throw new Error("Terminal preferences are outside the supported bounds.");
  }
  localStorage.setItem(terminalCursorBlinkKey, String(preferences.cursorBlink));
  localStorage.setItem(terminalFontSizeKey, String(preferences.fontSize));
  localStorage.setItem(terminalScrollbackKey, String(preferences.scrollback));
  window.dispatchEvent(
    new CustomEvent(settingsChangeEvent, {
      detail: { key: terminalSettingsKey },
    }),
  );
}

export function subscribeTerminalPreferences(
  listener: (preferences: TerminalPreferences) => void,
): () => void {
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === terminalSettingsKey) listener(getTerminalPreferences());
  };
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === terminalCursorBlinkKey ||
      event.key === terminalFontSizeKey ||
      event.key === terminalScrollbackKey
    ) {
      listener(getTerminalPreferences());
    }
  };
  window.addEventListener(settingsChangeEvent, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(settingsChangeEvent, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}

function boundedStoredInteger(
  key: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const raw = localStorage.getItem(key);
  if (raw === null || !/^\d+$/u.test(raw)) return fallback;
  const value = Number(raw);
  return boundedInteger(value, minimum, maximum) ? value : fallback;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

/** Client-local sidebar interaction preference; no server or workspace policy. */
export function getClickNamesToFilter(): boolean {
  return localStorage.getItem(clickNamesToFilterKey) === "true";
}

export function setClickNamesToFilter(value: boolean): void {
  localStorage.setItem(clickNamesToFilterKey, String(value));
  window.dispatchEvent(
    new CustomEvent(settingsChangeEvent, {
      detail: { key: clickNamesToFilterKey },
    }),
  );
}

export function subscribeClickNamesToFilter(listener: () => void): () => void {
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === clickNamesToFilterKey) listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === clickNamesToFilterKey) listener();
  };
  window.addEventListener(settingsChangeEvent, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(settingsChangeEvent, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}
