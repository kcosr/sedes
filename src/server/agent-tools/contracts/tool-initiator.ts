export type ToolInitiator =
  | {
      readonly kind: "thread_agent";
      readonly sourceThreadId: string;
      readonly sourceWorkspaceId: string;
    }
  | {
      readonly kind: "principal_client";
      readonly clientId: string;
    };

