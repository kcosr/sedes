import { createContext } from "react";

/**
 * The current foreground thread's Chat composer can receive voice even while
 * another workspace panel covers it. A selected TUI or inactive workbench cannot.
 * Standalone composers represent an active Chat target by default.
 */
export const VoiceComposerTargetContext = createContext(true);
