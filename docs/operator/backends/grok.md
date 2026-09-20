# Grok backend

Sedes supports Grok Build through a Sedes-owned ACP stdio process on local
Linux x64 or macOS arm64/x64. Choose it when you explicitly want the reviewed
unrestricted Grok profile, including native file/image input, plans, subagent
presentation, and completed generated or edited image artifacts.

- [Backend comparison](index.md)
- [Configuration reference](../configuration.md)
- [Grok maintainer reference](../../internals/backends/grok.md)

## On this page

- [Prerequisites and authentication](#prerequisites-and-authentication)
- [Configuration](#configuration)
- [Version compatibility](#version-compatibility)
- [Topology and security](#topology-and-security)
- [Capabilities and limits](#capabilities-and-limits)
- [Safe verification](#safe-verification)
- [Troubleshooting](#troubleshooting)
- [Opt-in live verification](#opt-in-live-verification)

## Prerequisites and authentication

- Install Grok Build on local Linux x64 or macOS arm64/x64. Sedes resolves the
  first executable `grok` on the service account's `PATH` unless the optional
  canonical absolute `executablePath` override is configured.
- Authenticate the native installation under the same operating-system account
  and effective native home used by Sedes.
- Keep normal `HOME` and any explicit `GROK_HOME` consistent between login and
  production startup.

Grok owns its credential storage and refresh lifecycle. Sedes never reads,
copies, parses, persists, or rotates provider tokens, and it never creates a
private Grok home. If the native installation is not logged in, the target
reports authentication required without exposing provider payloads or
credential details.

The Sedes native namespace is derived from the execution environment and
effective Grok home/config authority; it is not a verified provider-account
identifier. Changing accounts in the same native home does not change that
namespace, so Sedes does not claim cross-account continuity.

## Configuration

1. Add **Grok** with a local environment in **Settings → Backends**. Configure
   an executable override only when normal `PATH` lookup is inappropriate.
   The [schema-10 fixture](../../../config/legacy-import/server.grok.example.json)
   is only for explicit legacy import.
2. Keep the exact reviewed `security.profile: "unrestricted_v1"` shape.
3. Choose a deliberate `modelPolicy`. Grok matchers may constrain model IDs
   and reasoning efforts but cannot use `providerIds`.
4. Save and review applied runtime status and advisory diagnostics.

All enabled targets on a Grok backend are local and share one execution
environment/native configuration namespace. The sample's model defaults and
account state are operator inputs, not bundled provider configuration.

## Version compatibility

| Contract                           | Value                            |
| ---------------------------------- | -------------------------------- |
| Compiled ACP compatibility profile | `1.x`                            |
| Reviewed ACP profile and floor     | `grok-acp/1.0.4`; stable `1.0.4` |
| Runtime range                      | Stable `>=1.0.4`                 |
| Tested through                     | `1.0.4`                          |

Prereleases, older releases, malformed version/build evidence, and explicitly
excluded incompatible releases fail closed. Stable releases
newer than `1.0.4` are admitted with an installation advisory but continue to
use the same pinned reviewed parser and gain no new Sedes capabilities.
Protocol/profile mismatches still fail closed during initialization. Pin
`1.0.4` for the most conservative initial-release deployment.

## Topology and security

Only local, Sedes-owned process stdio is implemented. Each resident session
owns one Grok process. SSH, external daemons, containers, remote Grok output
paths, and shared multi-session processes are unsupported.

> **Security boundary:** Sedes launches Grok with
> `--permission-mode bypassPermissions --sandbox off`. Network access is
> enabled, and the process has the operating-system authority of the Sedes
> service account. This is full access, not workspace confinement. Review the
> selected project, account privileges, native tools, and network boundary
> before enabling the backend.

Until normalized Grok permission UX is implemented, an unexpected ACP
permission callback is accepted internally, preferring a one-shot allow
choice. Do not interpret the absence of a browser prompt as sandboxing.

## Capabilities and limits

| Area           | Supported                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------- |
| Lifecycle      | Create on first send, discovery/import, attach/reopen, unload, rename                     |
| Delivery       | Submit, Sedes-owned next-turn Queue, exact-active-turn Stop                               |
| History        | Bounded provider paging and normalized user/assistant/reasoning/tool/status history       |
| Semantic items | Command, file read/change, web search, MCP, plan, generic tool, parent-side collaboration |
| Settings       | Model and reasoning selection when creating a session; bound tuple is read-only           |
| Input          | Text, Tasks, staged files, and model-eligible native images                               |
| Output         | Completed local `ImageGen` and `ImageEdit` numbered JPEG artifacts                        |
| Agent tools    | Progressive or Individual Sedes CLI presentation to an exact active local thread         |

The following are intentionally unsupported and omitted from capabilities:

- Steer, compact, forks, active prompt injection, and bound-thread model
  switching;
- normalized permission controls, provider features, usage, automation, and
  managed terminals;
- selected skills and context excerpts in composer input;
- SSH/remote execution, external or shared daemons, and containers;
- remote URLs, video, other image-result shapes, image-generation controls,
  and a separate generated-image download flow.

Queue is application-owned: Sedes waits for authoritative turn settlement and
then starts an ordinary next turn. It does not claim a Grok-native queue or
Steer contract.

Image input and output are independent. Input requires attachment staging, an
admitted runtime, and a selected model that does not deny images. Output accepts
only a completed local `ImageGen` or `ImageEdit` JPEG beneath the exact native
session image directory, validates the raster and 16 MiB bound, and exposes
bytes only through Sedes's scoped artifact route.

## Safe verification

After startup:

1. Confirm the expected model and reasoning catalog and any installation
   advisory.
2. In a disposable project, send one small text turn and wait for its terminal
   result.
3. Test Stop on disposable work, then reload the native history.
4. Separately exercise staged ordinary-file input, supported image input, and
   generated or edited image output if the installation will rely on them.

These checks consume provider capacity and run with the unrestricted profile.
Use a disposable workspace without sensitive files; a small conversation smoke
does not prove image, subagent, or native-tool behavior.

## Troubleshooting

| Symptom                                                                     | Checks and resolution                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Executable is rejected before ACP startup                                   | Confirm local Linux x64 or macOS arm64/x64, that `PATH` resolves `grok` or the optional canonical override is valid, executable regular-file permissions, a compatible stable runtime, and valid JSON from native `version --json`. |
| Runtime version is incompatible                                             | Use stable `>=1.0.4`; prereleases, explicitly excluded releases, and malformed version/build evidence fail closed.                                                                                                                  |
| Runtime is newer than tested                                                | Pin `1.0.4`, or deliberately review the advisory and run the relevant opt-in live gate before adopting it.                                                                                                                          |
| Authentication works in a shell but not under Sedes                         | Compare service account, `HOME`, `GROK_HOME`, native config, and executable environment; authenticate the native installation for that service account.                                                                             |
| No models are selectable                                                    | Confirm ACP initialization returned a catalog, then inspect `modelPolicy`; `providerIds` are invalid for Grok.                                                                                                                      |
| Model/effort becomes read-only                                              | This is intentional after native `session/new`; create another thread for another tuple.                                                                                                                                            |
| Image input is rejected                                                     | Check staging, integrity/media validation, and model metadata. Explicit `_meta.acceptsImages: false` or modalities without `image` deny input.                                                                                      |
| Generated/edited image is omitted                                           | Verify it is a completed local `ImageGen`/`ImageEdit`, a valid numbered JPEG under the exact session directory, unchanged, and at most 16 MiB. Remote URLs, video, and unreviewed fields fail closed.                               |
| Steer, fork, compact, usage, automation, or permission controls are missing | They are intentionally unsupported. Use Sedes Queue for next-turn delivery.                                                                                                                                                         |
| Process disconnects or a mutation is uncertain                              | Let Sedes replace the fenced generation and reconcile from native history and the durable receipt. Do not retry from quiet time or approximate transcript matches.                                                                  |

Use [Debug diagnostics](../../developer/diagnostics.md) for bounded inspection.
Never include account files, tokens, raw ACP frames, base64 images, or complete
provider history in an issue.

## Opt-in live verification

The real-Grok suite consumes provider capacity and launches Grok with the same
unrestricted production arguments. Run it only after explicit approval:

```sh
SEDES_REAL_GROK=1 \
  SEDES_REAL_GROK_EXECUTABLE=/canonical/absolute/path/to/grok \
  env -u NODE_ENV npm run test:real-grok
```

For only the staged image/file input regression:

```sh
SEDES_REAL_GROK=1 \
  SEDES_REAL_GROK_EXECUTABLE=/canonical/absolute/path/to/grok \
  env -u NODE_ENV npm run test:real-grok -- \
  tests/real-grok/grok-image-input.test.ts
```

Generated-image output has an additional explicit gate because it asks the
provider to create and retain a native image:

```sh
SEDES_REAL_GROK=1 \
  SEDES_REAL_GROK_GENERATED_IMAGE=1 \
  SEDES_REAL_GROK_EXECUTABLE=/canonical/absolute/path/to/grok \
  env -u NODE_ENV npm run test:real-grok -- \
  tests/real-grok/grok-generated-image-output.test.ts
```

The suite retains the native session and does not use a disposable Grok home.
Lifecycle, image input, and generated-image output have distinct focused
surfaces; passing one does not live-verify the others. Maintainers should use
the [Grok contract and verification map](../../internals/backends/grok.md).
