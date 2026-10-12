import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentToolModelContentsSchema, type AgentToolModelContent } from "./model-content.js";

export type CliModelContent =
  | Extract<AgentToolModelContent, { type: "text" }>
  | { readonly type: "image"; readonly mimeType: "image/png"; readonly path: string; readonly byteSize: number };

/** Files live on the CLI execution host, including when the result came from a remote server. */
export async function materializeToolModelContent(content: readonly AgentToolModelContent[], signal?: AbortSignal): Promise<{
  readonly content: readonly CliModelContent[];
  readonly cleanup: () => Promise<void>;
}> {
  const validated = agentToolModelContentsSchema.parse(content);
  let directory: string | undefined;
  const cleanup = async () => { if (directory) await rm(directory, { recursive: true, force: true }); };
  try {
    signal?.throwIfAborted();
    const result: CliModelContent[] = [];
    for (const block of validated) {
      signal?.throwIfAborted();
      if (block.type === "text") { result.push(block); continue; }
      if (!directory) {
        directory = await mkdtemp(path.join(tmpdir(), "sedes-tool-media-"));
        await chmod(directory, 0o700);
      }
      const filePath = path.join(directory, `image-${result.length + 1}.png`);
      const bytes = Buffer.from(block.data, "base64");
      await writeFile(filePath, bytes, { flag: "wx", mode: 0o600, signal });
      await chmod(filePath, 0o600);
      result.push({ type: "image", mimeType: block.mimeType, path: filePath, byteSize: bytes.length });
    }
    signal?.throwIfAborted();
    return { content: result, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
