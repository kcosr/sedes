import { describe, expect, it } from "vitest";
import {
  ABSENT_MODULE_CONFIGURATION_FINGERPRINT,
  configurationFingerprint,
} from "../../src/server/config/configuration-fingerprint.js";

describe("configuration fingerprint", () => {
  it("uses the checksum-locked absent-configuration value", () => {
    expect(ABSENT_MODULE_CONFIGURATION_FINGERPRINT).toBe(
      "f471c5e060149174c084464b55b3b5d9165e7569b2b0df609df732ced3cd06c7",
    );
    expect(configurationFingerprint(null)).toBe(
      ABSENT_MODULE_CONFIGURATION_FINGERPRINT,
    );
  });

  it("canonicalizes object keys recursively while preserving array order", () => {
    const first = configurationFingerprint({
      transport: {
        executable: "/opt/codex",
        options: { beta: true, alpha: null },
      },
      modes: ["read-only", "workspace-write"],
    });
    const reordered = configurationFingerprint({
      modes: ["read-only", "workspace-write"],
      transport: {
        options: { alpha: null, beta: true },
        executable: "/opt/codex",
      },
    });

    expect(reordered).toBe(first);
    expect(
      configurationFingerprint({
        modes: ["workspace-write", "read-only"],
        transport: {
          options: { alpha: null, beta: true },
          executable: "/opt/codex",
        },
      }),
    ).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed for values outside validated JSON", () => {
    expect(() =>
      configurationFingerprint({
        invalid: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/non-finite/i);
    expect(() =>
      configurationFingerprint({
        invalid: undefined,
      }),
    ).toThrow(/non-JSON value/i);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => configurationFingerprint(cyclic)).toThrow(/cycle/i);
  });

  it("fingerprints a TCP secret reference without depending on its resolved value", () => {
    const configuration = {
      connection: {
        ownership: "external",
        channel: {
          type: "tcp_websocket",
          url: "ws://127.0.0.1:4500",
          authentication: {
            type: "capability_token",
            secret: {
              source: "environment",
              variable: "SEDES_CODEX_FINGERPRINT_TOKEN",
            },
          },
        },
      },
    };
    const firstResolvedValue = "first-resolved-capability-token";
    const secondResolvedValue = "second-resolved-capability-token";
    const fingerprintAfterRuntimeResolution = (_resolvedValue: string) =>
      configurationFingerprint(configuration);

    const first = fingerprintAfterRuntimeResolution(firstResolvedValue);
    expect(fingerprintAfterRuntimeResolution(secondResolvedValue)).toBe(first);
    expect(first).not.toContain(firstResolvedValue);
    expect(first).not.toContain(secondResolvedValue);
    expect(
      configurationFingerprint({
        ...configuration,
        connection: {
          ...configuration.connection,
          channel: {
            ...configuration.connection.channel,
            authentication: {
              ...configuration.connection.channel.authentication,
              secret: {
                source: "environment",
                variable: "SEDES_CODEX_ROTATED_REFERENCE_TOKEN",
              },
            },
          },
        },
      }),
    ).not.toBe(first);
  });
});
