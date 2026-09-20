import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES,
} from "../../src/shared/protocol/workspace-files.js";
import { loadE2ERunContext } from "./run-context.js";

const execFileAsync = promisify(execFile);
const runContext = loadE2ERunContext();

export const workspaceFilesFixtureRoot = runContext.workspacesDirectory;
export const alphaWorkspace = path.join(workspaceFilesFixtureRoot, "alpha");
export const betaWorkspace = path.join(workspaceFilesFixtureRoot, "beta");
export const imageWorkspace = path.join(
  workspaceFilesFixtureRoot,
  "image-preview",
);
export const alphaSupplementalWorkspace = path.join(
  workspaceFilesFixtureRoot,
  "alpha-context",
);
export const alphaUnavailableWorkspace = path.join(
  workspaceFilesFixtureRoot,
  "alpha-unavailable",
);
export const linkOnlyWorktreeFilePath = path.join(
  workspaceFilesFixtureRoot,
  "link-only-worktree.md",
);
export const linkOnlyWorktreeDisplayPath = path
  .relative(runContext.repositoryDirectory, linkOnlyWorktreeFilePath)
  .split(path.sep)
  .join("/");

export const alphaExamplePath = path.join(alphaWorkspace, "src", "example.ts");
export const alphaLivePath = path.join(
  alphaWorkspace,
  "src",
  "live-created.ts",
);
export const alphaSupplementalExamplePath = path.join(
  alphaSupplementalWorkspace,
  "src",
  "example.ts",
);
export const alphaSupplementalLinkedPath = path.join(
  alphaSupplementalWorkspace,
  "linked-note.md",
);

const ALPHA_EXAMPLE = [
  'export const workspace = "alpha";',
  "export const answer = 41;",
  "",
].join("\n");

const IMAGE_FIXTURES = [
  {
    path: "preview.png",
    base64:
      "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAkCAIAAAC2bqvFAAAACXBIWXMAAAABAAAAAQBPJcTWAAABGElEQVR4nO2ZMQ7CMAxFbakS3WDsysYx4WZcg42REbYymbRG0FCbGhB1G+XJQiJKYv/8JkBAUCCpEYkI5f5KM2gD1P54T2SpJ1Ao7VLK3qT/gxCN6awCxqyeMWr4wIFpYhIw/vIzFhOGBXhVzwxqSP0R8l1+5r0JSTswheVnggmgFJO0A7NAFTCd54dpd7JQUroOzIUswJsswJsswJsswJsswBtVgP1mZhzEb3KQggONrkoOOmB4rZdwgmdsKXob4gordQqowk+p1wFxlJdowK43xQLOTT/ci+Pn74B3Ab+SBXhTNNfxvB9iHodWCbDuHGHf/D/Am1HpXwMc2xDnb4/ycEisCDayACVvXITTZ0K+Xu8wvgnGdDe223I93IVcvAAAAABJRU5ErkJggg==",
  },
  {
    path: "preview.jpg",
    base64:
      "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABhAAEBAQAAAAAAAAAAAAAAAAAABAUBAQEAAAAAAAAAAAAAAAAAAAIHEAAABwEBAQAAAAAAAAAAAAASAhEAEwEFA1IEEQABAwUBAQEAAAAAAAAAAAACAwEFBBESEyEAIhT/wAARCAAGAAgDASIAAhEAAxEA/9oADAMBAAIRAxEAPwDE0tb6dSKYvIsQwx0alGFVEc3mkcrM6LDw8dAxyEdHIfnpUNmpLYqrjsUJQvtYzUe5mT9J7Xs3PCtraqRqVKqqU2rKY5niIXxFhb5ARFrCzNxvf//Z",
  },
  {
    path: "preview.gif",
    base64: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  },
  {
    path: "preview.webp",
    base64:
      "UklGRlIAAABXRUJQVlA4IEYAAACwAQCdASoIAAYAAgA0JbACdAD0bBwAAMtLQG1V+RQyf/Ex/5c7A/x9P/hdz2Gw//6Dv//Ir773nJZ+C/xKP2xCBWIrIAAA",
  },
] as const;

