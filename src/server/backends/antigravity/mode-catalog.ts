import { antigravityConfigOption, antigravitySelectOptions } from "./catalog.js";
import { ANTIGRAVITY_MODES, type AntigravityMode } from "./mode-feature.js";
import type { AntigravitySetup } from "./port.js";

/** Runtime-owned evidence for the mode feature and backend-owned Saved Agent
 * configuration. The live session rechecks its exact selector before each prompt. */
export class AntigravityModeCatalog {
  #modes: readonly AntigravityMode[] = [];
  #revision = 0;
  get modes() { return this.#modes; }
  get revision() { return this.#revision; }
  observe(setup: AntigravitySetup): void {
    const advertised = new Set(antigravitySelectOptions(antigravityConfigOption(setup, "mode")).map(option => option.value));
    const modes = ANTIGRAVITY_MODES.filter(mode => advertised.has(mode));
    if (JSON.stringify(modes) !== JSON.stringify(this.#modes)) { this.#modes = modes; this.#revision++; }
  }
  allows(mode: string): mode is AntigravityMode { return this.#modes.some(value => value === mode); }
}
