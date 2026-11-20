export type ContextQuoteKind = "selection" | "question";

export function ContextQuote({
  text,
  mode,
  kind = "selection",
  id,
  hidden = false,
}: {
  readonly text: string;
  readonly mode: "compact" | "expanded" | "editor";
  readonly kind?: ContextQuoteKind;
  readonly id?: string;
  readonly hidden?: boolean;
}): React.JSX.Element {
  if (mode === "compact") {
    return (
      <span className="context-excerpt-quote" data-mode={mode} data-quote-kind={kind}>
        {text}
      </span>
    );
  }

  return (
    <blockquote
      id={id}
      className="context-excerpt-quote"
      data-mode={mode}
      data-quote-kind={kind}
      hidden={hidden}
    >
      {hidden ? undefined : text}
    </blockquote>
  );
}
