import type {
  AutomationPrecheckTestResult as SharedAutomationPrecheckTestResult,
  ThreadAutomationDefinition as SharedThreadAutomationDefinition,
  ThreadAutomationRun as SharedThreadAutomationRun,
  ThreadAutomationSchedulePreview as SharedThreadAutomationSchedulePreview,
} from "../shared/protocol/automation-presentation.js";
import type { AutomationPrecheck as SharedAutomationPrecheck } from "../shared/protocol/automation.js";

export type Appearance = "system" | "light" | "dark";
export type AutomationPrecheck = SharedAutomationPrecheck;
export type AutomationPrecheckTestResult = SharedAutomationPrecheckTestResult;
export type ThreadAutomationDefinition = SharedThreadAutomationDefinition;
export type ThreadAutomationRun = SharedThreadAutomationRun;
export type ThreadAutomationSchedulePreview =
  SharedThreadAutomationSchedulePreview;

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}
