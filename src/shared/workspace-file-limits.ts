/** Runtime-neutral Files bounds shared by protocol validation and the engine. */
export const WORKSPACE_FILE_MAX_PATH_BYTES = 4_096;
export const WORKSPACE_FILE_DEFAULT_PAGE_SIZE = 1_000;
export const WORKSPACE_FILE_MAX_PAGE_SIZE = 5_000;
export const WORKSPACE_FILE_MAX_CONTENT_BYTES = 16 * 1_024 * 1_024;
export const WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES = 16 * 1_024 * 1_024;
/** Exact downloads are streamed; this is a product file-size ceiling, not a buffer size. */
export const WORKSPACE_FILE_MAX_DOWNLOAD_BYTES = 1_024 * 1_024 * 1_024;
export const WORKSPACE_FILE_DOWNLOAD_CHUNK_BYTES = 256 * 1_024;
export const WORKSPACE_FILE_DOWNLOAD_MAX_DURATION_MILLISECONDS =
  6 * 60 * 60 * 1_000;
export const WORKSPACE_FILE_MAX_BASE64_CONTENT_CHARACTERS =
  4 * Math.ceil(WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES / 3);
export const WORKSPACE_FILE_MAX_SUPPLEMENTAL_ROOTS = 8;
export const WORKSPACE_FILE_MAX_LINKED_WORKTREES = 32;
export const WORKSPACE_FILE_PRIMARY_ROOT_ID = "primary" as const;
// JSON may encode every UTF-8 content byte as a six-byte `\u00xx` escape.
// The fixed allowance covers the bounded path/revision fields and JSON shape.
export const WORKSPACE_FILE_WRITE_JSON_ENVELOPE_BYTES = 64 * 1_024;
export const WORKSPACE_FILE_WRITE_JSON_LIMIT_BYTES =
  WORKSPACE_FILE_MAX_CONTENT_BYTES * 6 +
  WORKSPACE_FILE_WRITE_JSON_ENVELOPE_BYTES;
