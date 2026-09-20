import { normalizeTheme } from "shiki/core";

const themes = Object.freeze([
  {
    name: "pierre-dark",
    load: async () =>
      normalizeTheme(
        (await import("@pierre/theme/pierre-dark")).default as unknown as Parameters<
          typeof normalizeTheme
        >[0],
      ),
  },
  {
    name: "pierre-light",
    load: async () =>
      normalizeTheme(
        (await import("@pierre/theme/pierre-light")).default as unknown as Parameters<
          typeof normalizeTheme
        >[0],
      ),
  },
]);

/** Minimal collection contract consumed by @pierre/diffs' theme resolver. */
export const pierreThemes = Object.freeze({
  getThemes: () => themes,
});

export const shikiThemes = Object.freeze({
  getTheme: () => undefined,
});

export function createTheme(input: {
  readonly name: string;
  readonly load: () => Promise<unknown>;
  readonly colorScheme?: string;
  readonly collection?: string;
  readonly displayName?: string;
}) {
  return {
    ...input,
    load: async () => {
      const loaded = await input.load();
      const theme =
        typeof loaded === "object" && loaded !== null && "default" in loaded
          ? loaded.default
          : loaded;
      return normalizeTheme(theme as Parameters<typeof normalizeTheme>[0]);
    },
  };
}
