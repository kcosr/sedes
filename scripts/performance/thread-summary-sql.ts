/**
 * Offline prepared-summary benchmark using a disposable in-memory SQLite database.
 * Run before and after a change on the same host:
 * env -u NODE_ENV node --import tsx scripts/performance/thread-summary-sql.ts
 * No providers, network, application runtime, or persistent state are opened.
 */
import assert from "node:assert/strict";
import { cpus } from "node:os";
import { applicationSummaryFixture } from "../../tests/support/application-summary-fixture.js";

const fixture = applicationSummaryFixture(1_000);
const reader = fixture.createReader();
const prepared: string[] = [];
let executions = 0;
const prepare = fixture.database.prepare.bind(fixture.database);
fixture.database.prepare = ((sql: string) => {
  const statement = prepare(sql);
  if (sql.includes("WITH requested_threads")) {
    prepared.push(sql);
    const all = statement.all.bind(statement);
    statement.all = (...parameters: unknown[]) => {
      executions += 1;
      return all(...parameters);
    };
  }
  return statement;
}) as typeof fixture.database.prepare;

function measure(name: string, ids: readonly string[] | undefined, repeats: number) {
  const read = () => ids === undefined
    ? reader.list(fixture.scope, fixture.environment.id)
    : reader.listByIds(fixture.scope, ids);
  const expectedRows = ids?.length ?? fixture.ids.length;
  for (let warmup = 0; warmup < 30; warmup += 1) assert.equal(read().length, expectedRows);
  const preparationStart = prepared.length;
  const executionStart = executions;
  const samples: number[] = [];
  const cpuStart = process.cpuUsage();
  for (let index = 0; index < repeats; index += 1) {
    const start = performance.now();
    const result = read();
    samples.push(performance.now() - start);
    assert.equal(result.length, expectedRows);
  }
  const cpu = process.cpuUsage(cpuStart);
  const ordered = [...samples].sort((left, right) => left - right);
  const round = (value: number) => Math.round(value * 1_000) / 1_000;
  return {
    name, repeats, rowsPerRead: expectedRows,
    preparations: prepared.length - preparationStart,
    executions: executions - executionStart,
    cpuUserMilliseconds: round(cpu.user / 1_000),
    cpuSystemMilliseconds: round(cpu.system / 1_000),
    cpuTotalMilliseconds: round((cpu.user + cpu.system) / 1_000),
    cpuMillisecondsPerRead: round((cpu.user + cpu.system) / 1_000 / repeats),
    medianMilliseconds: round(ordered[Math.floor(repeats / 2)]!),
    p95Milliseconds: round(ordered[Math.ceil(repeats * 0.95) - 1]!),
    totalMilliseconds: round(samples.reduce((sum, value) => sum + value, 0)),
  };
}

try {
  console.log(JSON.stringify({
    node: process.version,
    sqlite: fixture.database.prepare("SELECT sqlite_version() AS version").get(),
    cpu: cpus()[0]?.model,
    fixture: { threads: fixture.ids.length, database: ":memory:", retainedProviders: 0 },
    results: [
      measure("one-thread", fixture.ids.slice(0, 1), 1_000),
      measure("100-threads", fixture.ids.slice(0, 100), 300),
      measure("full-environment", undefined, 100),
    ],
    totalPreparationsIncludingWarmup: prepared.length,
    totalExecutionsIncludingWarmup: executions,
  }, null, 2));
} finally {
  fixture.database.close();
}
