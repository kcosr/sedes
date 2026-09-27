import { createOpenCodeNativePortFixture } from "../helpers/opencode-native-port-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeSkillCatalog } from "../../src/server/backends/opencode/opencode-skill-catalog.js";
import { OpenCodeNativeMutations } from "../../src/server/backends/opencode/opencode-native-mutations.js";
import { createOpenCodeConversationFixture, scope } from "../support/opencode-conversation-fixture.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
function fixture() {
  const f = createOpenCodeConversationFixture(); closes.push(f.dispose);
  const native = new OpenCodeNativeMutations(f.port);
  const reader = new OpenCodeSkillCatalog({ scope, backendInstanceId: f.context.instance.id, nativeNamespaceKey: f.context.nativeNamespaceKey,
    readNative: (directory, signal) => native.listSkills(directory, signal) });
  const skill = { id: "manual-review", name: "Manual review", description: "Review current changes", autoinvoke: false,
    path: "/private/canary-path/SKILL.md", content: "private source body canary" };
  const set = (skills = [skill], directory = f.wire.directory) => f.wire.setResponse("/api/skill", 200, { location: { directory }, data: skills });
  set();
  const target = { connection: f.context.connection, workspace: f.target.workspace };
  return { ...f, native, reader, skill, set, target };
}
describe("OpenCode manual skills", () => {
  it("projects manual-only skills without leaking native source path/body", async () => {
    const f = fixture(); const read = await f.reader.read(f.target);
    expect(read.skills).toEqual([{ id: expect.stringMatching(/^oc_skill_[0-9a-f]{64}$/u), name: "Manual review", reference: "@manual-review", description: "Review current changes" }]);
    expect(JSON.stringify(read.skills)).not.toContain("canary");
    expect(read.selections.get(read.skills[0]!.id)).toBe("manual-review");
    expect(f.wire.requests.every(request => request.method === "GET")).toBe(true);
  });
  it("binds opaque selection to scope/connection/workspace and rejects changed or removed selection", async () => {
    const f = fixture(); const id = (await f.reader.read(f.target)).skills[0]!.id;
    await expect(f.reader.resolve({ ...f.target, selectedSkillId: id })).resolves.toBe(f.skill.id);
    await expect(f.reader.resolve({ ...f.target, connection: { ...f.target.connection, ownerPrincipalId: "foreign" }, selectedSkillId: id })).rejects.toBeDefined();
    await expect(f.reader.resolve({ ...f.target, connection: { ...f.target.connection, id: "other-connection" }, selectedSkillId: id })).rejects.toBeDefined();
    f.set([{ ...f.skill, content: "new body", path: "/private/new/SKILL.md" }]);
    expect((await f.reader.read(f.target)).skills[0]!.id).toBe(id);
    f.set([]); await expect(f.reader.resolve({ ...f.target, selectedSkillId: id })).rejects.toMatchObject({ backendCode: "opencode_skill_unavailable" });
  });
  it("rejects wrong location/duplicate IDs and omits unsupported reference values with a bounded notice", async () => {
    const f = fixture(); f.set([f.skill], "/other/workspace");
    await expect(f.reader.read(f.target)).rejects.toBeDefined();
    f.set([f.skill, f.skill]); await expect(f.reader.read(f.target)).rejects.toBeDefined();
    f.set([{ ...f.skill, id: "bad\nreference" }, { ...f.skill, id: "x".repeat(240) }]);
    await expect(f.reader.read(f.target)).resolves.toMatchObject({ skills: [], notices: [expect.objectContaining({ text: expect.any(String) })] });
  });
  it("keeps native commands unavailable and preserves model catalog when skills cannot load", async () => {
    const f = fixture();
    vi.spyOn(f.context.catalog.input, "readNative").mockResolvedValue({ models: [] });
    f.wire.setResponse("/api/skill", 503, {});
    const catalog = await f.driver.catalog({ scope, workspace: f.target.workspace });
    expect(catalog.commands).toEqual([]); expect(catalog.skills).toEqual([]); expect(catalog.notices.length).toBeGreaterThan(0);
  });
});
