# Getting started

This source-based quick start runs Sedes and its bundled Pi SDK on one trusted
Linux x64 or macOS Apple silicon/Intel computer. It ends with a remembered
project and a first completed agent turn.

Sedes uses passwordless client pairing. Keep the server on its
default loopback address until you have read
[Operations and security](../operator/operations.md).

## What you need

Required on a clean host:

- Linux x64, or macOS on Apple silicon or Intel;
- Git;
- Node.js 24.18 or newer;
- npm 11 or another version compatible with the checked-in lockfile; and
- a C/C++ compiler, `make`, and Python 3 if npm must build native Node modules
  instead of using an available prebuilt binary.

Check the important versions:

```sh
node --version
npm --version
git --version
```

The default example uses Pi. The Pi SDK is already bundled as a Sedes
dependency; you do not need a separate version-matched Pi executable or Pi RPC
service. You do need at least one provider/model authenticated and configured
in Pi's native environment for the same operating-system account and effective
`HOME` that will run Sedes. Pi credentials remain provider-owned and must not
be copied into Sedes configuration or the browser.

Optional features have additional prerequisites:

- Bubblewrap at `/usr/bin/bwrap` enables local isolated Pi workspaces on Linux;
  this optional isolation mode is unavailable on macOS.
- Claude requires the admitted authenticated Claude Code runtime.
- Codex requires an admitted authenticated executable or external app-server.
- Grok requires the admitted authenticated Linux x64 or macOS arm64/x64 Grok
  Build runtime.
- SSH workspace operations require the configured remote and sidecar
  prerequisites.
- Android and Electron packaging require their own SDK/toolchain setup.
  Electron's optional managed remote connection also requires a working system
  OpenSSH host alias and a separately running remote Sedes daemon; Electron
  does not install or start that daemon.

See [Provider features](provider-features.md) and the
[backend operator guides](../operator/backends/index.md) for exact supported
versions and alternative setup paths.

## Get the source

Clone the repository or open an existing clean checkout, then change into its
root—the directory containing `package.json`, `package-lock.json`, and
`config/server.example.json`.

```sh
git clone https://github.com/kcosr/sedes.git sedes
cd sedes
```

For a tagged release, check out the release tag before installing. Do not run
development builds from an unreviewed branch with production provider
credentials or state.

## Install dependencies

Always install with `NODE_ENV` unset:

```sh
env -u NODE_ENV npm ci
```

An exported `NODE_ENV=production` makes npm omit development dependencies,
which breaks the development launcher, tests, and build. `npm ci` uses the
checked-in lockfile and replaces the checkout's existing dependency tree.

If native-module installation fails on a minimal host, install the standard
compiler, make, and Python 3 packages for the distribution, then rerun the same
command. Do not switch to an unpinned package install to bypass a build error.

## Verify Pi authentication

Run Sedes from the same account and effective `HOME` used to configure Pi's
native provider. If this will eventually be a service, remember that a service
may have a different `HOME`, `PATH`, or Pi directory variables than your login
shell.

Sedes has no provider sign-in screen, so you confirm this after the server is
running and the Pi SDK backend is added, in the steps below. Never place
provider credentials in `server.example.json`.

## Start the development setup

The checked-in bootstrap starts the application without provider definitions:

```sh
env -u NODE_ENV npm run dev
```

The launcher uses `config/server.example.json` unless `SEDES_CONFIG_FILE` is
already set. The first start builds two runtime workers before listening. It
starts:

- the browser client at `http://127.0.0.1:5173`;
- the API at `http://127.0.0.1:4784`.

Both development ports are fixed, so free them first: the client refuses to
start when `5173` is in use, and `PORT` moves the API alone without the
development client following it. Change the API port only in a
production-shaped run; see
[Network ingress](../operator/configuration.md#network-ingress).

Open `http://127.0.0.1:5173` in a browser on the same computer. Keep the
terminal running while you use Sedes. Control+C stops the development
processes.

In another terminal, create a pairing URL using the same configuration and
state environment as the server:

```sh
SEDES_CONFIG_FILE="$PWD/config/server.example.json" \
  env -u NODE_ENV npx tsx src/cli/sedes-cli-main.ts auth pair --server http://127.0.0.1:5173
```

Open the returned URL and pair the browser. The code is single-use and expires
after five minutes. See [Pairing clients](../operator/operations.md#pairing-clients)
for revocation and packaged-client enrollment.

Before creating a project, open **Settings → Environments → Add environment → Local machine** and add **Local**
with the narrowest practical absolute workspace roots. Open that environment
and choose **Add backend**, select **Pi SDK**, then **Save backend**. Set its
**Model policy** and default [target](concepts.md#backend-and-target)
deliberately; the policy must admit at least one model Pi has authenticated.
Wait for available runtime status before submitting work.

These settings belong to your Sedes account on this server and follow you
across clients. A save can remain pending while runtime application is blocked;
check the displayed reason. Existing installations should use the operator's
[offline import](../operator/configuration.md#configuration-changes-and-rollback)
to preserve target IDs and old thread bindings.

## Open your first project

1. Choose **Add project** in the sidebar.
2. Keep the **Local** execution environment.
3. Browse to, or enter, an allowed absolute directory containing a small
   repository or project you are comfortable giving the agent access to.
4. Choose **Add project** again in the dialog to confirm.

Sedes remembers the directory as a project. It does not move the directory or
copy its files. Only remembered projects are scanned for eligible native
provider conversations.

## Create and complete the first thread

1. Choose **New thread**.
2. Enter a **Thread name** such as `Sedes smoke test`.
3. Keep the Pi target. The form offers **Environment**, **Target**, and
   **Project** only where more than one choice is eligible; choose explicitly
   whenever it asks.
4. Select the project you just added.
5. Choose **Custom** unless you already created a saved Agent.
6. Choose **Create thread**.
7. In the thread, choose an authenticated provider/model and conservative tool
   access before sending anything. If no authenticated model is offered, stop
   and follow the
   [Pi troubleshooting guide](../operator/backends/pi.md#troubleshooting).
8. Send a small, read-only prompt such as:

   ```text
   Summarize this project's purpose from its README. Do not edit files.
   ```

9. Wait for the response to complete, refresh the browser, reopen the thread,
   and confirm that its transcript and settings return.

Creating the thread made only a Sedes draft. The first Send created and bound
the native Pi conversation. Sedes saved the draft before crossing that
boundary; if the result becomes uncertain, follow the recovery callout rather
than sending the message again.

You now have a working development installation. Use the operator guide for
[production readiness and operation](../operator/index.md#production-readiness-checklist)
before running Sedes as a durable service or choosing another backend.

## Next steps

- [User guide](index.md)
- [Core concepts](concepts.md)
- [Conversations and the composer](conversations.md)
- [Organize and reuse work](organize-work.md)
- [Files and context](files-and-context.md)
- [Tasks and automations](tasks-and-automations.md)
- [Provider features](provider-features.md)
- [Settings](settings.md)
- [Troubleshooting and recovery](troubleshooting.md)
