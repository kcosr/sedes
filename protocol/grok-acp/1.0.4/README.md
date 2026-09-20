# Grok ACP 1.0.4 production profile

This directory establishes Grok Build 1.0.4 as the reviewed floor for the
stable `1.x` ACP compatibility line. The captured `d846eb93d9` executable is
retained as exact regression evidence; production runtime admission accepts
stable 1.x releases at or above 1.0.4 unless an exact release is explicitly
excluded after review.

The production codec remains provider-private. Browser and shared backend
contracts receive only normalized Sedes data. Private routes and lifecycle
behavior remain covered by focused fake-peer tests and the production-shaped
native live suite. Standard ACP image mechanics visible in the reviewed 1.0.4
source are pinned independently in `source-image-mechanics.json`.

The candidate observed in O0 reports stable release `1.0.4`, build
`d846eb93d9`, and executable SHA-256
`79f49625f153923db491a5c290e9b04c3444da488b6b9d6aac533ccb5bff2455`.
Those facts identify the captured binary, not the whole compatibility line.
The version-named directory alone does not establish runtime admission; the
production release guard independently verifies a stable 1.x version at or
above the reviewed floor and a bounded build identity. The reported channel is
descriptive rather than admission authority; an
isolated home may report `unknown` for the same exact path/stat/hash/build.

## Reviewed evidence

- **O0 — provenance and contained static execution:** captured. The original
  binary was verified without execution, copied through an opened descriptor
  into a private mode-0700 staging root, installed as a mode-0500 executable,
  mounted from a retained verified read-only descriptor, and reverified before
  and after use. Only four closed version/help commands ran against that exact
  staged artifact, each in a fresh minimal-root Bubblewrap
  user/PID/network namespace with empty stdin, bounded streams and time, and
  owned process-group cleanup. No host home, credential store, host root, ACP
  input, authentication, or provider network was available. The earlier draft
  unsandboxed capture was replaced and is not retained.
- **O1 — contained pre-initialize startup:** captured. The exact verified
  candidate started stdio in a fresh rootless filesystem/process/network
  sandbox without credentials and received no ACP traffic. During the bounded
  observation it produced zero protocol frames and zero stdout/stderr bytes,
  used no provider capacity, and cleanup removed the sandbox and staged
  executable. Startup was not filesystem-side-effect-free: within the isolated
  home it updated local Grok configuration and created session bookkeeping,
  lock/metadata, log, README, and bundled user-guide state. The canonical
  evidence is `evidence/o1/capture.json` (SHA-256
  `7d11c6939ddae0cb498bb155032a90f5d6e65f594587f4130b2c7783618b53b4`).
- **O2a — initialize-only ACP:** captured. One initialize request was sent to
  the exact staged candidate in a fresh no-network sandbox with no advertised
  client filesystem or terminal authority. The response selected protocol
  version 1, omitted `agentInfo`, advertised one agent authentication method,
  and structurally advertised load plus list/resume/close session operations;
  embedded prompt context; HTTP/SSE MCP transport; and authentication, while
  image/audio prompts, ACP MCP transport, providers, NES, position encoding,
  session fork/delete/additional-directories, and logout were false or absent.
  These are contained initialize observations, not production semantic or
  capability claims. During the 750 ms bounded post-response observation, one
  unused 81-byte notification was ignored under the generic count/byte budget.
  Its route and payload were neither retained nor treated as evidence, and the
  bounded interval is not a claim of global startup quiescence. Local side
  effects within the isolated home included configuration, identity/session
  bookkeeping, logs, bundled docs, session-search state, and the worktree
  database. No authentication, session
  creation, prompt, tool, or provider capacity occurred. The canonical evidence
  is `evidence/o2a/capture.json` (SHA-256
  `7657352425f23f4d1f5dc79ae5543ebae17a906b3efc42e2f84f7283e62809da`).
- **O2b — retired offline characterization:** no capture is required. The
  production backend does not depend on this former investigation step.
