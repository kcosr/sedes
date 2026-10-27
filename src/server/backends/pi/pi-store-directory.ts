import { realpath } from "node:fs/promises";
import path from "node:path";

/** Resolve store identity before publication without creating directories. */
export async function canonicalPiStoreDirectory(directory: string): Promise<string> {
  let ancestor = directory;
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(ancestor), ...missing);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw cause;
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}
