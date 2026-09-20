import type { DiffHunk } from "../../lib/parse-unified-diff.js";

/**
 * Minimal graphical diff rows. Two surfaces share one stylesheet family:
 *
 * - `UnifiedDiffBlock` renders a real unified patch (file_change items) as
 *   structured rows: sign gutter, old/new line numbers, hunk separators.
 * - `LooseDiffLines` renders line-prefixed +/- text (permission-prompt
 *   messages) with the same row treatment but no hunk parsing or numbers.
 */

export function UnifiedDiffBlock({
  hunks,
  wrap = true,
}: {
  readonly hunks: readonly DiffHunk[];
  readonly wrap?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={wrap ? "diff-block" : "diff-block diff-block--nowrap"}
      data-testid="diff-block"
    >
      {hunks.map((hunk, hunkIndex) => (
        <table className="diff-block-table" key={hunkIndex} role="presentation">
          <tbody>
            <tr className="diff-hunk">
              <td className="diff-ln" />
              <td className="diff-ln" />
              <td className="diff-sg" />
              <td className="diff-text">{hunk.header}</td>
            </tr>
            {hunk.rows.map((row, rowIndex) => (
              <tr className={`diff-${row.kind}`} key={rowIndex}>
                <td className="diff-ln">
                  {row.oldLine !== undefined ? row.oldLine : ""}
                </td>
                <td className="diff-ln">
                  {row.newLine !== undefined ? row.newLine : ""}
                </td>
                <td className="diff-sg">
                  {row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}
                </td>
                <td className="diff-text">{row.text || " "}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}

export function LooseDiffLines({
  text,
}: {
  readonly text: string;
}): React.JSX.Element {
  const lines = text.split("\n");
  return (
    <table
      className="diff-block-table diff-loose"
      data-testid="diff-loose"
      role="presentation"
    >
      <tbody>
        {lines.map((line, index) => {
          const kind = line.startsWith("+")
            ? "add"
            : line.startsWith("-") || line.startsWith("−")
              ? "del"
              : "context";
          const marker = kind === "context" ? line : line.slice(1);
          return (
            <tr className={`diff-${kind}`} key={index}>
              <td className="diff-sg">
                {kind === "add" ? "+" : kind === "del" ? "−" : ""}
              </td>
              <td className="diff-text">{marker || " "}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
