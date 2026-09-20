import "./tasks-panel.css";
import type { DragEventHandler } from "react";

/**
 * Minimal radiogroup-of-buttons segment control (Tasks panel views, task
 * scope editing, archive-time task disposition). Not a Radix menu item:
 * safe to embed inside menus/dialogs without closing them on click.
 */
export function SegmentedControl({
  ariaLabel,
  value,
  options,
  onChange,
  size = "regular",
}: {
  ariaLabel: string;
  value: string;
  options: readonly {
    readonly value: string;
    readonly label: string;
    readonly disabled?: boolean;
    readonly title?: string;
    readonly dropActive?: boolean;
    readonly onDragEnter?: DragEventHandler<HTMLButtonElement>;
    readonly onDragOver?: DragEventHandler<HTMLButtonElement>;
    readonly onDragLeave?: DragEventHandler<HTMLButtonElement>;
    readonly onDrop?: DragEventHandler<HTMLButtonElement>;
  }[];
  onChange: (value: string) => void;
  size?: "regular" | "small";
}): React.JSX.Element {
  return (
    <div
      className="tasks-segments"
      data-size={size}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={option.disabled}
          title={option.title}
          className="tasks-segment"
          data-task-scope-drop-target={option.dropActive || undefined}
          onDragEnter={option.onDragEnter}
          onDragOver={option.onDragOver}
          onDragLeave={option.onDragLeave}
          onDrop={option.onDrop}
          onClick={() => {
            if (option.value !== value) onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
