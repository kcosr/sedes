import { BackendModuleCatalog } from "./module-catalog.js";
import { CodexBackendModule } from "./codex/codex-backend-module.js";
import { PiBackendModule } from "./pi/pi-backend-module.js";
import { ClaudeBackendModule } from "./claude/claude-backend-module.js";
import { GrokBackendModule } from "./grok/grok-backend-module.js";

/**
 * Sole build-time provider catalog. Shared composition imports this value and
 * never imports an individual provider implementation.
 */
export const compiledBackendModuleCatalog = new BackendModuleCatalog([
  new PiBackendModule(),
  new CodexBackendModule(),
  new ClaudeBackendModule(),
  new GrokBackendModule(),
]);
