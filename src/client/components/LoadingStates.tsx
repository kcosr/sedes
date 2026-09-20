import { Button } from "@client/components/ui/button";
import { Skeleton } from "@client/components/ui/skeleton";
import { SedesMark } from "./brand-icons.js";

export function FullPageLoading(): React.JSX.Element {
  return (
    <main className="launch-state" aria-busy="true">
      <div className="brand-mark" aria-hidden="true">
        <SedesMark size={36} />
      </div>
      <p className="eyebrow">Sedes</p>
      <h1>Opening your workspace</h1>
      <div className="loading-line" />
    </main>
  );
}

export function FullPageError({
  message,
  retry,
  settings,
  eyebrow = "Connection unavailable",
  title = "Couldn’t open Sedes",
}: {
  message: string;
  retry?: () => void;
  settings?: React.ReactNode;
  eyebrow?: string;
  title?: string;
}): React.JSX.Element {
  return (
    <main className="launch-state">
      <div className="brand-mark error" aria-hidden="true">!</div>
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="supporting">{message}</p>
      {retry && <Button onClick={retry}>Try again</Button>}
      {settings}
    </main>
  );
}

export function ThreadLoading(): React.JSX.Element {
  return (
    <div className="thread-loading" aria-busy="true" aria-label="Loading thread">
      <Skeleton className="h-16 w-1/2" />
      <Skeleton className="h-16 w-3/4" />
      <Skeleton className="h-16 w-2/5" />
    </div>
  );
}
