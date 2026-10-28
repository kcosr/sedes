// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeVoicePlugin, VOICE_CONNECTION, VOICE_IDENTITY, VOICE_ORIGIN_ID, voiceSnapshot } from "./native-voice-test-fixture.js";

const voice = vi.hoisted(() => ({ fake: undefined as unknown as ReturnType<typeof fakeVoicePlugin>, android: false, appListener: vi.fn() }));
vi.mock("../app/client-platform.js", () => ({ isAndroidClient: () => voice.android, isElectronClient: () => !voice.android }));
vi.mock("@capacitor/app", () => ({ App: { addListener: voice.appListener } }));
vi.mock("./native-voice-plugin.js", async importOriginal => ({
  ...await importOriginal<typeof import("./native-voice-plugin.js")>(),
  hasNativeVoice: () => true,
  nativeVoice: new Proxy({}, { get: (_target, key) => Reflect.get(voice.fake.plugin, key) }),
}));

import { VoiceProvider, useClientOrigin, useNativeVoice, useVoiceState } from "./VoiceProvider.js";
import type { NativeVoiceStore } from "./NativeVoiceStore.js";

function ConnectedVoice({ store }: { store: NativeVoiceStore }) {
  useVoiceState(store);
  const origin = useClientOrigin()();
  return <output>{origin?.clientId ?? "Connecting"}</output>;
}
function Consumer() {
  const store = useNativeVoice();
  return store ? <ConnectedVoice store={store} /> : <output>No voice binding</output>;
}
function renderProvider(identity: string | undefined = VOICE_IDENTITY) {
  return render(<VoiceProvider profileId={VOICE_CONNECTION.profileId} endpoint={{ baseUrl: VOICE_CONNECTION.serverOrigin }} identity={identity}>
    <Consumer />
  </VoiceProvider>);
}

beforeEach(() => {
  voice.android = false;
  voice.fake = fakeVoicePlugin();
  voice.appListener.mockReset().mockResolvedValue({ remove: vi.fn(async () => undefined) });
});
afterEach(() => { cleanup(); localStorage.clear(); });

describe("packaged voice provider", () => {
  it("binds desktop voice to the admitted identity and shares its origin without an Android app listener", async () => {
    const view = renderProvider();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(VOICE_ORIGIN_ID));
    expect(voice.fake.plugin.setConnection).toHaveBeenCalledExactlyOnceWith(VOICE_CONNECTION);
    expect(voice.appListener).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(voice.fake.plugin.getState).toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(voice.fake.remove).toHaveBeenCalled());
  });
  it("waits for desktop authentication before creating a voice binding", () => {
    render(<VoiceProvider profileId={VOICE_CONNECTION.profileId} endpoint={{ baseUrl: VOICE_CONNECTION.serverOrigin }}><Consumer /></VoiceProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("No voice binding");
    expect(voice.fake.plugin.setConnection).not.toHaveBeenCalled();
  });
  it("keeps the Android resume listener and removes it on unmount", async () => {
    voice.android = true;
    const remove = vi.fn(async () => undefined);
    voice.appListener.mockResolvedValue({ remove });
    voice.fake.plugin.setConnection.mockResolvedValue(voiceSnapshot());
    const view = renderProvider();
    await waitFor(() => expect(voice.appListener).toHaveBeenCalledWith("appStateChange", expect.any(Function)));
    view.unmount();
    await waitFor(() => expect(remove).toHaveBeenCalledOnce());
  });
});
