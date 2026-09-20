import { describe, expect, it, vi } from "vitest";
import { SshEnvironmentAvailabilityAggregator } from "../../src/server/execution/ssh-environment-availability.js";

describe("SshEnvironmentAvailabilityAggregator", () => {
  it("keeps an environment available while any current source is available", async () => {
    const reports = vi.fn();
    const availability = new SshEnvironmentAvailabilityAggregator({
      configurationRevision: 4,
      activeConfigurationRevision: () => 4,
      reportAvailability: reports,
    });

    await availability.reportSidecarObservation({ availability: "available" });
    await availability.reportBackendObservation("codex-a", {
      availability: "unavailable",
      diagnosticCode: "codex_a_failed",
    });
    await availability.reportSidecarObservation({
      availability: "unavailable",
      diagnosticCode: "sidecar_session_failed",
    });
    await availability.reportBackendObservation("codex-b", {
      availability: "available",
    });

    expect(reports.mock.calls).toEqual([
      [true, undefined],
      [true, undefined],
      [false, "sidecar_session_failed"],
      [true, undefined],
    ]);
  });

  it("serializes interleaved publications in observation order", async () => {
    let releaseFirst!: () => void;
    const firstReport = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const reports = vi
      .fn<
        (available: boolean, diagnosticCode?: string) => void | Promise<void>
      >()
      .mockImplementationOnce(async () => await firstReport)
      .mockImplementation(() => undefined);
    const availability = new SshEnvironmentAvailabilityAggregator({
      configurationRevision: 4,
      activeConfigurationRevision: () => 4,
      reportAvailability: reports,
    });

    const ready = availability.reportSidecarObservation({
      availability: "available",
    });
    const failed = availability.reportSidecarObservation({
      availability: "unavailable",
      diagnosticCode: "sidecar_session_failed",
    });
    await vi.waitFor(() => expect(reports).toHaveBeenCalledTimes(1));
    releaseFirst();
    await Promise.all([ready, failed]);

    expect(reports.mock.calls).toEqual([
      [true, undefined],
      [false, "sidecar_session_failed"],
    ]);
  });

  it("drops observations after the environment configuration revision changes", async () => {
    let revision = 4;
    const reports = vi.fn();
    const availability = new SshEnvironmentAvailabilityAggregator({
      configurationRevision: 4,
      activeConfigurationRevision: () => revision,
      reportAvailability: reports,
    });
    revision = 5;

    await availability.reportSidecarObservation({ availability: "available" });
    await availability.reportBackendObservation("codex-a", {
      availability: "unavailable",
      diagnosticCode: "codex_a_failed",
    });

    expect(reports).not.toHaveBeenCalled();
  });
});
