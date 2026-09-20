import * as React from "react";
import { cn } from "@client/lib/utils";

function AttachmentGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment-group"
      className={cn("grid gap-2", className)}
      {...props}
    />
  );
}

function Attachment({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment"
      className={cn(
        "group/attachment relative flex min-w-0 items-center gap-2 rounded-md border border-border bg-background p-2",
        className,
      )}
      {...props}
    />
  );
}

function AttachmentMedia({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment-media"
      className={cn(
        "flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function AttachmentTrigger({
  className,
  type = "button",
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      data-slot="attachment-trigger"
      type={type}
      className={cn(
        "shrink-0 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...props}
    />
  );
}

function AttachmentContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment-content"
      className={cn("min-w-0 flex-1", className)}
      {...props}
    />
  );
}

function AttachmentTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment-title"
      className={cn("truncate text-xs font-medium text-foreground", className)}
      {...props}
    />
  );
}

function AttachmentDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment-description"
      className={cn(
        "mt-0.5 truncate text-[11px] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function AttachmentActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment-actions"
      className={cn("flex shrink-0 items-center gap-1", className)}
      {...props}
    />
  );
}
function AttachmentAction({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment-action"
      className={cn("flex shrink-0 items-center", className)}
      {...props}
    />
  );
}

function AttachmentState({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="attachment-state"
      className={cn("text-[11px] text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentState,
  AttachmentTitle,
  AttachmentTrigger,
};