- **L-readonly — authorized minimal live gate:** captured. The exact verified
  candidate initialized with no client filesystem or terminal authority,
  advertised and completed cached-token authentication from one fresh OIDC
  entry staged in a disposable home, and returned zero sessions with no cursor
  for the exact fresh disposable cwd. The original credential source remained
  unchanged; the owned process and streams drained, assurance was revoked, and
  the staged executable and disposable root were removed before evidence
  publication. This is local credential continuity, not verified remote account
  identity. A separate content-free diagnostic attempt (not retained as
  evidence) reported method-not-found for the source-candidate
  `x.ai/auth/info` route, so the final gate does not call it. Model catalog
  support is outside this read-only capture: sibling source and integration
  clues are non-authoritative, and the gate does not call a model extension
  route. The production-shaped native suite below separately verifies the
  catalog. The canonical sanitized evidence is
  `evidence/l-readonly/capture.json` (SHA-256
  `ea0e21e316189fe9bb288c132e00a17a110db5ba57194931b0e8a9f4ba3a7c2d`).
  This capture does not establish prompt, tool, or replay behavior.

- **L — production-shaped native suite:** passed on 2026-08-16. The exact
  `1.0.4/d846eb93d9` executable ran through the same configuration, native
  environment, release guard, owned stdio transport, ACP connection, and
  lifecycle used by production. Grok used the operator's normal native
  `HOME`/`GROK_HOME` and provider-managed cached-token authentication. Sedes
  neither copied nor parsed a credential. The suite authenticated, decoded the
  model catalog, applied and verified the configured model/reasoning selection,
  created one provider-assigned session, completed one bounded text turn with
  durable correlation, closed the hosting process, started a second process,
  loaded authoritative replay, compared the normalized transcript, and
  unloaded the session. The disposable part was the test workspace/session,
  not the Grok home or account state.

The accepted L-readonly capture used a copied credential and disposable home
only as historical contained characterization. Production Grok uses the
operator's normal native `HOME`/`GROK_HOME`, lets Grok read and refresh its own
opaque native state, and reports authentication required when that state is not
logged in. Production code does not import the probe runners or read
`auth.json`.

Sedes supports the two reviewed provider-owned image operations, `ImageGen`
and `ImageEdit`. Their completed local JPEG outputs are copied into the durable
Sedes blob store and rendered as normalized output artifacts. Grok image
controls, remote provider-image readers, and unreviewed output shapes remain
unsupported. Tools and permission UX, fork/steer/queue, automation, and managed
terminals retain their documented dispositions.
Sedes records one common materialized-input snapshot before delivery. Grok
then projects Tasks as ordinary text, ordinary staged files as ordered standard
ACP `resource_link` blocks, and user-attached images through the generic
canonical-byte pipeline as exact ordered ACP
`{ type: "image", mimeType, data }` blocks. Provider history contributes the
native operation correlation; the common snapshot restores normalized browser
content, so staged paths and base64 never enter browser history or diagnostics.

## Source evidence

`source-route-candidates.json` inventories literal `_?x.ai/*` candidates from
two explicit public source revisions. The current 1.0.4-declaring source commit
and its exported `SOURCE_REV` do not match build `d846eb93d9`; the earlier
source revision is retained as comparison evidence. Candidate strings can be
comments, tests, URLs, inactive routes, or client-only surfaces. They prove
neither exact-binary presence nor direction, schema, negotiation, authority, or
runtime support.

`source-image-mechanics.json` separately pins the source-visible standard ACP
image ingest, canonical base64 decoding, standard resource-link ingest and
path projection, and model-level negative image-capability precedence. Grok's
top-level ACP capability advertises image input as false in the captured 1.0.4
initialize response even though this reviewed source path is implemented.
Sedes therefore treats the source-backed image-profile correction as narrowly
Grok-specific. A selected model's explicit `acceptsImages: false` or an
`inputModalities` list without `image` still wins.

Regenerate source candidates from the sibling source checkout with
`npm run extract:grok-source-routes`. Capture O0 only through the contained
staged-copy runner with `npm run capture:grok-o0`. Check all hashes, canonical
manifests, truthful evidence states, and basic credential/path sanitization with
`npm run check:grok-profile`.

## Licensing and provenance

This directory holds Sedes-authored profile decisions plus recorded hashes,
manifests, and sanitized capture evidence for a proprietary xAI Grok executable
(release 1.0.4, build `d846eb93d9`); the evidence files retain short captured
version/help output and observed initialize facts, not upstream code. No Grok
executable, tarball, or upstream source file is committed, and no upstream code
is redistributed. `source-route-candidates.json` and
`source-image-mechanics.json` record only short literal route strings and
mechanics observations taken from public `xai-org/grok-build` revisions. Sedes
installs no Grok npm package, so the upstream terms cannot be read from
installed package metadata (license: see upstream package metadata).
