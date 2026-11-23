import { describe, expect, it } from "vitest";
import {
  currentBackendGrant,
  launchAdmission,
  observedLaunchDigest,
} from "../../src/server/backends/provider-policy-admission.js";

describe("retained provider launch authority", () => {
  it("preserves the resident launch digest and refuses a stale or withdrawn owner", () => {
    const resident = {};
    const original = "a".repeat(64), desired = "b".repeat(64);
    const subject = {id: "one", kind: "pi_native", generation: 1, targets: [{id: "pi", generation: 1}]};
    let backends = [{ ...subject, launchDigest: original }];
    const policy = { getExecutionPolicy: () => ({backends, capabilities: []}) };
    expect(() => launchAdmission(policy, subject.kind, "two", original)).toThrow();
    expect(() => launchAdmission(policy, subject.kind, subject.id, desired)).toThrow();
    const launch = launchAdmission(policy, subject.kind, subject.id, original);
    launch.bind(resident);
    backends = [{ ...subject, launchDigest: desired }];
    expect(currentBackendGrant(policy, resident).launchDigest).toBe(desired);
    expect(observedLaunchDigest(resident)).toBe(original);
    expect(() => launch.assertCurrent()).toThrow();
    expect(() => launchAdmission(policy, subject.kind, subject.id, desired).bind(resident)).toThrow();
    backends = [];
    expect(() => currentBackendGrant(policy, resident)).toThrow();
    backends = [{ ...subject, generation: 2, launchDigest: desired }];
    expect(() => currentBackendGrant(policy, resident)).toThrow();
    const replacement = {};
    launchAdmission(policy, subject.kind, subject.id, desired).bind(replacement);
    expect(observedLaunchDigest(replacement)).toBe(desired);
  });
});
