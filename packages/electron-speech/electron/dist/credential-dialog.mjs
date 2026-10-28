import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { object, providerBinding, safeFailure, speechError } from "./contracts.mjs";

const pagePath = fileURLToPath(new URL("./credential-dialog.html", import.meta.url));
const preloadPath = fileURLToPath(new URL("./credential-preload.cjs", import.meta.url));
const pageUrl = pathToFileURL(pagePath).href;

export function isCredentialSender(event, window) {
  return !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === pageUrl;
}

/** A separate session, file origin, and private IPC channel keep tokens out of the app bridge. */
export function showCredentialDialog({ provider, endpoint, parent, credentials, BrowserWindow, session, ipcMain, onChange = () => {} }) {
  ({ provider, endpoint } = providerBinding({ provider, endpoint }));
  const channel = `sedes-speech-credential-${randomUUID()}`;
  const isolatedSession = session.fromPartition(`speech-credential-${randomUUID()}`);
  isolatedSession.setPermissionCheckHandler(() => false);
  isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  isolatedSession.on("will-download", (event) => event.preventDefault());
  isolatedSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== pageUrl }));
  const window = new BrowserWindow({
    parent, modal: true, show: false, width: 560, height: 420, resizable: false, minimizable: false, maximizable: false,
    autoHideMenuBar: true, title: provider === "openai" ? "OpenAI API key — Sedes" : "Speech server token — Sedes",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false,
      session: isolatedSession, preload: preloadPath,
      additionalArguments: [`--sedes-speech-channel=${channel}`, `--sedes-speech-provider=${provider}`] },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  let busy = false;
  let mutation;
  let completed = false;
  const result = new Promise((resolve, reject) => {
    ipcMain.handle(channel, async (event, input) => {
      if (!isCredentialSender(event, window)) return { error: "The credential dialog request was rejected." };
      try {
        object(input, ["action", "token"]);
        if (input.action !== "save" && Object.hasOwn(input, "token")) throw new Error();
        if (input.action === "status") return { provider, endpoint, ...await credentials.status(endpoint) };
        if (input.action === "cancel") { window.close(); return {}; }
        if (!["save", "remove"].includes(input.action) || busy) throw speechError("speech_credential_busy", "The credential dialog is busy.");
        busy = true;
        try {
          mutation = (async () => {
            if (input.action === "save") await credentials.save(endpoint, input.token);
            else await credentials.remove(endpoint);
            onChange();
          })();
          await mutation;
          if (!window.isDestroyed()) window.close();
          return {};
        } finally { busy = false; }
      } catch (error) { return { error: safeFailure(error).message }; }
    });
    window.once("ready-to-show", () => { if (!window.isDestroyed()) window.show(); });
    window.once("closed", () => {
      ipcMain.removeHandler(channel);
      if (!completed) {
        completed = true;
        // Closing during a secure-storage write must not return the old status.
        // Mutation errors belong to the dialog action that already displayed them.
        // The caller receives current status, including an actual status-read failure.
        Promise.resolve(mutation).catch(() => undefined).then(() => credentials.status(endpoint))
          .then(resolve, (error) => reject(safeFailure(error)));
      }
    });
    window.loadFile(pagePath).catch(() => {
      if (!completed) { completed = true; reject(speechError("speech_credential_dialog_failed", "The speech credential dialog could not be opened.")); }
      window.destroy();
    });
  });
  return { result, close: () => { if (!window.isDestroyed()) window.close(); } };
}
