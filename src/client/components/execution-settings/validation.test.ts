import { describe, expect, it } from "vitest";
import { configurationDocumentSchema } from "../../../shared/protocol/configuration-admin.js";
import { acceptHostRegistrationRequestSchema } from "../../../shared/protocol/host-pairing.js";
import { environmentVariableOverridesSchema } from "../../../shared/protocol/environment-variables.js";
import { backendEditors } from "./backend-editors.js";
import type { Configuration } from "./types.js";
import { describeDocumentPath, describePath, FieldErrors, mapConfigurationIssues, mapRequestIssues, validationIssues } from "./validation.js";

const localId = "10000000-0000-4000-8000-000000000001";
const sshId = "10000000-0000-4000-8000-000000000002";

function document(): Configuration {
  return {
    executionEnvironments: [
      { id: localId, kind: "local", label: "Local", workspaceRoots: ["/work"], workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } },
      { id: sshId, kind: "ssh", label: "Build server", hostAlias: "build", workspaceRoots: ["/srv"], operations: { kind: "none" } },
    ],
    backends: [], targets: [], defaultTargetId: null, webSearch: null,
  };
}

function issuesOf(value: Configuration) {
  const parsed = configurationDocumentSchema.safeParse(value);
  if (parsed.success) throw new Error("expected a validation failure");
  return validationIssues(parsed.error);
}

const environmentFields = /^(label|hostAlias|workspaceRoots(\.\d+)?)$/u;

