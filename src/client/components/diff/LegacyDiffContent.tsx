import { parseUnifiedDiff } from "../../lib/parse-unified-diff.js";
import { UnifiedDiffBlock } from "./DiffBlocks.js";

/**
 * Homegrown chat diff fallback: structured table rows when the text is a
 * unified patch Sedes can parse, otherwise sign-colored raw lines.
 */
export function LegacyDiffContent({
  text,
  wrap = true,
}: {
  readonly text: string;
  readonly wrap?: boolean;
}): React.JSX.Element {
  const structured = parseUnifiedDiff(text);
  if (structured) {
    return <UnifiedDiffBlock hunks={structured} wrap={wrap} />;
  }
  const lines = text.split("\n");
  return (
    <pre className={wrap ? undefined : "diff-nowrap"} data-testid="diff-raw">
      {lines.map((line, index) => (
        <span className={diffLineClass(line)} key={index}>
          {index < lines.length - 1 ? `${line}\n` : line}
        </span>
      ))}
    </pre>
  );
}

function diffLineClass(line: string): string | undefined {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-meta";
  if (line.startsWith("@@")) return "diff-meta";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return undefined;
}
