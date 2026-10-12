# Optional HTML preview browser

HTML publishing and viewing work without a server browser. The `page.preview`
agent tool optionally renders an HTML file with captured local images, or a
self-contained HTML string, returning a PNG screenshot, bounded console messages, and measured
dimensions. It does not publish or change a page revision.

The Playwright library is a pinned production dependency, currently 1.62.0.
The matching Chromium binary is a separate, explicit installation. It runs on
the Sedes server only. Remote execution hosts, Android clients, and Electron
client-only installations do not need it. An Electron Managed Local server
uses the browser installed for its local operating-system account.

## Install and check

Run these commands as the operating-system account that runs the server, with
the same cache-related environment. From a built source checkout or an
extracted server package:

```sh
node dist/cli/sedes-cli-main.js page-preview-browser install
node dist/cli/sedes-cli-main.js page-preview-browser status
```

Where the `sedes` executable is installed, these are also available as
`sedes page-preview-browser install` and `sedes page-preview-browser status`.
The commands work in Windows PowerShell and in macOS/Linux shells. The install
command downloads the pinned Chromium build without installing operating-system
packages, then performs the same sandboxed render check as `status`. Status
returns JSON and exits zero only if a real test render and browser shutdown
succeed. An installed binary alone is not reported as ready.

The browser defaults to a separate Sedes cache:

- Windows: `%LOCALAPPDATA%\Sedes\page-preview-browser`.
- macOS: `~/Library/Caches/Sedes/page-preview-browser`.
- Linux: `${XDG_CACHE_HOME:-~/.cache}/sedes/page-preview-browser`.

Set `SEDES_PAGE_PREVIEW_BROWSER_DIRECTORY` to an absolute directory to select
another cache. Use the same value for installation and the server process.
The ordinary Playwright test cache and `PLAYWRIGHT_BROWSERS_PATH` do not select
this production cache. Browser installation never runs during server startup,
publishing, or a preview request. Library upgrades may require rerunning the
install command; existing browser revisions are retained for other installed
Sedes releases.

For offline deployment, prepare the cache with the exact Sedes library version
on the same operating system and CPU architecture, then transfer it preserving
permissions. Run `status` on the destination. Browser caches are optional
runtime assets, not part of the source archive or application database backup.

## Operating-system requirements

Playwright's [supported systems](https://playwright.dev/docs/intro#system-requirements)
currently include Windows 11 and Windows Server 2019 or later, macOS 14 or
later, and Debian 12/13 or Ubuntu 22.04/24.04/26.04 on supported x86-64/ARM64
architectures. Sedes' own platform support and the preview browser's support
are separate: an older system may still publish and view pages while lacking
the optional screenshot capability. Windows and macOS require verification
on their actual target systems; a Linux test does not establish native support.

Linux also requires Chromium's system libraries and a working browser sandbox.
An administrator can use the pinned package's
[system dependency installer](https://playwright.dev/docs/browsers#install-system-dependencies),
for example `node node_modules/playwright/cli.js install-deps chromium`, where
appropriate for the host's package manager. The Sedes install command never
elevates privileges. A restricted container may deny the sandbox even when all
libraries are present. Sedes does not retry with `--no-sandbox`.

The download follows Playwright's supported proxy and download-host variables,
including `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, and
`PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST`. See
[Playwright browser installation](https://playwright.dev/docs/browsers).
These settings apply to the explicit installer, not to rendered documents.

## Rendering and isolation

Each request receives a fresh Chromium process and browser context. Chromium's
sandbox stays enabled. The rendered document has a trusted outer wrapper and an
opaque, sandboxed inner frame containing the authored HTML. The immutable
revision stores the captured authored payload; rendering adds the current
trusted wrapper and bootstrap, so security fixes also protect older revisions.
This is the same document used by the published viewer. The composed document
allows up to 32 MiB of escaped payload plus 64 KiB of trusted rendering overhead;
the captured authored document itself remains limited to 16 MiB. Its content security
policies allow inline HTML/CSS/JavaScript and captured data images, while
denying network connections, authored nested frames, workers, forms, and remote
assets. Only the initial in-memory document is served through a request
interceptor. All other requests and WebSocket connections are denied. A
loopback proxy and WebRTC restrictions provide additional network isolation.
No authenticated Sedes endpoint or provider credential is supplied to the page.

The published viewer's Content Security Policy is not an operating-system
network sandbox. It restricts HTTP resource loading, fetch/WebSocket connections,
and document navigation, but browser features outside those directives can
still initiate traffic. For example, a script-created local `srcdoc` frame gets
fresh WebRTC constructors and can send STUN traffic. The importer never fetches
HTTP assets, and this limitation does not grant access to Sedes credentials,
application storage, or native plugins. A deployment requiring all generated
code to have no network access needs a separate host/browser egress boundary;
the published viewer does not provide one.

The browser's temporary automation listener binds to loopback on a random port
with Playwright's unguessable connection path and lives only for that request.
It does not expose a remote-control HTTP API to users or agents.

At most two previews run concurrently in one server process. Launch, rendering,
and shutdown have deadlines. Cancellation and timeouts close the browser; an
unresponsive graceful close escalates to Playwright's owned process-tree
termination. Application shutdown stops new previews immediately, cancels all
active previews, and waits for in-flight launches and browser cleanup. The
preview browser does not install its own process signal handlers. If cleanup
cannot be confirmed, shutdown reports the failure and previews remain disabled
until the server restarts.

The default preview width is 768 CSS pixels. An explicit width preserves the
requested layout, and an explicit height preserves that viewport. Otherwise
the screenshot fits the measured body height, capped at 8192 pixels. The viewer
and preview browser share a bounded sizing rule: viewport-relative layouts
such as `min-height: 100vh` with margins do not repeatedly enlarge the frame.
Width is capped at 4096 pixels.

After layout, the screenshot is automatically scaled to at most 2000 pixels on
its longest side for model compatibility. This scales the captured image only;
it does not change the page's CSS viewport, media queries, or layout. Result
metadata reports the original viewport and content dimensions separately from
the delivered PNG dimensions. Every tool transport receives the same scaled
PNG. Output is limited to 2 MiB and 100 bounded console entries; an unusually
detailed image that still exceeds the byte limit needs a smaller preview.
Screenshots are ephemeral tool results; publishing the source creates the
durable revision.

For an explicit source-checkout verification after installation, run
`env -u NODE_ENV SEDES_TEST_PAGE_PREVIEW_BROWSER=1 npx vitest run tests/integration/page-preview-browser-installed.test.ts`.
This launches the real sandboxed browser and checks measurement isolation from
authored JavaScript globals. Ordinary unit tests leave this optional check off.
