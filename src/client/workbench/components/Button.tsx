import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  MouseEvent,
  ReactNode,
  Ref,
} from "react";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { useLinkComponent } from "./Link";
import { Spinner } from "./Spinner";

export type ButtonVariant =
  | "default"
  | "primary"
  | "ghost"
  | "danger"
  | "danger-ghost";
export type ButtonSize = "default" | "sm";

interface ButtonOwnProps {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  /** Leading icon (replaced by a spinner while pending). */
  icon?: IconName | undefined;
  iconRight?: IconName | undefined;
  /** Shows a spinner, sets aria-busy and ignores clicks (focus is kept, unlike disabled). */
  pending?: boolean | undefined;
  /** Count badge after the label ("Files 12"). */
  count?: number | string | undefined;
  children?: ReactNode;
  className?: string | undefined;
}

export type ButtonAsButtonProps = ButtonOwnProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonOwnProps> & {
    href?: undefined;
    ref?: Ref<HTMLButtonElement> | undefined;
  };

export type ButtonAsLinkProps = ButtonOwnProps &
  Omit<
    AnchorHTMLAttributes<HTMLAnchorElement>,
    keyof ButtonOwnProps | "href"
  > & {
    /** Renders a link (through LinkProvider) styled as a button. */
    href: string;
    /** Plain anchor opening a new tab. */
    external?: boolean | undefined;
    /** Renders a non-interactive, aria-disabled link. */
    disabled?: boolean | undefined;
    ref?: Ref<HTMLAnchorElement> | undefined;
  };

export type ButtonProps = ButtonAsButtonProps | ButtonAsLinkProps;

/** Class names for app-owned elements that should look like a kit button. */
export function buttonClass({
  variant = "default",
  size = "default",
  iconOnly = false,
  pending = false,
  className,
}: {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  iconOnly?: boolean | undefined;
  pending?: boolean | undefined;
  className?: string | undefined;
} = {}): string {
  return cx(
    "wb-btn",
    variant !== "default" && `wb-btn--${variant}`,
    size === "sm" && "wb-btn--sm",
    iconOnly && "wb-btn--icon",
    pending && "is-pending",
    className,
  );
}

function isLink(props: ButtonProps): props is ButtonAsLinkProps {
  return typeof props.href === "string";
}

export function Button(props: ButtonProps) {
  const Link = useLinkComponent();
  const content = (
    <>
      {props.pending ? (
        <Spinner />
      ) : props.icon ? (
        <Icon name={props.icon} />
      ) : null}
      {props.children}
      {props.count !== undefined ? (
        <>
          {" "}
          <span className="wb-btn-count">{props.count}</span>
        </>
      ) : null}
      {props.iconRight ? <Icon name={props.iconRight} /> : null}
    </>
  );

  if (isLink(props)) {
    const {
      variant,
      size,
      icon: _icon,
      iconRight: _iconRight,
      count: _count,
      pending,
      children: _children,
      className,
      href,
      external,
      disabled,
      onClick,
      ...rest
    } = props;
    const cls = buttonClass({ variant, size, pending, className });
    if (disabled) {
      return (
        <a {...rest} className={cls} aria-disabled="true" role="link">
          {content}
        </a>
      );
    }
    const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
      if (pending) {
        e.preventDefault();
        return;
      }
      onClick?.(e);
    };
    if (external) {
      return (
        <a
          target="_blank"
          rel="noopener noreferrer"
          {...rest}
          href={href}
          className={cls}
          aria-busy={pending || undefined}
          onClick={handleClick}
        >
          {content}
        </a>
      );
    }
    return (
      <Link
        {...rest}
        href={href}
        className={cls}
        aria-busy={pending || undefined}
        onClick={handleClick}
      >
        {content}
      </Link>
    );
  }

  const {
    variant,
    size,
    icon: _icon,
    iconRight: _iconRight,
    count: _count,
    pending,
    children: _children,
    className,
    type = "button",
    onClick,
    href: _href,
    ...rest
  } = props;
  return (
    <button
      {...rest}
      type={type}
      className={buttonClass({ variant, size, pending, className })}
      aria-busy={pending || undefined}
      onClick={(e) => {
        if (pending) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      {content}
    </button>
  );
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type IconButtonProps = DistributiveOmit<
  ButtonProps,
  "children" | "icon" | "iconRight" | "aria-label"
> & {
  icon: IconName;
  /** Accessible name (required); also the tooltip unless `title` is given. */
  label: string;
  /**
   * A small accent dot in the corner, e.g. while a filter behind the button
   * narrows the list. It is decorative: say what is active in `label`
   * ("Visibility: Private").
   */
  indicator?: boolean | undefined;
};

/** Square icon-only button. Ghost by default, like the top-bar buttons. */
export function IconButton({
  label,
  icon,
  variant = "ghost",
  indicator = false,
  className,
  title,
  ...rest
}: IconButtonProps) {
  const shared = {
    variant,
    icon,
    "aria-label": label,
    title: title ?? label,
    className: cx("wb-btn--icon", className),
  };
  return (
    <Button {...(rest as ButtonProps)} {...shared}>
      {indicator ? (
        <span className="wb-btn-indicator" aria-hidden="true" />
      ) : null}
    </Button>
  );
}
