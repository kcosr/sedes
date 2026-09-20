import { describe, expect, it } from "vitest";
import type {
  AgentConnectionProfile,
  BackendCatalog,
} from "../../src/server/backends/contracts.js";
import { resolveDesiredSettings } from "../../src/server/backends/claude/claude-backend-thread-persistence-adapter.js";

const connection: AgentConnectionProfile = {
  id: "claude-local",
  tenantId: "tenant-a",
  ownerPrincipalId: "principal-a",
  templateId: "claude-local",
  kind: "claude_agent_sdk",
  backendInstanceId: "claude-backend",
  executionEnvironmentId: "local",
  label: "Claude Local",
  enabled: true,
  configurationRevision: 1,
};

function catalog(models: BackendCatalog["models"]): BackendCatalog {
  return { models, commands: [], skills: [], notices: [] };
}

describe("Claude desired thread settings", () => {
  it("leaves a new draft unresolved when policy filtering removes the default model", () => {
    expect(
      resolveDesiredSettings(
        connection,
        catalog([
          {
            provider: connection.id,
            id: "claude-opus-5",
            label: "Claude Opus 5",
            inputModalities: ["text"],
            supportedReasoningEfforts: ["high"],
            defaultReasoningEffort: "high",
          },
        ]),
        { permissionMode: "default" },
      ),
    ).toEqual({ model: null, effort: null, permissionMode: "default" });
  });

  it("leaves a new draft unresolved when the default effort is not admitted", () => {
    expect(
      resolveDesiredSettings(
        connection,
        catalog([
          {
            provider: connection.id,
            id: "claude-sonnet-5",
            label: "Claude Sonnet 5",
            inputModalities: ["text"],
            isDefault: true,
            supportedReasoningEfforts: ["low"],
          },
        ]),
        { permissionMode: "default" },
      ),
    ).toEqual({ model: null, effort: null, permissionMode: "default" });
  });

  it("resolves only an admitted authoritative default tuple", () => {
    expect(
      resolveDesiredSettings(
        connection,
        catalog([
          {
            provider: connection.id,
            id: "claude-sonnet-5",
            label: "Claude Sonnet 5",
            inputModalities: ["text"],
            isDefault: true,
            supportedReasoningEfforts: ["low", "high"],
            defaultReasoningEffort: "high",
          },
        ]),
        { permissionMode: "default" },
      ),
    ).toEqual({
      model: "claude-sonnet-5",
      effort: "high",
      permissionMode: "default",
    });
  });

  it("resolves an authoritative default model with no effort axis", () => {
    expect(
      resolveDesiredSettings(
        connection,
        catalog([
          {
            provider: connection.id,
            id: "claude-haiku-4-5",
            label: "Haiku",
            inputModalities: ["text"],
            isDefault: true,
          },
        ]),
        { permissionMode: "default" },
      ),
    ).toEqual({
      model: "claude-haiku-4-5",
      effort: null,
      permissionMode: "default",
    });
  });
});
