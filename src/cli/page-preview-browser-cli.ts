import {
  installPagePreviewBrowser,
  pagePreviewBrowserDirectory,
  PagePreviewBrowser,
  type PagePreviewBrowserStatus,
} from "../server/pages/preview-browser.js";
import type { SedesCliIo } from "./sedes-cli.js";

const usage = `Usage:
  sedes page-preview-browser status
  sedes page-preview-browser install

Run as the Sedes server's operating-system account with its environment.
Install downloads only the pinned Chromium preview browser into the server's
cache, then checks that it starts with its sandbox enabled. It does not install
system packages, start Sedes, or alter provider and client installations.
SEDES_PAGE_PREVIEW_BROWSER_DIRECTORY selects an absolute cache directory.

Exit codes: 0 ready, 1 unavailable or installation failed, 2 usage error.
`;

export async function runPagePreviewBrowserCli(args: readonly string[], dependencies: {
  environment?: NodeJS.ProcessEnv;
  io?: SedesCliIo;
  status?: () => Promise<PagePreviewBrowserStatus>;
  install?: typeof installPagePreviewBrowser;
} = {}): Promise<number> {
  const io = dependencies.io ?? process;
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    io.stdout.write(usage);
    return 0;
  }
  if (args.length !== 1 || !["status", "install"].includes(args[0]!)) {
    io.stderr.write(usage);
    return 2;
  }
  const environment = dependencies.environment ?? process.env;
  try {
    const directory = pagePreviewBrowserDirectory(environment);
    if (args[0] === "install") {
      await (dependencies.install ?? installPagePreviewBrowser)({ environment, directory, stdout: io.stdout, stderr: io.stderr });
    }
    const status = await (dependencies.status ?? (() => new PagePreviewBrowser({ environment, directory }).status()))();
    io.stdout.write(`${JSON.stringify(status)}\n`);
    return status.ready ? 0 : 1;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : "Preview browser command failed."}\n`);
    return 1;
  }
}
