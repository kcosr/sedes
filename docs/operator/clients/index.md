# Packaged clients

Sedes includes buildable Android and Electron client projects. They package the
same frontend used by the browser. Android connects to an operator-run server.
Electron can additionally start one packaged Local server for its application
session on Linux, macOS, or Windows, or manage an OpenSSH loopback forward to a
separately operated server on any supported desktop platform. Linux Bubblewrap
optionally enables Pi isolated-workspace execution for Local.
Direct and SSH servers must explicitly allow the packaged client's fixed
application origin.

These clients are source-build previews. The repository does not publish
release-signed Android packages or signed/notarized desktop installers.

| Client | Packaged origin | Current build output | Distribution status |
| --- | --- | --- | --- |
| [Android](android.md) | `http://localhost` | Debug APK and unsigned release-shaped APK | Buildable preview; no release signing or final version mapping |
| [Electron](electron.md) | `capacitor-electron://localhost` | Host-platform unpacked app and installer artifacts | Buildable preview; no code signing or notarization |

## How the clients fit together

```text
packaged frontend                         selected Sedes server
┌──────────────────────────┐              ┌─────────────────────────────┐
│ Android WebView or       │  HTTP(S),    │ Sedes API and event streams │
│ Electron renderer        │  SSE, and WS │ provider backends           │
│                          ├─────────────►│ application state           │
│ selected server origin   │              │ allowed workspace roots     │
└──────────────────────────┘              └─────────────────────────────┘
```

The Electron package also contains a current-platform compiled server runtime
and its Electron-ABI native modules. Managed Local configuration and state are
created beneath Electron's user-data directory; provider credentials, native
conversation stores, and provider-owned executables remain external. Android
contains no server runtime, and Direct/SSH server state remains on the
separately operated host.

## Choose a connection

This table covers the client layer only. For how a client connection
relates to provider runtimes and execution environments, and for the
meaning of "Local" in each layer, read the
[Connection model](../connections.md).

| Connection | Android | Electron | Security characteristics |
| --- | --- | --- | --- |
| Managed Local | No | Linux, macOS, Windows | App-session server on ephemeral loopback; desktop account authority; no background service; `/usr/bin/bwrap` optionally enables Pi isolated workspaces on Linux |
| Same-host loopback | Emulator only, or physical device through `adb reverse` | Yes | Preferred for local development; traffic does not traverse the LAN |
| Managed SSH to remote loopback | No | Yes | Uses the desktop account's system OpenSSH alias and a temporary loopback-only forward; Sedes authentication is unchanged |
| Tailscale Serve | Yes | Yes | Preferred remote path; Sedes stays on loopback and Serve provides HTTPS |
| Operator-controlled HTTPS proxy | Yes | Yes | Appropriate when the proxy supplies a trusted private access boundary |
| Direct trusted-home-LAN HTTP | Yes | Yes | Explicit preview option; paired credentials travel unencrypted, with one exact RFC1918 Host |
| Public listener or Tailscale Funnel | No | No | Unsupported and unsafe |

Start with the platform guide:

- [Build, connect, and verify Android](android.md)
- [Build, connect, and verify Electron](electron.md)

For server startup, state, backups, Tailscale Serve, and the complete deployment
boundary, see [Operations and security](../operations.md).

## Common separately operated server requirements

The packaged application origins are fixed and code-owned. Enable only the
client types an installation actually uses in its schema-version-11 bootstrap
file:

```json
{
  "schemaVersion": 11,
  "packagedClients": ["android", "electron"]
}
```

The object above is a complete minimal bootstrap. Entries form a closed, unique
list. They admit the corresponding application origins to Sedes's
bounded CORS, preflight, CSRF, and stream contracts. They do not:

- start or configure a packaged client;
- expose a loopback server to another device;
- authenticate the person or program using the endpoint; or
- weaken Host validation to accept arbitrary interface addresses.

Omit a client type when it is not in use. Omitting `packagedClients` admits
neither packaged application origin.
Managed Local supplies a code-owned server file containing only the Electron
client admission and its loopback listener internally; the invoking shell does
not configure those values.

## Shared security boundary

Sedes exposes one server-derived local principal. A paired management
credential grants access to that principal's prompts, transcripts, thread
controls, uploads, tasks, and allowed file roots. Production APIs, event
streams, WebSockets, and content routes enforce authentication by default. The bundled
frontend is public so new clients can reach pairing. CORS, Fetch Metadata,
Host validation, and CSRF checks remain independent deployment protections.
See [Pairing clients](../operations.md#pairing-clients) for enrollment and revocation.

When application terminals are available, that authority can include an
interactive local or Sidecar SSH shell. The explicit packaged-client
trusted-LAN mode admits that terminal authority too; use it only when every
client able to reach the endpoint is trusted. Prefer loopback or an admitted
private HTTPS boundary.

Consequently:

- keep Sedes on loopback whenever possible;
- prefer `adb reverse`, same-machine Electron, or a private HTTPS boundary;
- never use Tailscale Funnel or expose the listener publicly;
- use direct LAN HTTP only where every device able to reach the port is
  trusted, and restrict that port with host and network firewalls; and
- treat supplemental workspace roots and uploaded content as exposed to the
  same network trust boundary as the management API.

## Compatibility and upgrades

The packaged frontend and server share a protocol version. A mismatched client
fails with the protocol-mismatch screen instead of attempting to interpret an
incompatible response. The mismatch message names both builds, the packaged
client's own version and the server's when the server reports one. Rebuild and
reinstall the packaged client from the source revision matching the server's
reported version. A server that predates the version field reports none;
upgrade the server first, then rebuild the client.

Connection configuration is client-local. Android stores multiple named Direct
profiles and one selected profile;
Electron exposes one code-owned Local connection, stores multiple named Direct
or SSH profiles, and remembers the last connection that completed server
session validation. Changing the active connection replaces the client runtime
and disposes its streams and owned WebSockets. SSH forwards are closed exactly.
When leaving Local, Electron asks for confirmation, keeps the Local process
while the candidate is validated, restores Local on failure or cancellation,
and stops it before publishing a successful replacement. Switching never
migrates server state, provider conversations, credentials, or Tool client
records. Credentials are stored separately in native encrypted storage, bound
to the profile and server origin. The ordinary browser remains same-origin and
uses an HttpOnly cookie; it does not share the packaged profile store.
