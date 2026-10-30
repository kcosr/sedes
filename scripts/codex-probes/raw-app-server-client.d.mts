export function probeEnvironment(codexHome: string): Record<string, string>;

export interface RawCodexNotification<Params = unknown> {
  method: string;
  params: Params;
}

export class RawCodexAppServerClient {
  constructor(input: {
    codexBinary: string;
    cwd: string;
    environment: Record<string, string>;
    notificationObserver?: (notification: RawCodexNotification) => void;
    serverRequestHandler?: (request: {
      id: string | number;
      method: string;
      params: unknown;
    }) => unknown | Promise<unknown>;
    faultInjection?: { withholdResponseMethods?: readonly string[] };
  });
  readonly pid: number | undefined;
  readonly stderr: string;
  start(): Promise<unknown>;
  request<Result = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<Result>;
  notify(method: string, params: unknown): Promise<void>;
  nextNotification<Params = unknown>(method: string, timeoutMs?: number): Promise<RawCodexNotification<Params>>;
  close(): Promise<void>;
}
