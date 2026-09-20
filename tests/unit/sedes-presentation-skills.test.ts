import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const skillPackages = [
  {
    name: "sedes-cli-progressive-tools",
    displayName: "Sedes CLI Progressive Tools",
  },
  {
    name: "sedes-cli-individual-tools",
    displayName: "Sedes CLI Individual Tools",
  },
  {
    name: "sedes-native-progressive-tools",
    displayName: "Sedes Native Progressive Tools",
  },
  {
    name: "sedes-native-individual-tools",
    displayName: "Sedes Native Individual Tools",
  },
] as const;

async function readSkill(name: string): Promise<string> {
  return readFile(path.resolve("skills", name, "SKILL.md"), "utf8");
}

async function readOpenAiMetadata(name: string): Promise<string> {
  return readFile(
    path.resolve("skills", name, "agents", "openai.yaml"),
    "utf8",
  );
}

function frontmatterName(markdown: string): string | undefined {
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
  return frontmatter?.match(/^name:\s*([^\n]+)$/m)?.[1]?.trim();
}

function quotedYamlScalar(yaml: string, field: string): string | undefined {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return yaml.match(
    new RegExp(`^\\s*${escapedField}:\\s*"([^"]+)"\\s*$`, "m"),
  )?.[1];
}

describe("Sedes presentation skill packages", () => {
  it.each(skillPackages)(
    "$name keeps package and OpenAI metadata aligned",
    async ({ name, displayName }) => {
      const [skill, metadata] = await Promise.all([
        readSkill(name),
        readOpenAiMetadata(name),
      ]);
      expect(frontmatterName(skill)).toBe(name);
      expect(quotedYamlScalar(metadata, "display_name")).toBe(displayName);
      expect(quotedYamlScalar(metadata, "default_prompt")).toContain(
        `$${name}`,
      );
      expect(metadata).toMatch(/^\s*allow_implicit_invocation:\s*false\s*$/m);
    },
  );

  it("keeps CLI progressive strictly on generic JSON discovery and invocation", async () => {
    const skill = await readSkill("sedes-cli-progressive-tools");
    const list = skill.indexOf("sedes tool list --json");
    const describe = skill.indexOf(
      "sedes tool describe TOOL_ID [TOOL_ID ...] --json",
    );
    const invoke = skill.indexOf(
      "sedes tool invoke TOOL_ID --input-file INPUT.json --json",
    );
    expect(list).toBeGreaterThan(-1);
    expect(describe).toBeGreaterThan(list);
    expect(invoke).toBeGreaterThan(describe);
    expect(skill).toContain("there is no invocation or `output` wrapper");
    expect(skill).toContain("do not use root help, group help");
    expect(skill).not.toContain("sedes --help");
    expect(skill).not.toContain("sedes task --help");
    expect(skill).not.toContain("sedes task create --help");
    expect(skill).not.toContain('--title "');
    expect(skill).not.toContain("sedes_catalog");
  });

  it("keeps CLI individual strictly on live help and named commands", async () => {
    const skill = await readSkill("sedes-cli-individual-tools");
    const rootHelp = skill.indexOf("sedes --help");
    const groupHelp = skill.indexOf("sedes task --help");
    const commandHelp = skill.indexOf("sedes task create --help");
    const invoke = skill.indexOf("sedes task create \\");
    expect(rootHelp).toBeGreaterThan(-1);
    expect(groupHelp).toBeGreaterThan(rootHelp);
    expect(commandHelp).toBeGreaterThan(groupHelp);
    expect(invoke).toBeGreaterThan(commandHelp);
    expect(skill).toContain("--details-file /tmp/task-details.md");
    expect(skill).toContain("expected-revision option");
    expect(skill).toMatch(/do\s+not use the generic `tool` command family/);
    expect(skill).not.toContain("sedes tool list");
    expect(skill).not.toContain("sedes tool describe");
    expect(skill).not.toContain("sedes tool invoke");
    expect(skill).not.toContain("sedes_catalog");
  });

  it("keeps native progressive strictly on catalog gateways", async () => {
    const skill = await readSkill("sedes-native-progressive-tools");
    const list = skill.indexOf('{ "action": "list" }');
    const describe = skill.indexOf(
      '{ "action": "describe", "toolIds": [...] }',
    );
    const invoke = skill.indexOf('"toolId": "<exact returned operation ID>"');
    expect(list).toBeGreaterThan(-1);
    expect(describe).toBeGreaterThan(list);
    expect(invoke).toBeGreaterThan(describe);
    expect(skill).toContain("`sedes_catalog` is visible");
    expect(skill).toContain("Use `sedes_read` only");
    expect(skill).toContain("Use `sedes_act` for every other effect");
    expect(skill).toContain("Never invoke Bash");
    expect(skill).not.toContain("sedes tool list");
    expect(skill).not.toContain("sedes --help");
  });

  it("keeps native individual strictly on visible individual tools", async () => {
    const skill = await readSkill("sedes-native-individual-tools");
    expect(skill).toContain("`sedes_catalog` is absent");
    expect(skill).toContain("Select only a visible operation");
    expect(skill).toContain("Never invoke progressive gateways, Bash");
    expect(skill).toContain("needs no separate catalog or describe call");
    expect(skill).not.toContain("sedes tool list");
    expect(skill).not.toContain("sedes --help");
    expect(skill).not.toContain('{ "action": "list" }');
  });

  it.each(skillPackages)(
    "$name preserves task CAS and uncertain-write safety",
    async ({ name }) => {
      const skill = await readSkill(name);
      const normalized = skill.replace(/\s+/g, " ");
      expect(normalized).toContain("scopeMode");
      expect(normalized).toContain("exact");
      expect(normalized).toContain("subtree");
      expect(normalized).toContain("revision");
      expect(normalized).toMatch(/revision conflict/i);
      expect(normalized).toMatch(
        /never retry (?:an uncertain write|a write whose transport outcome is uncertain)/i,
      );
      expect(normalized).toMatch(/Create once|Create a task once/);
      expect(normalized).toMatch(
        /never (?:create again|retry an uncertain write or create again)/i,
      );
      expect(normalized).toContain("Do not switch presentation families");
    },
  );
});
