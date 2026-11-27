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
together.

See the [operator guide](../../../docs/operator/backends/opencode.md) for
runtime admission and the [2.2.6 profile](../2.2.6/README.md) for historical
qualification evidence.
