import { MoveHorizontal } from "lucide-react";
import { standardChatWidth } from "../../app/chat-width.js";
import { Button } from "../ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.js";

const keyboardStep = 16;

export function ChatWidthControl({
  width,
  limit,
  onChange,
}: {
  readonly width: number;
  readonly limit: number;
  readonly onChange: (width: number) => void;
}): React.JSX.Element {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="chat-width-trigger"
          aria-label="Chat width"
          title="Chat width"
        >
          <MoveHorizontal aria-hidden="true" strokeWidth={1.8} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Chat width" className="w-56 gap-0">
        <div className="flex justify-between" aria-hidden="true">
          <span>Standard</span>
          <span>Wide</span>
        </div>
        <input
          type="range"
          aria-label="Transcript width"
          aria-valuetext={`${width} pixels`}
          className="m-0 h-8 w-full accent-primary"
          min={standardChatWidth}
          max={limit}
          value={width}
          onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
          onKeyDown={(event) => {
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            const { key } = event;
            const direction = key === "ArrowRight" || key === "ArrowUp" ? 1
              : key === "ArrowLeft" || key === "ArrowDown" ? -1 : 0;
            if (direction === 0) return;
            event.preventDefault();
            const nextWidth = Math.max(standardChatWidth, Math.min(limit, width + direction * keyboardStep));
            if (nextWidth !== width) onChange(nextWidth);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