describe("validation path mapping", () => {
  it("maps an environment's schema paths to its own fields by position in the submitted document", () => {
    const value = document();
    value.executionEnvironments[1] = { ...value.executionEnvironments[1]!, kind: "ssh", hostAlias: "build", workspaceRoots: ["relative/path"], label: "" } as Configuration["executionEnvironments"][number];
    const errors = mapConfigurationIssues(issuesOf(value), value, { kind: "environment", id: sshId }, environmentFields);
    expect(errors.fields.get("workspaceRoots.0")).toBe("An absolute execution-environment path is required.");
    expect(errors.fields.get("label")).toBe("Enter a name.");
    expect(errors.fields.under("workspaceRoots")).toBe("An absolute execution-environment path is required.");
    expect(errors.general).toEqual([]);
  });

  it("never attributes another item's issue to the edited one and describes it in words", () => {
    const value = document();
    value.executionEnvironments[1] = { ...value.executionEnvironments[1]!, workspaceRoots: [] } as Configuration["executionEnvironments"][number];
    const errors = mapConfigurationIssues(issuesOf(value), value, { kind: "environment", id: localId }, environmentFields);
    expect(errors.fields.size).toBe(0);
    expect(errors.general).toEqual([{ location: "Environment “Build server” › Workspace roots", message: "Add at least one workspace root." }]);
    expect(JSON.stringify(errors)).not.toMatch(/executionEnvironments|·/u);
  });

  it("keeps issues outside the editor's fields general, relative to the edited item", () => {
    const value = document();
    value.executionEnvironments[1] = { ...value.executionEnvironments[1]!, hostAlias: "bad alias!" } as Configuration["executionEnvironments"][number];
    const onlyLabel = mapConfigurationIssues(issuesOf(value), value, { kind: "environment", id: sshId }, /^label$/u);
    expect(onlyLabel.general).toEqual([{ location: "SSH host alias", message: expect.stringContaining("Use an SSH alias") }]);
  });

  it("keys a backend's connection issues by connection id", () => {
    const value = document();
    const backend = backendEditors.codex_app_server.createBackend("codex-1");
    backend.label = "Codex";
    const target = backendEditors.codex_app_server.createTarget("target-1", backend.id, localId);
    if (backend.kind !== "codex_app_server") throw new Error("unexpected kind");
    backend.moduleConfiguration.connection = { ownership: "owned", channel: { type: "process_stdio", workingDirectory: "" } };
    value.backends.push(backend);
    value.targets.push({ ...target, label: "" });
    const errors = mapConfigurationIssues(issuesOf(value), value, { kind: "backend", id: backend.id },
      /^(label|moduleConfiguration\..+|targets\.[^.]+\.label)$/u);
    expect(errors.fields.get("moduleConfiguration.connection.channel.workingDirectory")).toBe("Enter a value.");
    expect(errors.fields.get("targets.target-1.label")).toBe("Enter a name.");
    expect(errors.fields.scope("targets.target-1").get("label")).toBe("Enter a name.");
  });

  it("maps request fields directly and replaces Zod's generic wording", () => {
    const parsed = acceptHostRegistrationRequestSchema.safeParse({
      mutationId: "20000000-0000-4000-8000-000000000001", registrationId: "20000000-0000-4000-8000-000000000002",
      expectedRegistrationRevision: 1, expectedConfigurationRevision: 1, label: "Studio", workspaceRoots: [],
      operations: { kind: "sidecar", enabledCapabilities: ["directory_browser"] },
    });
    if (parsed.success) throw new Error("expected a validation failure");
    const errors = mapRequestIssues(validationIssues(parsed.error), /^(label|workspaceRoots(\.\d+)?)$/u);
    expect(errors.fields.get("workspaceRoots")).toBe("Add at least one workspace root.");
    expect(JSON.stringify(errors)).not.toContain("Invalid input");
    expect(JSON.stringify(errors)).not.toContain("Too small");
  });

  it.each(["codex_app_server", "opencode"] as const)("explains %s credential variable requirements on the matching field", kind => {
    const value = document();
    const backend = backendEditors[kind].createBackend("provider");
    backend.label = "Provider";
    if (backend.kind === "codex_app_server") {
      backend.moduleConfiguration.connection = { ownership: "external", channel: { type: "tcp_websocket", url: "wss://provider.internal:9000",
        authentication: { type: "capability_token", secret: { source: "environment", variable: "BAD_NAME" } } } };
    } else if (backend.kind === "opencode") {
      backend.moduleConfiguration.nativeStorePath = "/data/opencode.db";
      backend.moduleConfiguration.connection = { ownership: "external", channel: { type: "http", url: "http://127.0.0.1:4096",
        authentication: { type: "basic", username: "opencode", secret: { source: "environment", variable: "BAD_NAME" } } } };
    }
    value.backends.push(backend);
    value.targets.push(backendEditors[kind].createTarget("target", backend.id, localId));
    const errors = mapConfigurationIssues(issuesOf(value), value, { kind: "backend", id: backend.id }, /^moduleConfiguration\..+$/u);
    expect(errors.fields.get("moduleConfiguration.connection.channel.authentication.secret.variable")).toBe(kind === "opencode"
      ? "Use an approved name that starts with SEDES_OPENCODE_ and contains PASSWORD, such as SEDES_OPENCODE_REMOTE_PASSWORD."
      : "Use an approved name that starts with SEDES_CODEX_ and contains TOKEN, such as SEDES_CODEX_REMOTE_TOKEN.");
    expect(errors.general).toEqual([]);
  });

  it("explains a managed variable name instead of an invalid record key", () => {
    const parsed = environmentVariableOverridesSchema.safeParse({ HOME: { kind: "literal", value: "/tmp" } });
    if (parsed.success) throw new Error("expected a validation failure");
    expect(validationIssues(parsed.error)).toEqual([{ path: ["HOME"], message: "This variable is managed by Sedes or provider identity settings." }]);
  });

  it("humanizes paths without leaking structure", () => {
    expect(describePath(["moduleConfiguration", "connection", "channel", "workingDirectory"])).toBe("Connection › Working directory");
    expect(describePath(["modelPolicy", "allowed", 1, "modelIds", 0])).toBe("Models › Rules › rule 2 › Model identifiers › entry 1");
    expect(describePath(["environmentVariables", "execution", "HOME"])).toBe("Environment variables › Tools and commands › HOME");
    expect(describePath(["someNewSetting"])).toBe("Some new setting");
    expect(describePath([])).toBeUndefined();
    expect(describeDocumentPath(["executionEnvironments", 5, "workspaceRoots", 0], document())).toBe("Environment (new) › Workspace roots › entry 1");
    expect(describeDocumentPath(["defaultTargetId"], document())).toBe("Default connection");
  });

  it("finds errors under a subtree and treats an empty map as no errors", () => {
    const errors = new FieldErrors(new Map([["modelPolicy.allowed.0", "A matcher must select at least one dimension."]]));
    expect(errors.under("modelPolicy")).toBe("A matcher must select at least one dimension.");
    expect(errors.under("modelPolicy.allowed.1")).toBeUndefined();
    expect(errors.scope("modelPolicy.allowed").get("0")).toBe("A matcher must select at least one dimension.");
    expect(FieldErrors.none.scope("anything")).toBe(FieldErrors.none);
  });
});
