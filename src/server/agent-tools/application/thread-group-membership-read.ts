import type { NormalizedThreadGroup } from "../../../shared/protocol/thread-groups.js";

export type AgentThreadGroup = Pick<NormalizedThreadGroup, "id" | "name">;
export type ThreadGroupMembershipRow =
  | { readonly groupId: string; readonly groupName: string }
  | { readonly groupId: null; readonly groupName: null };

// Both thread readers select from the same principal-owned state row.
export const threadGroupMembershipJoins = `
  LEFT JOIN thread_group_memberships AS membership
    ON membership.tenant_id = principal.tenant_id
    AND membership.principal_id = principal.principal_id
    AND membership.thread_id = principal.thread_id
  LEFT JOIN thread_groups AS thread_group
    ON thread_group.tenant_id = membership.tenant_id
    AND thread_group.principal_id = membership.principal_id
    AND thread_group.id = membership.group_id`;

export function projectThreadGroup(row: ThreadGroupMembershipRow): AgentThreadGroup | null {
  return row.groupId === null ? null : { id: row.groupId, name: row.groupName };
}
