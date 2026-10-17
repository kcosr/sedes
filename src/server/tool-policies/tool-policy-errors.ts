import {
  toolPolicyResolutionIssueSchema,
  type ToolPolicyResolutionIssue,
} from "../../shared/protocol/tool-policies.js";
import { DomainError } from "../domain/errors.js";

/** A missing selected definition remains an explicit, actionable failure. */
export class ToolPolicyResolutionError extends DomainError {
  readonly issue: ToolPolicyResolutionIssue;

  constructor(issue: ToolPolicyResolutionIssue) {
    const parsed = toolPolicyResolutionIssueSchema.parse(issue);
    const labels = {account:"account",environment:"environment",backend:"backend",agent:"Agent",thread:"thread"} as const;
    super("not_found", `The ${labels[parsed.source]} tool policy set was not found. Choose a thread policy or repair the ${labels[parsed.source]} setting.`);
    this.name = "ToolPolicyResolutionError";
    this.issue = parsed;
  }
}
