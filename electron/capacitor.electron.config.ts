import { defineConfig } from '@capawesome/capacitor-electron/config';
import type { Session, WebContents } from 'electron';

const PACKAGED_RENDERER_PROTOCOL = 'capacitor-electron:';
const PACKAGED_RENDERER_HOST = 'localhost';

type PermissionCheckHandler = NonNullable<
  Parameters<Session['setPermissionCheckHandler']>[0]
>;

type PermissionRequestHandler = NonNullable<
  Parameters<Session['setPermissionRequestHandler']>[0]
>;

function isPackagedRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === PACKAGED_RENDERER_PROTOCOL &&
      url.hostname === PACKAGED_RENDERER_HOST &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

function allowsPackagedClipboardWrite(
  windowWebContents: WebContents,
  requestingWebContents: WebContents | null,
  permission: string,
  requestingUrl: string,
  isMainFrame: boolean,
): boolean {
  return (
    permission === 'clipboard-sanitized-write' &&
    requestingWebContents === windowWebContents &&
    isMainFrame &&
    isPackagedRendererUrl(requestingUrl)
  );
}

export default defineConfig({
  scheme: 'capacitor-electron',
  hostname: 'localhost',
  window: {
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
  },
  csp: {
    policy:
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' data: http: https: ws: wss:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
  },
  hooks: {
    onWindowCreated(window) {
      const session = window.webContents.session;
      const handlePermissionCheck: PermissionCheckHandler = (
        webContents,
        permission,
        requestingOrigin,
        details,
      ) =>
        allowsPackagedClipboardWrite(
          window.webContents,
          webContents,
          permission,
          details.requestingUrl ?? requestingOrigin,
          details.isMainFrame,
        );
      const handlePermissionRequest: PermissionRequestHandler = (
        webContents,
        permission,
        callback,
        details,
      ) =>
        callback(
          allowsPackagedClipboardWrite(
            window.webContents,
            webContents,
            permission,
            details.requestingUrl,
            details.isMainFrame,
          ),
        );
      session.setPermissionCheckHandler(handlePermissionCheck);
      session.setPermissionRequestHandler(handlePermissionRequest);
    },
  },
});
