/**
 * The bundled code font for canvas renderers (terminal panes and the Codex
 * TUI). styles.css imports JetBrains Mono from
 * `@fontsource-variable/jetbrains-mono` and puts it first in `--font-mono`; a
 * canvas cannot resolve CSS variables, so it uses this list, which matches the
 * token exactly (code-font.test.ts keeps the two in step).
 */
export const CODE_FONT_FAMILY =
  '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace';

/** The family name the font package registers with `@font-face`. */
const BUNDLED_CODE_FONT = '"JetBrains Mono Variable"';

/**
 * How long a canvas renderer waits for the bundled font before it measures
 * with a fallback. The font ships with the client, so it normally loads well
 * inside this; a late load is remeasured through `onCodeFontLoaded`.
 */
export const CODE_FONT_LOAD_TIMEOUT_MS = 1_000;

let codeFontLoad: Promise<boolean> | undefined;

/**
 * Starts loading the bundled code font, once per document. A canvas draws with
 * a fallback until the face is loaded and never asks for it itself, so the
 * load is explicit. Resolves true once the face is loaded, and false when it
 * fails or the document has no font loading API (jsdom); never rejects. A
 * failed load is retried by the next call.
 */
function loadCodeFont(): Promise<boolean> {
  if (codeFontLoad) return codeFontLoad;
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (typeof fonts?.load !== "function") return Promise.resolve(false);
  // The default sample text is a space, which selects the Latin face.
  const load = fonts.load(`16px ${BUNDLED_CODE_FONT}`).then(
    (faces) => faces.some((face) => face.status === "loaded"),
    () => false,
  );
  codeFontLoad = load;
  void load.then((loaded) => {
    if (!loaded && codeFontLoad === load) codeFontLoad = undefined;
  });
  return load;
}

/**
 * Waits for the bundled code font so a canvas measures its cells with the font
 * it draws. Resolves true when the font is ready, and false after `timeoutMs`
 * or on failure, so a renderer never waits longer than the timeout.
 */
export function waitForCodeFont(
  timeoutMs = CODE_FONT_LOAD_TIMEOUT_MS,
): Promise<boolean> {
  const load = loadCodeFont();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void load.then((loaded) => {
      clearTimeout(timer);
      resolve(loaded);
    });
  });
}

/**
 * Calls `listener` once when the bundled code font has loaded, for a renderer
 * that measured with a fallback after `waitForCodeFont` timed out. Returns a
 * function that cancels the call.
 */
export function onCodeFontLoaded(listener: () => void): () => void {
  let active = true;
  void loadCodeFont().then((loaded) => {
    if (active && loaded) listener();
  });
  return () => {
    active = false;
  };
}
