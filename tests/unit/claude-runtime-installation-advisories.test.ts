import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeRuntimeInstallationAdvisories } from "../../src/server/backends/claude/claude-runtime-installation-advisories.js";

describe("Claude runtime installation advisories", () => {
  beforeEach(() => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replaces and clears the one current runtime assessment", () => {
    const source = new ClaudeRuntimeInstallationAdvisories();
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);
    const observation = source.beginObservation("health_probe");
    const warning = {
      version: "2.1.275",
      newerThanTested: true,
    };

    observation.observeVersionAssessment(warning);
    observation.observeVersionAssessment(warning);

    expect(listener).toHaveBeenCalledOnce();
    expect(source.active()).toEqual([
      {
        id: "runtime-newer-than-tested",
        tone: "warning",
        title: { text: "Claude Code is newer than tested" },
        message: {
          text: "Running 2.1.275; Sedes is tested through 2.1.274.",
        },
      },
    ]);

    observation.observeVersionAssessment({
      version: "2.2.0",
      newerThanTested: true,
    });
    expect(source.active()[0]?.message.text).toContain("Running 2.2.0");
    observation.observeVersionAssessment({
      version: "2.1.274",
      newerThanTested: false,
    });
    expect(source.active()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("ignores an older failure after newer successful evidence", () => {
    const source = new ClaudeRuntimeInstallationAdvisories();
    const older = source.beginObservation("health_probe");
    const newer = source.beginObservation("conversation_session");

    newer.observeVersionAssessment({
      version: "2.1.276",
      newerThanTested: true,
    });
    older.failed();

    expect(source.active()[0]?.message.text).toContain("Running 2.1.276");
  });

  it("clears prior evidence when the current direct session admission fails", () => {
    const source = new ClaudeRuntimeInstallationAdvisories();
    const observation = source.beginObservation("conversation_session");
    observation.observeVersionAssessment({
      version: "2.1.275",
      newerThanTested: true,
    });

    observation.failed();

    expect(source.active()).toEqual([]);
  });

  it("ignores an older completion after a newer failed observation", () => {
    const source = new ClaudeRuntimeInstallationAdvisories();
    const older = source.beginObservation("conversation_session");
    const newer = source.beginObservation("health_probe");

    newer.failed();
    older.observeVersionAssessment({
      version: "2.1.275",
      newerThanTested: true,
    });

    expect(source.active()).toEqual([]);
  });

  it("lets the newest successful observation replace older evidence", () => {
    const source = new ClaudeRuntimeInstallationAdvisories();
    const older = source.beginObservation("health_probe");
    older.observeVersionAssessment({
      version: "2.1.275",
      newerThanTested: true,
    });
    const newer = source.beginObservation("conversation_session");
    newer.observeVersionAssessment({
      version: "2.2.0",
      newerThanTested: true,
    });

    older.observeVersionAssessment({
      version: "2.1.277",
      newerThanTested: true,
    });
    expect(source.active()[0]?.message.text).toContain("Running 2.2.0");
  });
});
