import type { BoundedToolResult } from "../../../shared/index.js";
import {
  BoundedTextBlock,
  StructuredValue,
  TruncationNotice,
} from "./StructuredValue";

export function ToolResult({
  result,
}: {
  result?: BoundedToolResult;
}): React.JSX.Element {
  if (!result) return <pre>Waiting for output…</pre>;
  return (
    <div
      className={result.isError ? "notice error" : "tool-result"}
      role={result.isError ? "alert" : "status"}
    >
      {result.content.length === 0 && <pre>No textual output.</pre>}
      {result.content.map((part, index) => {
        if (part.kind === "text") {
          return <BoundedTextBlock key={index} value={part.value} />;
        }
        if (part.kind === "image_inline") {
          return (
            <p key={index}>
              Inline {part.mimeType} image ·{" "}
              {part.decodedBytes.toLocaleString()} bytes
            </p>
          );
        }
        return (
          <p key={index}>
            Image omitted ({part.reason}
            {part.mimeType ? `, ${part.mimeType}` : ""})
          </p>
        );
      })}
      {result.details !== undefined && (
        <section aria-label="Result details">
          <h4>Details</h4>
          <StructuredValue value={result.details} />
        </section>
      )}
      <TruncationNotice truncation={result.truncation} />
    </div>
  );
}
