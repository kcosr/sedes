/** A connector uses the operator's HTTP origin for both downloads and sockets. */
export function outboundServerUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('outbound_server_url_invalid');
  }
  return url;
}

export function outboundWebSocketUrl(server: URL, pathname: string): URL {
  const url = new URL(pathname, outboundServerUrl(server.href));
  if (url.origin !== server.origin || !pathname.startsWith('/')) throw new Error('outbound_endpoint_invalid');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

export function outboundArtifactUrl(server: URL, value: string): URL {
  const url = new URL(value, outboundServerUrl(server.href));
  if (url.origin !== server.origin || url.username || url.password || url.hash || url.search || !url.pathname.startsWith('/api/outbound/artifacts/')) {
    throw new Error('outbound_artifact_url_invalid');
  }
  return url;
}
