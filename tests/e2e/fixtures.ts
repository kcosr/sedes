import {
  expect,
  test as base,
  type ConsoleMessage,
  type Request,
  type Response,
} from "@playwright/test";

const configuredBaseUrl = process.env.E2E_BASE_URL;
if (!configuredBaseUrl) throw new Error("E2E_BASE_URL is required.");
const configuredOrigin = new URL(configuredBaseUrl).origin;

export interface BrowserDiagnostics {
  allowNetworkFailures: boolean;
}

function sameOrigin(url: string, currentPageUrl: string): boolean {
  try {
    const current = new URL(currentPageUrl);
    if (current.protocol === "http:" || current.protocol === "https:") {
      return new URL(url).origin === current.origin;
    }
  } catch {
    // The page can still be about:blank during its first navigation.
  }
  return url.startsWith(`${configuredOrigin}/`);
}

function consoleDescription(message: ConsoleMessage): string {
  return `console.${message.type()}: ${message.text()}`;
}

function requestDescription(request: Request): string {
  return `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`;
}

function responseDescription(response: Response): string {
  return `${response.status()} ${response.request().method()} ${response.url()}`;
}

export const test = base.extend<{
  browserDiagnostics: BrowserDiagnostics;
}>({
  browserDiagnostics: [
    async ({ page }, use) => {
      const diagnostics: BrowserDiagnostics = { allowNetworkFailures: false };
      const failures: string[] = [];
      page.on("pageerror", (error) =>
        failures.push(`pageerror: ${error.message}`),
      );
      page.on("console", (message) => {
        if (message.type() === "error" && !diagnostics.allowNetworkFailures) {
          failures.push(consoleDescription(message));
        }
      });
      page.on("requestfailed", (request) => {
        if (
          sameOrigin(request.url(), page.url()) &&
          !diagnostics.allowNetworkFailures &&
          !(
            (request.url().includes("/events") ||
              request.url().includes("/files/download?") ||
              // Usage availability is a read-only POST batch. Closing or
              // navigating away from its view deliberately cancels the read.
              (request.method() === "POST" &&
                /^\/api\/threads\/[^/]+\/usage\/turn-availability$/u.test(new URL(request.url()).pathname)) ||
              // Settings and variable previews explicitly abort stale reads
              // on close/selection change; mutation failures remain visible.
              (request.method() === "GET" &&
                (/^\/api\/configuration(?:\/|$)/u.test(new URL(request.url()).pathname) ||
                  new URL(request.url()).pathname === "/api/workspaces" ||
                  new URL(request.url()).pathname === "/api/host-registrations" ||
                  new URL(request.url()).pathname === "/api/environment-variables/preview"))) &&
            request.failure()?.errorText.includes("ERR_ABORTED")
          )
        ) {
          failures.push(requestDescription(request));
        }
      });
      page.on("response", (response) => {
        if (
          sameOrigin(response.url(), page.url()) &&
          response.status() >= 500 &&
          !diagnostics.allowNetworkFailures
        ) {
          failures.push(responseDescription(response));
        }
      });

      await use(diagnostics);
      expect(failures, "unexpected browser or same-origin failures").toEqual(
        [],
      );
    },
    { auto: true },
  ],
});

export { expect };
