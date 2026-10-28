import { defineConfig } from '@capawesome/capacitor-electron/config';
import type { Session } from 'electron';
import { allowsPageFrameNavigation } from './page-frame-policy.js';
import { allowsPackagedPermission } from './media-permission-policy.js';

type PermissionCheckHandler = NonNullable<
  Parameters<Session['setPermissionCheckHandler']>[0]
>;

type PermissionRequestHandler = NonNullable<
  Parameters<Session['setPermissionRequestHandler']>[0]
>;

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
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' data: http: https: ws: wss:; frame-src 'self' http: https:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
  },
  hooks: {
    onWindowCreated(window) {
      const session = window.webContents.session;
      window.webContents.on('will-frame-navigate', (event) => {
        if (!allowsPageFrameNavigation({
          isMainFrame: event.isMainFrame,
          url: event.url,
          initiatorUrl: event.initiator?.url,
        })) event.preventDefault();
      });
      window.webContents.on('will-redirect', (event) => {
        if (!event.isMainFrame) event.preventDefault();
      });
      const handlePermissionCheck: PermissionCheckHandler = (
        webContents,
        permission,
        requestingOrigin,
        details,
      ) =>
        webContents === window.webContents && allowsPackagedPermission({
          permission,
          requestingUrl: details.requestingUrl ?? requestingOrigin,
          isMainFrame: details.isMainFrame,
          mediaTypes: details.mediaType ? [details.mediaType] : undefined,
        });
      const handlePermissionRequest: PermissionRequestHandler = (
        webContents,
        permission,
        callback,
        details,
      ) =>
        callback(
          webContents === window.webContents && allowsPackagedPermission({
            permission,
            requestingUrl: details.requestingUrl,
            isMainFrame: details.isMainFrame,
            mediaTypes: 'mediaTypes' in details ? details.mediaTypes : undefined,
          }),
        );
      session.setPermissionCheckHandler(handlePermissionCheck);
      session.setPermissionRequestHandler(handlePermissionRequest);
    },
  },
});
