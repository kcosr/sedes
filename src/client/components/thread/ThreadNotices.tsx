import type { RuntimeNotice } from "../../../shared/index.js";
import { Button } from "@client/components/ui/button";

export function ThreadNotices({ notices, pending, onDismiss }: {
  readonly notices: readonly RuntimeNotice[];
  readonly pending: boolean;
  readonly onDismiss: (noticeId: string) => void;
}) {
  return notices.map(notice => (
    <aside
      className={`thread-attention runtime-notice ${notice.tone}`}
      key={notice.id}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      <p>{notice.message.text}</p>
      <Button variant="outline" size="xs" disabled={pending} onClick={() => onDismiss(notice.id)}>
        Dismiss
      </Button>
    </aside>
  ));
}
