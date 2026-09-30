import * as React from "react"
import { cva } from "class-variance-authority"
import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { cn } from "@client/lib/utils"
import type { Tone } from "@client/components/ui/tone"

const calloutVariants = cva(
  "flex min-w-0 items-start gap-2.5 rounded-(--radius-ctl) border px-3 py-2.5 text-(length:--text-ui) leading-(--leading-normal) text-foreground",
  {
    variants: {
      tone: {
        neutral:
          "border-border bg-card *:data-[slot=callout-icon]:text-muted-foreground",
        info: "border-info-border bg-info-soft *:data-[slot=callout-icon]:text-info",
        success:
          "border-success-border bg-success-soft *:data-[slot=callout-icon]:text-success",
        warning:
          "border-warning-border bg-warning-soft *:data-[slot=callout-icon]:text-warning",
        danger:
          "border-destructive-border bg-destructive-soft *:data-[slot=callout-icon]:text-destructive",
      } satisfies Record<Tone, string>,
    },
    defaultVariants: { tone: "neutral" },
  }
)

const TONE_ICON = {
  neutral: InfoIcon,
  info: InfoIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
  danger: CircleAlertIcon,
} as const satisfies Record<Tone, React.ComponentType>

/**
 * The one notice and error style: a tinted box with a tone icon, an optional
 * title over a quieter body, and an optional action. Pass `role="alert"` for
 * an error that appears in response to the user.
 */
function Callout({
  tone = "neutral",
  title,
  action,
  icon,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  tone?: Tone
  title?: React.ReactNode
  /** A trailing button or link; it wraps under the text when space is short. */
  action?: React.ReactNode
  /** Replaces the tone's icon. */
  icon?: React.ReactNode
}) {
  const Icon = TONE_ICON[tone]
  return (
    <div
      data-slot="callout"
      data-tone={tone}
      className={cn(calloutVariants({ tone }), className)}
      {...props}
    >
      <span
        data-slot="callout-icon"
        aria-hidden="true"
        className="flex h-[1lh] shrink-0 items-center [&>svg]:size-(--icon-md)"
      >
        {icon ?? <Icon />}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-[1_1_16rem]">
          {title ? (
            <p data-slot="callout-title" className="m-0 font-medium">
              {title}
            </p>
          ) : null}
          {children ? (
            <div
              data-slot="callout-body"
              className={cn(
                "min-w-0 [overflow-wrap:anywhere]",
                title &&
                  "mt-0.5 text-(length:--text-meta) text-muted-foreground"
              )}
            >
              {children}
            </div>
          ) : null}
        </div>
        {action ? (
          <div
            data-slot="callout-action"
            className="flex shrink-0 items-center gap-2"
          >
            {action}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export { Callout, calloutVariants }
