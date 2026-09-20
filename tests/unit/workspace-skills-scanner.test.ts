import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SidecarOperationError } from "../../src/internal/sidecar-protocol/index.js";
import { WORKSPACE_SKILLS_MAXIMUM_FILE_BYTES } from "../../src/internal/sidecar-protocol/index.js";
import { WorkspaceSkillsSidecarHost } from "../../src/server/sidecar/workspace-skills-sidecar-host.js";
import {
  scanWorkspaceSkills,
  WorkspaceSkillsScannerError,
} from "../../src/server/sidecar/workspace-skills-scanner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-skills-"));
  temporaryDirectories.push(root);
  const homeDirectory = path.join(root, "home");
  const policyRootPath = path.join(root, "projects");
  const workspacePath = path.join(policyRootPath, "workspace");
  await Promise.all([
    mkdir(homeDirectory, { recursive: true }),
    mkdir(workspacePath, { recursive: true }),
  ]);
  return { root, homeDirectory, policyRootPath, workspacePath };
}

async function writeSkill(
  root: string,
  directory: string,
  name: string,
  description: string,
  body = "Instructions",
) {
  const skillDirectory = path.join(root, directory);
  await mkdir(skillDirectory, { recursive: true });
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
  await writeFile(path.join(skillDirectory, "SKILL.md"), content);
  return content;
}

describe("workspace skills scanner", () => {
  it("discovers fixed account-global and workspace roots with deterministic collisions", async () => {
    const fixtureRoot = await fixture();
    const accountContent = await writeSkill(
      path.join(fixtureRoot.homeDirectory, ".pi", "agent", "skills"),
      "review",
      "review",
      "Account review",
    );
    await writeSkill(
      path.join(fixtureRoot.homeDirectory, ".agents", "skills"),
      "duplicate",
      "review",
      "Losing review",
    );
    await writeSkill(
      path.join(fixtureRoot.workspacePath, ".pi", "skills"),
      "testing",
      "testing",
      "Run tests",
    );
    await writeSkill(
      path.join(fixtureRoot.workspacePath, ".agents", "skills"),
      "shipping",
      "shipping",
      "Ship safely",
    );

    const result = await scanWorkspaceSkills(fixtureRoot);

    expect(result.skills.map(({ name, source }) => ({ name, source }))).toEqual(
      [
        { name: "review", source: "account_pi" },
        { name: "testing", source: "workspace_pi" },
        { name: "shipping", source: "workspace_agents" },
      ],
    );
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "name_collision",
        name: "review",
        source: "account_agents",
        winnerId: result.skills[0]?.id,
      }),
    ]);
    expect(result.catalogFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.skills[0]).toMatchObject({
      contentSha256: createHash("sha256").update(accountContent).digest("hex"),
      baseDir: path.join(
        fixtureRoot.homeDirectory,
        ".pi",
        "agent",
        "skills",
        "review",
      ),
    });
  });

  it("resolves the exact bounded body and rejects catalog drift", async () => {
    const fixtureRoot = await fixture();
    const skillsRoot = path.join(
      fixtureRoot.homeDirectory,
      ".pi",
      "agent",
      "skills",
    );
    const content = await writeSkill(
      skillsRoot,
      "review",
      "review",
      "Exact body",
    );
    const host = new WorkspaceSkillsSidecarHost({
      homeDirectory: fixtureRoot.homeDirectory,
    });
    const request = {
      admissionId: randomUUID(),
      declaredPath: fixtureRoot.workspacePath,
      policyRootPath: fixtureRoot.policyRootPath,
    };
    const context = { signal: new AbortController().signal } as never;
    const catalog = await host.handlers.readCatalog(request, context);
    const selected = catalog.skills[0];
    expect(selected).toBeDefined();
    await expect(
      host.handlers.resolveSkill(
        {
          ...request,
          catalogFingerprint: catalog.catalogFingerprint,
          id: selected!.id,
        },
        context,
      ),
    ).resolves.toEqual({ skill: selected, content });

    await writeSkill(skillsRoot, "review", "review", "Changed body");
    await expect(
      host.handlers.resolveSkill(
        {
          ...request,
          catalogFingerprint: catalog.catalogFingerprint,
          id: selected!.id,
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "workspace_skills_catalog_changed",
    });
  });

  it("rejects workspace aliases and does not follow skill symlinks", async () => {
    const fixtureRoot = await fixture();
    const outside = path.join(fixtureRoot.root, "outside");
    await mkdir(outside);
    await writeSkill(outside, "secret", "secret", "Do not expose");
    const skillsRoot = path.join(fixtureRoot.workspacePath, ".pi", "skills");
    await mkdir(skillsRoot, { recursive: true });
    await symlink(
      path.join(outside, "secret"),
      path.join(skillsRoot, "linked"),
    );

    const result = await scanWorkspaceSkills(fixtureRoot);
    expect(result.skills).toEqual([]);

    const alias = path.join(fixtureRoot.policyRootPath, "alias");
    await symlink(fixtureRoot.workspacePath, alias);
    await expect(
      scanWorkspaceSkills({ ...fixtureRoot, workspacePath: alias }),
    ).rejects.toBeInstanceOf(WorkspaceSkillsScannerError);
  });

  it("omits invalid UTF-8 and invalid Agent Skills metadata with bounded diagnostics", async () => {
    const fixtureRoot = await fixture();
    const skillsRoot = path.join(
      fixtureRoot.workspacePath,
      ".agents",
      "skills",
    );
    const binaryDirectory = path.join(skillsRoot, "binary");
    await mkdir(binaryDirectory, { recursive: true });
    await writeFile(
      path.join(binaryDirectory, "SKILL.md"),
      Buffer.from([0xff, 0xfe]),
    );
    await writeSkill(skillsRoot, "invalid-name", "Not Valid", "description");
    await writeSkill(skillsRoot, "missing-description", "valid-name", "");

    const result = await scanWorkspaceSkills(fixtureRoot);
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toHaveLength(3);
    expect(
      result.diagnostics.every(({ code }) => code === "invalid_skill"),
    ).toBe(true);
  });

  it("fails closed when a discovered body exceeds the advertised bound", async () => {
    const fixtureRoot = await fixture();
    const skillDirectory = path.join(
      fixtureRoot.homeDirectory,
      ".pi",
      "agent",
      "skills",
      "oversized",
    );
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      path.join(skillDirectory, "SKILL.md"),
      Buffer.alloc(WORKSPACE_SKILLS_MAXIMUM_FILE_BYTES + 1, 0x61),
    );

    await expect(scanWorkspaceSkills(fixtureRoot)).rejects.toMatchObject({
      code: "workspace_skills_limit_exceeded",
    });
  });
});
