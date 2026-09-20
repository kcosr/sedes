/**
 * Cross-engine normalization for file-tree name truncation. Pierre's
 * middle-truncation duplicates each text segment and uses a size container
 * query with `lh` units to decide when its markers are visible. Browser and
 * WebView engines can mis-evaluate that query and mask every name even when
 * ample width is available. Flatten each group to one visible copy and use
 * the platform's reliable end ellipsis instead.
 *
 * Injected through the FileTree `unsafeCSS` option. Its `unsafe` cascade
 * layer intentionally outranks Pierre's core `base` layer.
 */
export const TREE_TRUNCATION_CSS = `
[data-truncate-content='overflow'],
[data-truncate-marker-cell],
[data-truncate-fill] {
  display: none;
}

[data-truncate-group-container='middle'],
*:not([data-truncate-segment-priority]) > [data-truncate-container] {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-truncate-group-container='middle'] > [data-truncate-segment-priority],
[data-truncate-segment-priority] > [data-truncate-container],
[data-truncate-container] [data-truncate-grid],
[data-truncate-container] [data-truncate-grid] > div:not([data-truncate-marker-cell]):not([data-truncate-fill]),
[data-truncate-content='visible'],
[data-truncate-content='visible'] > span {
  display: inline;
}
`;
