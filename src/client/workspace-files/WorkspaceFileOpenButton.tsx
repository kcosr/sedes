import { useEffect, useMemo, useRef, useState } from "react";
import { FileSymlink } from "lucide-react";
import {
  useWorkspaceFileLinkHandler,
  workspaceFileReferenceFromPath,
} from "./workspace-file-link-routing.js";
import { getPanelPresentation } from "../app/settings.js";
import { resolvePanelPresentation } from "../workspace-panels/panel-presentation.js";

export function WorkspaceFileOpenButton({
  path,
  lineNumber,
}: {
  readonly path: string;
  readonly lineNumber: number;
}): React.JSX.Element | null {
  const handler = useWorkspaceFileLinkHandler();
  const reference = useMemo(() => workspaceFileReferenceFromPath(path), [path]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (
    !handler ||
    !reference ||
    !Number.isSafeInteger(lineNumber) ||
    lineNumber < 1
  ) {
    return null;
  }
  const label = `Open ${path} in Files at line ${lineNumber}`;
  return (
    <>
      <button
        aria-label={label}
        className="workspace-file-open-button"
        disabled={busy}
        onClick={(event) => {
          const presentation = resolvePanelPresentation(
            getPanelPresentation(),
            event.shiftKey,
          );
          setBusy(true);
          setNotice(undefined);
          void Promise.resolve(
            handler.openReference({
              reference,
              target: { kind: "source_line", lineNumber },
              presentation,
            }),
          )
            .then((opened) => {
              if (mounted.current && opened === false) {
                setNotice("That file is not available in Files.");
              }
            })
            .catch(() => {
              if (mounted.current) {
                setNotice("Could not open that file. Try again.");
              }
            })
            .finally(() => {
              if (mounted.current) setBusy(false);
            });
        }}
        title={label}
        type="button"
      >
        <FileSymlink size={14} />
      </button>
      {notice && (
        <span className="workspace-file-open-notice" role="status">
          {notice}
        </span>
      )}
    </>
  );
}
