import {
  inFlightSql,
  needsAttentionSql,
  undismissedNoticeSql,
} from "./automation-read-sql.js";

/**
 * A one-shot whose current scheduled occurrence succeeded retires once
 * nothing about it remains for the user to see or dismiss: no result notice
 * from any of its runs, no unresolved problem, and no work in flight.
 *
 * Retirement follows the notices actually shown rather than the scheduled
 * run's own acknowledgement. The anchor shows one notice for the latest
 * decisive run, so a later Run now supersedes the scheduled notice there;
 * the user then dismisses that run's failure, or nothing at all after its
 * success. Fork result threads keep one notice per run until each is
 * dismissed. In-flight work is the same latest-turn rule the collection
 * shows, so an older turn that never settled cannot block retirement
 * invisibly. Retain every record; queued input and thread lineage still
 * refer to the definition and run after it leaves normal views.
 */
export function retirableOneShotSql(definition: string): string {
  return `(${definition}.deleted_at IS NULL
    AND ${definition}.schedule_kind = 'date_time'
    AND EXISTS (
      SELECT 1 FROM automation_runs AS finished
      WHERE finished.tenant_id = ${definition}.tenant_id
        AND finished.owner_principal_id = ${definition}.owner_principal_id
        AND finished.automation_id = ${definition}.id
        AND finished.occurrence_kind = 'scheduled'
        AND finished.occurrence_key = 'scheduled:' || ${definition}.run_at
        AND finished.state = 'completed' AND finished.turn_outcome = 'completed'
        AND finished.force_reset_at IS NULL
    )
    AND NOT ${needsAttentionSql(definition)}
    AND NOT ${inFlightSql(definition)}
    AND NOT ${undismissedNoticeSql(definition)})`;
}
