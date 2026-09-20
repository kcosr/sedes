export type AutomationRunMode = "same_thread" | "clone";

export type AutomationMisfirePolicy = "coalesce" | "skip";

export type AutomationPrecheck = {
  readonly command: string;
  readonly timeoutSeconds: number;
  readonly includeStdout: boolean;
};

export type AutomationSchedule =
  | {
      readonly kind: "date_time";
      readonly runAt: number;
    }
  | {
      readonly kind: "interval";
      readonly anchorAt: number;
      readonly everySeconds: number;
    }
  | {
      readonly kind: "cron";
      readonly expression: string;
      readonly timeZone: string;
    };

export type AutomationDefinitionRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly id: string;
  readonly anchorThreadId: string;
  readonly name: string;
  readonly prompt: string;
  readonly precheck: AutomationPrecheck | null;
  readonly runMode: AutomationRunMode;
  readonly enabled: boolean;
  readonly completedAt: number | null;
  readonly deletedAt: number | null;
  readonly revision: number;
  readonly schedule: AutomationSchedule;
  readonly misfirePolicy: AutomationMisfirePolicy;
  readonly nextRunAt: number | null;
  readonly lastScheduledAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type AutomationOccurrenceKind = "scheduled" | "manual";

export type AutomationRunState =
  | "claimed"
  | "dispatching"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "uncertain";

export type AutomationPrecheckStatus =
  "not_configured" | "pending" | "checking" | "passed" | "skipped" | "failed";

export type AutomationRunRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly automationId: string;
  readonly id: string;
  readonly occurrenceKind: AutomationOccurrenceKind;
  readonly scheduledFor: number;
  readonly occurrenceKey: string;
  readonly definitionRevision: number;
  readonly coalescedCount: number;
  readonly runMode: AutomationRunMode;
  readonly state: AutomationRunState;
  readonly claimToken: string | null;
  readonly leaseExpiresAt: number | null;
  readonly claimAttemptCount: number;
  readonly promptSnapshot: string | null;
  readonly precheckCommandSnapshot: string | null;
  readonly precheckTimeoutSeconds: number | null;
  readonly precheckIncludeStdout: boolean | null;
  readonly precheckStatus: AutomationPrecheckStatus;
  readonly precheckStartedAt: number | null;
  readonly precheckFinishedAt: number | null;
  readonly precheckExitCode: number | null;
  readonly precheckDurationMs: number | null;
  readonly precheckStdoutBytes: number | null;
  readonly precheckStdoutIncluded: boolean | null;
  readonly dispatchMutationId: string;
  readonly anchorThreadId: string;
  readonly childThreadId: string | null;
  readonly errorCode: string | null;
  readonly errorDiagnostic: string | null;
  readonly claimedAt: number;
  readonly startedAt: number | null;
  readonly acceptedAt: number | null;
  readonly finishedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};
