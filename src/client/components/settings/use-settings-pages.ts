import { useMemo } from "react";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import type { CannedPromptClientStore } from "../../stores/CannedPromptClientStore.js";
import type { NotificationSettingsStore } from "../../stores/NotificationSettingsStore.js";
import { useAuthenticationControls } from "../../authentication/AuthenticationSettings.js";
import { useNativeVoice } from "../../voice/VoiceProvider.js";
import type { ElectronConnectionSettingsControls } from "../ElectronConnectionSettings.js";
import type { ServerSettingsControls } from "../ServerSettingsForm.js";
import type { HostPairingControls } from "../execution-settings/useHostPairings.js";
import type { ConfigurationControls } from "../execution-settings/useConfiguration.js";
import type { ToolClientSettingsControls } from "../tool-clients/ToolClientsSettingsPage.js";
import type { ApplicationPreferenceControls } from "./pages/GeneralSettingsPage.js";
import { availableSettingsPages, type SettingsPageEntry } from "./settings-pages.js";

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

/**
 * The settings pages this client can show, in nav order. The shell's sidebar
 * nav uses it before the Settings view's own code has loaded.
 */
export function useSettingsPages(sources: SettingsSources): SettingsPageEntry[] {
  const pairedClients = Boolean(useAuthenticationControls());
  const prompts = Boolean(sources.cannedPrompts);
  const notifications = Boolean(sources.notifications);
  const voice = Boolean(useNativeVoice());
  const execution = Boolean(sources.configuration);
  const projects = Boolean(sources.applicationStore);
  const agents = Boolean(sources.applicationStore);
  const toolClients = Boolean(sources.toolClients);
  const electronConnection = Boolean(sources.electronConnectionSettings);
  const serverProfiles = Boolean(sources.serverSettings);
  return useMemo(
    () => availableSettingsPages({
      prompts, notifications, voice, execution, projects, agents, toolClients, pairedClients, electronConnection, serverProfiles,
    }),
    [prompts, notifications, voice, execution, projects, agents, toolClients, pairedClients, electronConnection, serverProfiles],
  );
}
