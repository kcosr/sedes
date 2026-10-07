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
  /**
   * Advances whenever the definition's presented run history changes: a new
   * run, a state change or a turn settlement. Database triggers maintain it.
   */
  readonly runsRevision: number;
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

/** How the agent turn a run's prompt started ended, from the completion rail. */
export type AutomationTurnOutcome = "completed" | "interrupted" | "failed";

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
  /** Set when a thread force reset abandoned this run; such runs are immutable. */
  readonly forceResetAt: number | null;
  /**
   * The settlement of the agent turn the run's prompt started: the
   * application turn id, its outcome and when Sedes observed the end, all
   * null until the turn settles and then never changed. Separate from
   * `state`, which records delivery.
   */
  readonly turnId: string | null;
  readonly turnOutcome: AutomationTurnOutcome | null;
  readonly turnSettledAt: number | null;
  /** The turn's own start and end, when its backend reports them. */
  readonly turnStartedAt: number | null;
  readonly turnEndedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** Run-history views: problems are failed or uncertain runs, or a failed turn. */
export type AutomationRunFilter = "all" | "problems" | "skipped";

export type AutomationRunCounts = {
  readonly all: number;
  readonly problems: number;
  readonly skipped: number;
};