async function git(workspace: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", workspace, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

async function initializeRepository(workspace: string): Promise<void> {
  await git(workspace, "init", "--quiet");
  await git(workspace, "config", "user.name", "Sedes E2E");
  await git(workspace, "config", "user.email", "sedes-e2e@example.invalid");
  await git(workspace, "add", ".");
  await git(
    workspace,
    "commit",
    "--quiet",
    "-m",
    "Seed workspace file fixture",
  );
}

export async function resetWorkspaceFileFixtures(): Promise<void> {
  await rm(workspaceFilesFixtureRoot, { force: true, recursive: true });
  await Promise.all([
    mkdir(path.join(alphaWorkspace, "src"), { recursive: true }),
    mkdir(path.join(alphaWorkspace, "docs"), { recursive: true }),
    mkdir(path.join(betaWorkspace, "app"), { recursive: true }),
    mkdir(imageWorkspace, { recursive: true }),
    mkdir(path.join(alphaSupplementalWorkspace, "src"), { recursive: true }),
    mkdir(alphaUnavailableWorkspace, { recursive: true }),
  ]);

  await Promise.all([
    writeFile(path.join(alphaWorkspace, ".gitignore"), "ignored.txt\n", "utf8"),
    writeFile(
      path.join(alphaWorkspace, "streaming-notes.md"),
      "# Streaming notes\n\nFixture content.\n",
      "utf8",
    ),
    // Uppercase name on purpose: byte order puts it before docs/, Pierre's
    // canonical case-insensitive order does not — regression coverage for the
    // presorted-input tree corruption that hid most of a real repository.
    writeFile(
      path.join(alphaWorkspace, "SPEC.md"),
      [
        "# Alpha spec",
        "",
        "Body copy for preview mode.",
        "",
        "```mermaid",
        "flowchart TD",
        "  Prompt --> Accept",
        "  Accept --> Plan",
        "  Plan --> Execute",
        "  Execute --> Validate",
        "  Validate --> Render",
        "  Render --> Expand",
        "  Expand --> Zoom",
        "  Zoom --> Finish",
        "```",
        "",
        // The wide unbreakable line guards the flex layout: markdown
        // intrinsic width must never crush the tree rail.
        "```json",
        `{"pipeline": "${"wide-".repeat(90)}end"}`,
        "```",
        "",
      ].join("\n"),
      "utf8",
    ),
    writeFile(alphaExamplePath, ALPHA_EXAMPLE, "utf8"),
    writeFile(
      path.join(alphaWorkspace, "src", "status.ts"),
      'export const status = "committed";\n',
      "utf8",
    ),
    writeFile(
      path.join(alphaWorkspace, "docs", "guide.md"),
      "# Alpha guide\n\n[Guide details](details.md)\n",
      "utf8",
    ),
    writeFile(
      path.join(alphaWorkspace, "docs", "details.md"),
      "# Guide details\n",
      "utf8",
    ),
    writeFile(
      path.join(alphaWorkspace, "ignored.txt"),
      "never listed\n",
      "utf8",
    ),
    writeFile(
      path.join(betaWorkspace, "README.md"),
      "# Beta workspace\n",
      "utf8",
    ),
    writeFile(
      path.join(betaWorkspace, "app", "beta.ts"),
      'export const workspace = "beta";\n',
      "utf8",
    ),
    writeFile(
      alphaSupplementalExamplePath,
      'export const workspace = "alpha supplemental";\n',
      "utf8",
    ),
    writeFile(
      alphaSupplementalLinkedPath,
      "# Linked supplemental note\n\nOpened from rendered Markdown.\n",
      "utf8",
    ),
    writeFile(
      path.join(alphaUnavailableWorkspace, "still-here.md"),
      "# Temporarily available\n",
      "utf8",
    ),
    writeFile(
      linkOnlyWorktreeFilePath,
      "# Link-only worktree file\n",
      "utf8",
    ),
    ...IMAGE_FIXTURES.map((fixture) =>
      writeFile(
        path.join(imageWorkspace, fixture.path),
        Buffer.from(fixture.base64, "base64"),
      ),
    ),
    writeFile(
      path.join(imageWorkspace, "unknown.bin"),
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
    ),
    writeFile(
      path.join(imageWorkspace, "oversized.png"),
      oversizedPngFixture(),
    ),
  ]);

  await Promise.all([
    initializeRepository(alphaWorkspace),
    initializeRepository(betaWorkspace),
    // These fixture roots live beneath the Sedes checkout, whose outer
    // repository ignores test-results. Give each its own Git boundary so the
    // provider's git-aware listing sees the attached fixture files.
    initializeRepository(alphaSupplementalWorkspace),
    initializeRepository(alphaUnavailableWorkspace),
    initializeRepository(imageWorkspace),
  ]);

  await Promise.all([
    writeFile(
      path.join(alphaWorkspace, "src", "status.ts"),
      'export const status = "modified";\n',
      "utf8",
    ),
    writeFile(
      path.join(alphaWorkspace, "untracked.md"),
      "# Untracked\n",
      "utf8",
    ),
  ]);
}

function oversizedPngFixture(): Buffer {
  const bytes = Buffer.alloc(
    WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES + 1,
    0x61,
  );
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(
    bytes,
  );
  return bytes;
}

export async function writeAlphaExample(content: string): Promise<void> {
  await writeFile(alphaExamplePath, content, "utf8");
}

export async function createLiveAlphaFile(content: string): Promise<void> {
  await writeFile(alphaLivePath, content, "utf8");
}

export async function updateLiveAlphaFile(content: string): Promise<void> {
  await writeFile(alphaLivePath, content, "utf8");
}

export async function deleteLiveAlphaFile(): Promise<void> {
  await rm(alphaLivePath);
}

export async function makeAlphaUnavailableRootDisappear(): Promise<void> {
  await rm(alphaUnavailableWorkspace, { force: true, recursive: true });
}
