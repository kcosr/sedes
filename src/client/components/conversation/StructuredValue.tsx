import { Badge } from "@client/components/ui/badge";
import type {
  BoundedText,
  BoundedValue,
  TruncationInfo,
} from "../../../shared/index.js";

export function TruncationNotice({
  truncation,
}: {
  truncation?: TruncationInfo;
}): React.JSX.Element | null {
  if (!truncation) return null;
  const omitted =
    truncation.originalBytes === undefined
      ? undefined
      : Math.max(0, truncation.originalBytes - truncation.retainedBytes);
  return (
    <Badge className="truncation-chip" role="note" variant="outline">
      {omitted === undefined
        ? "Output truncated"
        : `Output truncated · ${omitted.toLocaleString()} bytes omitted`}
    </Badge>
  );
}

export function BoundedTextBlock({
  value,
  emptyText = "No output.",
}: {
  value?: BoundedText;
  emptyText?: string;
}): React.JSX.Element {
  return (
    <div className="bounded-text" data-testid="bounded-text">
      <pre>{value?.text || emptyText}</pre>
      <TruncationNotice truncation={value?.truncation} />
    </div>
  );
}

export function StructuredValue({
  value,
}: {
  value: BoundedValue;
}): React.JSX.Element {
  if (value === null) return <span className="structured-scalar">null</span>;
  if (typeof value === "boolean" || typeof value === "number") {
    return <span className="structured-scalar">{String(value)}</span>;
  }
  if (!("kind" in value)) {
    return (
      <span className="structured-string">
        {value.text}
        <TruncationNotice truncation={value.truncation} />
      </span>
    );
  }
  if (value.kind === "redacted") {
    return <span className="structured-omitted">Sensitive value redacted</span>;
  }
  if (value.kind === "omitted") {
    return (
      <span className="structured-omitted">
        Value omitted ({value.reason})
      </span>
    );
  }
  if (value.kind === "array") {
    return (
      <div className="structured-collection">
        <ol>
          {value.values.map((entry, index) => (
            <li key={index}>
              <StructuredValue value={entry} />
            </li>
          ))}
        </ol>
        <TruncationNotice truncation={value.truncation} />
      </div>
    );
  }
  return (
    <div className="structured-collection">
      <dl>
        {value.entries.map((entry, index) => (
          <div key={`${entry.key.text}-${index}`}>
            <dt>
              {entry.key.text}
              <TruncationNotice truncation={entry.key.truncation} />
            </dt>
            <dd>
              <StructuredValue value={entry.value} />
            </dd>
          </div>
        ))}
      </dl>
      <TruncationNotice truncation={value.truncation} />
    </div>
  );
}
