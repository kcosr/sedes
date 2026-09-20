type ClientPlatform = {
  userAgentData?: { platform: string };
  platform?: string;
  userAgent?: string;
};

// Electron renderers expose the same navigator platform information as Chromium.
// This intentionally describes the client, never the remote bridge host.
export function isWindowsClient(
  client: ClientPlatform = typeof navigator === "undefined" ? {} : navigator,
): boolean {
  if (/Android|iPhone|iPad|Windows Phone/i.test(client.userAgent ?? "")) return false;
  const platform = client.userAgentData?.platform || client.platform;
  return platform ? /^win/i.test(platform) : /Windows NT/i.test(client.userAgent ?? "");
}

