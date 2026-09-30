/**
 * The one tone vocabulary for status and feedback primitives (Badge,
 * StatusPill, Callout, DialogAlert, CountBadge, ConfirmDialog). Each
 * primitive accepts the subset that makes sense for it. `danger` draws on
 * the `--destructive*` color tokens; Button and menu items keep
 * `variant="destructive"`, which names an action, not a tone.
 */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger"
