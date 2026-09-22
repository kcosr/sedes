import { useState } from "react";
import { Button } from "../ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../ui/dialog.js";
import type { UsageQueryCache } from "../../stores/UsageQueryCache.js";
import { RecordedUsage } from "./RecordedUsage.js";

/** Reads persisted accounting even when a cold provider snapshot cannot load. */
export function RecordedSessionUsageAction({ cache, active }: { cache: UsageQueryCache; active: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <Dialog open={active && open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button variant="outline">Session stats</Button></DialogTrigger>
    <DialogContent className="session-stats-dialog">
      <DialogTitle>Session stats</DialogTitle>
      <DialogDescription>Recorded usage is available independently of the agent connection.</DialogDescription>
      <section><h3>Recorded session usage</h3>
        {active && open && <RecordedUsage cache={cache} turnId={null} />}
      </section>
      <p>Live context and transcript counters are unavailable while disconnected.</p>
    </DialogContent>
  </Dialog>;
}
