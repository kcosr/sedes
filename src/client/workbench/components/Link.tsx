import { createContext, useContext } from "react";
import type {
  AnchorHTMLAttributes,
  ComponentType,
  ReactNode,
  Ref,
} from "react";

/** Props every kit link receives. `href` is the app URL ("/tokens?status=active" or "#/events/49"). */
export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  ref?: Ref<HTMLAnchorElement> | undefined;
}

export type LinkComponent = ComponentType<LinkProps>;

/** Plain anchor: right for hash routing and external URLs. */
export function PlainLink(props: LinkProps) {
  return <a {...props} />;
}

const LinkContext = createContext<LinkComponent>(PlainLink);

/**
 * Makes every kit link (NavTab, SidebarItem, Button href, LinkTabs, menu and
 * row links) render through the app's router link. Hash-routed apps don't
 * need it. For react-router:
 *
 *   const RouterLink = ({ href, ...rest }: LinkProps) => <Link to={href} {...rest} />;
 *   <LinkProvider component={RouterLink}>…</LinkProvider>
 */
export function LinkProvider({
  component,
  children,
}: {
  component: LinkComponent;
  children?: ReactNode;
}) {
  return (
    <LinkContext.Provider value={component}>{children}</LinkContext.Provider>
  );
}

export function useLinkComponent(): LinkComponent {
  return useContext(LinkContext);
}

/** An app link through the configured link component; `external` opens a new tab with a plain anchor. */
export function AppLink({
  external = false,
  ...props
}: LinkProps & { external?: boolean | undefined }) {
  const Link = useLinkComponent();
  if (external)
    return <a target="_blank" rel="noopener noreferrer" {...props} />;
  return <Link {...props} />;
}
