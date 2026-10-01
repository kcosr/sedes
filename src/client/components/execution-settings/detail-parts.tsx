import { Fragment, useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "../ui/button.js";
import { Callout } from "../ui/callout.js";
import type { GeneralError } from "./validation.js";

/** An identifier or path that people copy but rarely read: monospaced, with a copy button. */
export function CopyableValue({ value, label }: { readonly value: string; readonly label: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <span className="execution-copyable">
    <code>{value}</code>
    <Button type="button" variant="ghost" size="icon-xs" aria-label={copied ? `${label} copied` : `Copy ${label}`}
      onClick={() => void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined)}>
      {copied ? <Check /> : <Copy />}
    </Button>
  </span>;
}

/**
 * A path in the mono face that wraps only after a separator: each segment
 * (up to and including its "/") stays whole unless it alone is wider than
 * the line, so "test-results" never breaks at its hyphen.
 */
export function PathText({ value }: { readonly value: string }): React.JSX.Element {
  const segments = value.split(/(?<=[/\\])/u);
  return <span className="execution-path">{segments.map((segment, index) => <Fragment key={index}>
    {index > 0 ? <wbr /> : null}<span className="execution-path-segment">{segment}</span>
  </Fragment>)}</span>;
}

/** Errors that belong to no single field, described in words. */
export function GeneralErrors({ errors, title = "Fix these before saving" }: { readonly errors: readonly GeneralError[]; readonly title?: string }): React.JSX.Element | null {
  if (!errors.length) return null;
  if (errors.length === 1 && !errors[0]!.location) return <Callout tone="danger" role="alert">{errors[0]!.message}</Callout>;
  return <Callout tone="danger" role="alert" title={title}>
    <ul className="execution-error-list">{errors.map((error, index) => <li key={index}>
      {error.location ? <><span className="execution-error-location">{error.location}</span>: </> : null}{error.message}
    </li>)}</ul>
  </Callout>;
}
