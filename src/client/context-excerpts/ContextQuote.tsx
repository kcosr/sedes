export function ContextQuote({
  text,
  mode,
  id,
  hidden = false,
}: {
  readonly text: string;
  readonly mode: "compact" | "expanded" | "editor";
  readonly id?: string;
  readonly hidden?: boolean;
}): React.JSX.Element {
  if (mode === "compact") {
    return <span className="context-excerpt-quote" data-mode={mode}>{text}</span>;
  }

  return (
    <blockquote id={id} className="context-excerpt-quote" data-mode={mode} hidden={hidden}>
      {hidden ? undefined : text}
    </blockquote>
  );
}
