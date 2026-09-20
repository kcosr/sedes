import { createContext } from "react";

/**
 * Whether the chat transcript panel is the visible thread view. The managed
 * Codex TUI presentation keeps the chat subtree mounted but hidden while its
 * terminal view is active; the transcript consumes this signal to snap back
 * to the live edge when the chat view is revealed again.
 */
export const ChatViewVisibilityContext = createContext(true);
