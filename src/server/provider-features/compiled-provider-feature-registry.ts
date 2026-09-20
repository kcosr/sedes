import { codexExecutionFeatureModule } from "../backends/codex/codex-execution-feature.js";
import { codexFastModeFeatureModule } from "../backends/codex/codex-fast-mode-feature.js";
import { codexGoalFeatureModule } from "../backends/codex/codex-goal-feature.js";
import { codexTuiFeatureModule } from "../backends/codex/codex-tui-feature.js";
import { claudePermissionsFeatureModule } from "../backends/claude/claude-permissions-feature.js";
import { ProviderFeatureRegistry } from "./provider-feature-registry.js";

export const compiledProviderFeatureRegistry = new ProviderFeatureRegistry([
  claudePermissionsFeatureModule,
  codexExecutionFeatureModule,
  codexFastModeFeatureModule,
  codexGoalFeatureModule,
  codexTuiFeatureModule,
]);
