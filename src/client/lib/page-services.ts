import type { PageRevision, PageRevisionPage } from "../../shared/protocol/pages.js";
import type { PageListOptions, PageRenderAdmission, PreparedPageDownload } from "../api/ApiClient.js";
import type { PageResponseServices } from "../components/conversation/page-response-services.js";

/** The authority needed by either an inline preview or a Pages document frame. */
export interface PageFrameServices {
  readonly createPageRenderAdmission?: (pageId: string, revision: number, signal?: AbortSignal) => Promise<PageRenderAdmission>;
  readonly pageResponse?: PageResponseServices;
}

/** Document navigation and export belong to the Pages viewer. */
export interface PageDocumentServices extends PageFrameServices {
  readonly listPageRevisions?: (pageId: string, options?: PageListOptions) => Promise<PageRevisionPage>;
  readonly getPageRevision?: (pageId: string, revision: number, signal?: AbortSignal) => Promise<PageRevision>;
  readonly preparePageDownload?: (page: PageRevision, signal?: AbortSignal) => Promise<PreparedPageDownload>;
}
