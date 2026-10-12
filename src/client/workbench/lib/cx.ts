export type ClassValue = string | false | 0 | null | undefined;

/** Join truthy class names: `cx("wb-btn", on && "is-on")`. */
export function cx(...values: ClassValue[]): string {
  let out = "";
  for (const value of values) {
    if (value) out = out ? `${out} ${value}` : value;
  }
  return out;
}

/** Status tones shared by badges, pills, dots, banners and row icons. */
export type Tone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "muted";

/** `wb-tone-<tone>` modifier class (or undefined). */
export function toneClass(tone: Tone | null | undefined): string | undefined {
  return tone ? `wb-tone-${tone}` : undefined;
}
