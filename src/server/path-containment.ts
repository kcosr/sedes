import path from "node:path";

type ContainmentPath = Pick<typeof path, "isAbsolute" | "relative" | "sep">;

/**
 * Platform-path containment that does not reject legitimate `..name` segments,
 * accepts a filesystem root (`/`, `C:\`) as the root, and rejects a candidate
 * on another Windows drive (where `relative` returns an absolute path).
 */
export function pathIsWithin(
  root: string,
  candidate: string,
  pathModule: ContainmentPath = path,
): boolean {
  const relative = pathModule.relative(root, candidate);
  return (
    relative === "" ||
    (!pathModule.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${pathModule.sep}`))
  );
}
