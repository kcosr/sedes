import { useState } from "react";
import { defaultThreadChoices, useDefaultThread } from "../../app/default-thread.js";
import { useApplicationStore, type ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { ThreadPicker } from "../ThreadPicker.js";
import { Button } from "../ui/button.js";
import { Callout } from "../ui/callout.js";
import { SettingsField } from "./SettingsField.js";
import { SettingsSection } from "./SettingsSection.js";

export function DefaultThreadSetting({ store }: { store: ApplicationClientStore }) {
  const controls = useDefaultThread();
  const application = useApplicationStore(store);
  const [open, setOpen] = useState(false);
  if (!controls) return null;
  const threads = defaultThreadChoices(application.snapshot?.threads ?? [], controls.thread);
  const current = threads.find(t => t.id === controls.threadId);
  return <SettingsSection title="Default thread" description="Used for quick navigation and as the default voice target on this device." card>
    <SettingsField label="Thread" description="Saved separately for this connection and signed-in identity.">
      <Button variant="outline" disabled={controls.pending} onClick={() => setOpen(true)}>{current?.title.text || (controls.threadId ? "Unavailable thread" : "Choose thread")}</Button>
      {controls.threadId ? <Button variant="ghost" disabled={controls.pending} onClick={() => void controls.setThread(null).catch(() => undefined)}>Clear</Button> : null}
    </SettingsField>
    <p className="text-muted-foreground text-(length:--text-meta)">Open default thread: {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Shift+H</p>
    {controls.error ? <Callout tone="danger" role="alert">{controls.error}</Callout> : null}
    <ThreadPicker threads={threads} open={open} onOpenChange={setOpen} title="Default thread" description="Choose a thread for quick navigation and voice."
      selectedThreadId={controls.threadId} pinned={{threadId:controls.threadId,label:"Current default thread"}}
      onSelect={thread => void controls.setThread(thread).catch(() => undefined)} />
  </SettingsSection>;
}
