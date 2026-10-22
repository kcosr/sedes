import { createContext, useContext, type ReactNode } from "react";
import type { PageRevision } from "../../shared/protocol/pages.js";

export type OpenPage = (page: PageRevision) => void;

const PageOpenContext = createContext<OpenPage | undefined>(undefined);

export function PageOpenProvider({
  openPage,
  children,
}: {
  openPage: OpenPage;
  children: ReactNode;
}): React.JSX.Element {
  return <PageOpenContext.Provider value={openPage}>{children}</PageOpenContext.Provider>;
}

export function useOpenPage(): OpenPage | undefined {
  return useContext(PageOpenContext);
}
