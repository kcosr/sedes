/** Media is restricted to the packaged application's main frame. Generated
 * pages, cameras and screen capture never inherit microphone permission. */
export function allowsPackagedPermission(input: {
  permission: string;
  requestingUrl: string;
  isMainFrame: boolean;
  mediaTypes?: readonly string[];
}): boolean {
  if (!input.isMainFrame) return false;
  try {
    const url = new URL(input.requestingUrl);
    if (url.protocol !== 'capacitor-electron:' || url.hostname !== 'localhost' ||
      url.port !== '' || url.username !== '' || url.password !== '') return false;
  } catch { return false; }
  return input.permission === 'clipboard-sanitized-write' ||
    (input.permission === 'media' && input.mediaTypes?.length === 1 && input.mediaTypes[0] === 'audio');
}
