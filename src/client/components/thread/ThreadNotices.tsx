import type { RuntimeNotice } from "../../../shared/index.js";

export function ThreadNotices({ notices }: { readonly notices: readonly RuntimeNotice[] }) {
  const seen = new Set<string>();
  return notices.filter(notice => {
    const key = JSON.stringify([notice.tone, notice.message.text]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(notice => (
    <div
      className={`thread-notice ${notice.tone}`}
      key={notice.id}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      {notice.message.text}
    </div>
  ));
}
