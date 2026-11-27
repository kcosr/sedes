# OpenCode v2 2.3.0 protocol profile

The development and server-runtime lockfiles pin the official
`@opencode/client`, `@opencode/protocol`, and `@opencode/schema` packages to
2.3.0. The source is upstream [v2.3.0](https://github.com/anomalyco/opencode/tree/v2.3.0)
at revision `a6b15d33daf6ab7d35569f6d711fdb630b9f04e7`.

The assistant message's optional `time.firstToken` field and the
`session.step.first-token` event are parsed by the same strict native schemas as
the rest of the history and event stream. The timestamp stays private to the
OpenCode integration. Normalized history and the browser protocol keep their
existing shape.

Runtime admission remains independent of the pinned SDK packages. Stable stock
OpenCode 2.2.6 and newer use the same schema profile. Prereleases and runtimes
below 2.2.6 are rejected. The provider-private `opencode_runtime` capability
uses major 6 over sidecar wire 18. Update the server and OpenCode sidecars
together. The tested-through release is 2.3.0. Higher stable releases display
the newer-than-tested advisory.

## Qualification on Linux x64

On 2026-11-27, stock 2.2.6 and 2.3.0 each passed all 52 isolated loopback tests. These include
history projection, MCP discovery and use, detached-child cleanup, and owned
and external runtimes over local, SSH and paired outbound connections. The
official 2.3.0 `opencode-linux-x64.tar.gz` release asset had SHA-256
`fc0f81522aceeabac47693d88389efa2bc517ce74c2c38fd6967819fcc6e4d3b`.

The separately authorized read-only canary passed on the initial candidate
and the final build on stock 2.3.0 with the
`aw-qwen-3-8-27b` model, low reasoning, a 256-token output limit and the
two-model-step budget. This live result covers that model and host platform.

See the [operator guide](../../../docs/operator/backends/opencode.md) for
runtime admission and the [2.2.6 profile](../2.2.6/README.md) for historical
qualification evidence.
