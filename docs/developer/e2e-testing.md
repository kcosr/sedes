# E2E testing

Sedes runs browser coverage through an E2E coordinator. Use the npm scripts
in this document instead of invoking Playwright directly. The coordinator owns
the build boundary, operating-system-selected ports, disposable state, browser
artifacts, process cleanup, job scheduling, and the merged report.

For repository setup and the complete verification sequence, see
[Development and testing](development.md). The broader codebase and test
selection map is in the [Developer overview](overview.md#test-selection-matrix).

## Choose the right invocation

| Goal | Command |
| --- | --- |
| Final normal verification, including build | `npm run test:e2e` |
| One spec against a known-current build | `npm run test:e2e:prebuilt -- tests/e2e/example.spec.ts` |
| One named test against a known-current build | `npm run test:e2e:prebuilt -- --grep "exact test name"` |
| Full isolated default schedule without rebuilding | `npm run test:e2e:parallel:prebuilt` |
| Diagnose ordering with one lane | `npm run test:e2e:serial` |

Prefix commands with `env -u NODE_ENV`. Prebuilt commands check only that build
outputs exist, not that they are current.

## Performance guidance

The regression targets on the reference development host are:

- about 210 seconds for `npm run test:e2e`, including its build;
- about 200 seconds for `npm run test:e2e:parallel:prebuilt`, after a known
  current build.

A fresh worktree uses the committed rounded timing baseline, while successful
local runs can refine those estimates without changing tracked files. These
figures reflect the stable default four-lane schedule. They are same-host
regression signals, not acceptance gates, portable
Playwright timeouts, or a reason to weaken coverage or assertions on a slower machine.
Compare runs on an otherwise quiet host and use the `result.json` beneath the
run directory printed by the coordinator.

Aim for a new or materially changed job to take 15–45 seconds. Investigate a
job around 50 seconds. A new or changed job around 55 seconds or longer needs an
explicit reason and a measured full-suite result. If the full suite exceeds its
target, or regresses by more than about five seconds on the same quiet host,
investigate the critical path. Optimize when that preserves the correct test
boundary and realistic coverage; otherwise document why the slower job or
added coverage is worth the cost.

Do not split a genuine same-server state chain, create shared mutable fixtures,
replace realistic behavior with a misleading mock, loosen assertions, or drop
coverage merely to meet a timing target. Correctness and isolation are hard
requirements; the timing numbers guide engineering judgment.

## Scheduling and isolation contract

In parallel mode, every `tests/e2e/*.spec.ts` file is one indivisible job with
its own server, browser, operating-system-selected loopback port, application
state, workspace fixtures, screenshots, logs, and Playwright output. The
coordinator uses four lanes by default and schedules longer known jobs first.
Focused discovery caps the effective count to the number of matching jobs;
`--lanes=N` accepts an explicit value from 1 through 12 when a host or
diagnostic run calls for a different level of parallelism. Its estimate
precedence is the median of recent successful local per-file timings, then the
rounded values in
`tests/e2e/timing-baseline.json`, then a deterministic estimate based on
matched test count for a new file. Full run records remain ignored under
`test-results/`; only the minimal timing baseline is committed.

Write every spec so it passes alone against a fresh server. A spec must never
depend on another file warming a registry, creating database or workspace
state, navigating first, or running earlier. Do not use fixed ports, shared
temporary paths, shared `test-results` paths, or a separately launched E2E
server. Use the coordinator-provided run context and the existing fixture
helpers.

`test.describe.serial` preserves a real state chain inside one job; it also
makes that entire chain unsplittable. Use it only when later tests intentionally
verify state produced by earlier tests on the same server. Split independent
long chains into separate spec files. Do not fragment coverage into tiny files
only to create more lanes: each fresh job pays its own server and browser
startup cost.

Keep fixture work proportional to the behavior under test. Prefer a small,
purpose-built workspace over scanning the repository or manufacturing large
inventories. Wait for the exact response, event, DOM state, or persisted state
that proves readiness. Do not use arbitrary sleeps or inflate a generic timeout
to hide a race; a bounded animation or debounce wait is appropriate only when
that timing is itself the behavior under test and the reason is documented.

## Development workflow

After producing a known current build, iterate on the smallest relevant scope:

```sh
env -u NODE_ENV npm run test:e2e:prebuilt -- tests/e2e/example.spec.ts
env -u NODE_ENV npm run test:e2e:prebuilt -- --grep "exact test name"
```

`--prebuilt` requires existing `dist/client/index.html`,
`dist/server/index.js`, and `dist/sidecar/manifest.json`. The coordinator checks
existence, not freshness; build again whenever source may have changed.

Before handoff, run the ordinary coordinator so the build boundary and the
complete default four-lane suite are both exercised:

```sh
env -u NODE_ENV npm run test:e2e
```

To refresh the committed estimates after a successful, unfiltered full run,
pass that run's result explicitly:

```sh
env -u NODE_ENV npm run update:e2e-timing-baseline -- \
  test-results/e2e-runs/run-.../result.json
env -u NODE_ENV npm run check:e2e-timing-baseline
```

The updater rejects targeted, incomplete, or failed runs, rounds each job to
the nearest second, and rewrites only the sorted filename/estimate manifest.
Adding, renaming, or removing a spec requires refreshing the manifest before
standard verification passes. Normal E2E runs never rewrite it.

Report the printed run directory, pass/fail result, total duration, and any
material job-duration change. Inspect every changed screenshot, including an
in-flight streaming state when the feature affects streaming. Use
`npm run test:e2e:serial` only to diagnose ordering or accidentally shared
state; a serial pass is not a substitute for the required parallel run.

## Authoring checklist

- The spec passes by itself against a fresh server.
- No state, port, path, timing, or ordering contract crosses a spec boundary.
- Serial tests form a necessary same-server state chain.
- The fixture is the smallest realistic fixture for the behavior.
- Readiness is tied to observable behavior rather than delay.
- New independent coverage uses a separate job when that preserves truthful
  fixture and state boundaries instead of extending a critical-path job.
- The changed job and complete suite remain near the measured target, or the
  handoff gives the concrete reason and timing evidence for the regression.
