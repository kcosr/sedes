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

const seekOnSubmitKey = "sedes-seek-on-submit";
const diagnosticCategoryKeys = {
  voice: "sedes-diagnostics-voice",
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
// Keep this preference’s storage identity when extending it to environments.
const clickNamesToFilterKey = "sedes-filter-by-project-name";

export const DEFAULT_ACTIVITY_DETAIL: ActivityDetailMode = "full";
export const DEFAULT_MOBILE_COMPOSER_REFOCUS_AFTER_SEND = true;
export const DEFAULT_SHOW_PROMPTS_TAB = true;
export type PromptsPlacement = "above_composer" | "toolbar";
export const DEFAULT_PROMPTS_PLACEMENT: PromptsPlacement = "above_composer";

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

/** Announces a same-window write; other windows observe the storage event. */
function announceSettingChange(key: string): void {
  window.dispatchEvent(
    new CustomEvent(settingsChangeEvent, { detail: { key } }),
  );
}

/**
 * Calls `onChange` for a same-window announcement of `announcedKey` and for a
 * cross-window write to any of `storageKeys` or a cleared store.
 */
function subscribeSettingChange(
  announcedKey: string,
  onChange: () => void,
  storageKeys: readonly string[] = [announcedKey],
): () => void {
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === announcedKey) onChange();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || storageKeys.includes(event.key)) onChange();
  };
  window.addEventListener(settingsChangeEvent, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(settingsChangeEvent, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
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
  announceSettingChange(confirmTerminalTerminationKey);
}

export function subscribeConfirmTerminalTermination(
  listener: (value: boolean) => void,
): () => void {
  return subscribeSettingChange(confirmTerminalTerminationKey, () =>
    listener(getConfirmTerminalTermination()),
  );
}

export function getDiffLineWrap(): boolean {
  return localStorage.getItem(diffLineWrapKey) !== "false";
}

export function setDiffLineWrap(value: boolean): void {
  localStorage.setItem(diffLineWrapKey, value ? "true" : "false");
  announceSettingChange(diffLineWrapKey);
}

export function subscribeDiffLineWrap(
  listener: (value: boolean) => void,
): () => void {
  return subscribeSettingChange(diffLineWrapKey, () =>
    listener(getDiffLineWrap()),
  );
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
  announceSettingChange(historyPageSizeKey);
}

export function subscribeHistoryPageSize(
  listener: (value: HistoryPageSize) => void,
): () => void {
  return subscribeSettingChange(historyPageSizeKey, () =>
    listener(getHistoryPageSize()),
  );
}

export function getSeekOnSubmit(): boolean {
  return localStorage.getItem(seekOnSubmitKey) === "true";
}

export function setSeekOnSubmit(value: boolean): void {
  localStorage.setItem(seekOnSubmitKey, value ? "true" : "false");
  announceSettingChange(seekOnSubmitKey);
}

export function subscribeSeekOnSubmit(
  listener: (value: boolean) => void,
): () => void {
  return subscribeSettingChange(seekOnSubmitKey, () =>
    listener(getSeekOnSubmit()),
  );
}

export function getRightOptionFocusesComposer(): boolean {
  return localStorage.getItem(rightOptionFocusesComposerKey) === "true";
}

export function setRightOptionFocusesComposer(value: boolean): void {
  localStorage.setItem(rightOptionFocusesComposerKey, value ? "true" : "false");
  announceSettingChange(rightOptionFocusesComposerKey);
}

export function subscribeRightOptionFocusesComposer(
  listener: (value: boolean) => void,
): () => void {
  return subscribeSettingChange(rightOptionFocusesComposerKey, () =>
    listener(getRightOptionFocusesComposer()),
  );
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
  announceSettingChange(mobileComposerRefocusAfterSendKey);
}

export function subscribeMobileComposerRefocusAfterSend(
  listener: (value: boolean) => void,
): () => void {
  return subscribeSettingChange(mobileComposerRefocusAfterSendKey, () =>
    listener(getMobileComposerRefocusAfterSend()),
  );
}

export function getMobileHistorySeekControl(): boolean {
  return localStorage.getItem(mobileHistorySeekControlKey) !== "false";
}

export function setMobileHistorySeekControl(value: boolean): void {
  localStorage.setItem(mobileHistorySeekControlKey, value ? "true" : "false");
  announceSettingChange(mobileHistorySeekControlKey);
}

export function subscribeMobileHistorySeekControl(
  listener: (value: boolean) => void,
): () => void {
  return subscribeSettingChange(mobileHistorySeekControlKey, () =>
    listener(getMobileHistorySeekControl()),
  );
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
  announceSettingChange(showPromptsTabKey);
}

export function subscribeShowPromptsTab(
  listener: (value: boolean) => void,
): () => void {
  return subscribeSettingChange(showPromptsTabKey, () =>
    listener(getShowPromptsTab()),
  );
}

/** Where this browser places the Prompts control at every screen size. */
export function getPromptsPlacement(): PromptsPlacement {
  const value = localStorage.getItem(promptsPlacementKey);
  if (value === "toolbar") return value;
  return DEFAULT_PROMPTS_PLACEMENT;
}

export function setPromptsPlacement(value: PromptsPlacement): void {
  localStorage.setItem(promptsPlacementKey, value);
  announceSettingChange(promptsPlacementKey);
}

export function subscribePromptsPlacement(
  listener: (value: PromptsPlacement) => void,
): () => void {
  return subscribeSettingChange(promptsPlacementKey, () =>
    listener(getPromptsPlacement()),
  );
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
  announceSettingChange(smoothStreamingKey);
}

export function subscribeSmoothStreamingEnabled(
  listener: (value: boolean) => void,
): () => void {
  return subscribeSettingChange(smoothStreamingKey, () =>
    listener(getSmoothStreamingEnabled()),
  );
}

/** Whether to render the animated point field behind visible conversations. */
export function getChatAtmosphereEnabled(): boolean {
  return localStorage.getItem(chatAtmosphereKey) === "true";
}

export function setChatAtmosphereEnabled(value: boolean): void {
  localStorage.setItem(chatAtmosphereKey, value ? "true" : "false");
  announceSettingChange(chatAtmosphereKey);
}

export function subscribeChatAtmosphereEnabled(
  listener: (value: boolean) => void,
): () => void {
  return subscribeSettingChange(chatAtmosphereKey, () =>
    listener(getChatAtmosphereEnabled()),
  );
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
  announceSettingChange(key);
}

export function subscribeDiagnosticCategoryEnabled(
  category: ClientDiagnosticCategory,
  listener: (value: boolean) => void,
): () => void {
  const key = diagnosticCategoryKeys[category];
  return subscribeSettingChange(key, () =>
    listener(getDiagnosticCategoryEnabled(category)),
  );
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
  announceSettingChange(terminalSettingsKey);
}

export function subscribeTerminalPreferences(
  listener: (preferences: TerminalPreferences) => void,
): () => void {
  return subscribeSettingChange(
    terminalSettingsKey,
    () => listener(getTerminalPreferences()),
    [terminalCursorBlinkKey, terminalFontSizeKey, terminalScrollbackKey],
  );
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
  announceSettingChange(clickNamesToFilterKey);
}

export function subscribeClickNamesToFilter(listener: () => void): () => void {
  return subscribeSettingChange(clickNamesToFilterKey, listener);
}
