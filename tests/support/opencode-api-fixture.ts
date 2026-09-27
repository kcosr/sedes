import type { SessionInfo, SessionMessageInfo } from "@opencode/client";

/** Deterministic native wire fixture. Production validation remains in the API. */
export function createOpenCodeApiFixture(input: {
  sessionID?: string;
  directory?: string;
  messages?: SessionMessageInfo[];
  session?: SessionInfo;
  autoConnect?: boolean;
} = {}) {
  const sessionID = input.sessionID ?? "ses_fixture";
  const directory = input.directory ?? "/fixture/workspace";
  const session: SessionInfo = input.session ?? {
    id: sessionID, projectID: "prj_fixture", title: "Fixture", location: { directory },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  };
  const messages = [...(input.messages ?? [])];
  const sessions = [session];
  const requests: { method: string; pathname: string; query: URLSearchParams; body?: unknown }[] = [];
  const responses = new Map<string, { status: number; body: unknown }>();
  const holds = new Map<string, { wait: Promise<void>; entered(): void }>();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const connection = () => ({ id: "evt_connected", type: "server.connected", data: {} });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const decode = (value: string) => JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, any>;
  const missing = (messageID?: string) => json(404, messageID
    ? { _tag: "MessageNotFoundError", sessionID, messageID, message: "fixture message missing" }
    : { _tag: "SessionNotFoundError", sessionID, message: "fixture session missing" });
  const fixture = {
    sessionID, directory, session, sessions, messages, requests,
    setResponse(pathname: string, status: number, body: unknown) { responses.set(pathname, { status, body }); },
    clearResponse(pathname: string) { responses.delete(pathname); },
    hold(pathname: string) {
      let release!: () => void; let entered!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      const observed = new Promise<void>(resolve => { entered = resolve; });
      holds.set(pathname, { wait, entered });
      return { entered: observed, release: () => { holds.delete(pathname); release(); } };
    },
    connected() { fixture.send(connection()); },
    send(event: unknown) { fixture.sendRaw(`data: ${JSON.stringify(event)}\n\n`); },
    sendRaw(frame: string) { for (const stream of streams) stream.enqueue(encoder.encode(frame)); },
    disconnect() { for (const stream of streams) stream.close(); streams.clear(); },
    fetch: async (value: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = new URL(value instanceof Request ? value.url : String(value));
      const method = init?.method ?? "GET";
      requests.push({ method, pathname: url.pathname, query: url.searchParams,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
      if (requests.length > 20_000) throw new Error("fixture request budget exceeded");
      if (!new Headers(init?.headers).has("authorization")) return json(401, {});
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const held = holds.get(url.pathname);
      if (held) {
        held.entered();
        await new Promise<void>((resolve, reject) => {
          const abort = () => { init?.signal?.removeEventListener("abort", abort); reject(new DOMException("Aborted", "AbortError")); };
          init?.signal?.addEventListener("abort", abort, { once: true });
          void held.wait.then(() => { init?.signal?.removeEventListener("abort", abort); resolve(); });
        });
      }
      const override = responses.get(url.pathname);
      if (override) return json(override.status, override.body);
      if (url.pathname === "/api/event") {
        let owned: ReadableStreamDefaultController<Uint8Array>;
        const abort = () => { streams.delete(owned); owned.error(new DOMException("Aborted", "AbortError")); };
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            owned = controller; streams.add(controller);
            init?.signal?.addEventListener("abort", abort, { once: true });
            if (input.autoConnect !== false) controller.enqueue(encoder.encode(`data: ${JSON.stringify(connection())}\n\n`));
          },
          cancel() { streams.delete(owned); init?.signal?.removeEventListener("abort", abort); },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname === "/api/info") return json(200, { version: "2.0.18", pid: process.pid, paths: { tmp: "/tmp" }, urls: [] });
      if (url.pathname === "/api/session/active") return json(200, { data: {} });
      if (url.pathname === "/api/shell") return json(200, { location: { directory }, data: [] });
      if (url.pathname === "/api/session") {
        const supplied = url.searchParams.get("cursor");
        let anchor: Record<string, any> | undefined;
        try { anchor = supplied ? decode(supplied) : undefined; } catch { return json(400, { _tag: "InvalidCursorError", message: "fixture cursor invalid" }); }
        const order = anchor?.order ?? url.searchParams.get("order") ?? "desc";
        const parentID = anchor?.parentID ?? url.searchParams.get("parentID");
        const scoped = sessions.filter(item => parentID === null ? true : parentID === "null" ? !item.parentID : item.parentID === parentID);
        const ordered = order === "asc" ? scoped : [...scoped].reverse();
        const position = anchor ? ordered.findIndex(item => item.id === anchor!.anchor.id) : -1;
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const selected = anchor && position < 0 ? [] : anchor?.anchor.direction === "previous"
          ? ordered.slice(Math.max(0, position - limit), position) : ordered.slice(position + 1, position + 1 + limit);
        return json(200, { data: selected, cursor: {
          previous: selected.length ? cursor({ order, parentID, anchor: { id: selected[0]!.id, time: selected[0]!.time.updated, direction: "previous" } }) : null,
          next: selected.length ? cursor({ order, parentID, anchor: { id: selected.at(-1)!.id, time: selected.at(-1)!.time.updated, direction: "next" } }) : null,
        } });
      }
      if (url.pathname === `/api/session/${sessionID}`) return json(200, { data: session });
      if (url.pathname === `/api/session/${sessionID}/message`) {
        const supplied = url.searchParams.get("cursor");
        let anchor: Record<string, any> | undefined;
        try { anchor = supplied ? decode(supplied) : undefined; } catch { return json(400, { _tag: "InvalidCursorError", message: "fixture cursor invalid" }); }
        if (supplied && url.searchParams.has("order")) return json(400, { _tag: "InvalidCursorError", message: "fixture cursor and order" });
        const order = anchor?.order ?? url.searchParams.get("order") ?? "desc";
        const ordered = order === "asc" ? messages : [...messages].reverse();
        const position = anchor ? ordered.findIndex(item => item.id === anchor!.id) : -1;
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const selected = anchor && position < 0 ? [] : anchor?.direction === "previous"
          ? ordered.slice(Math.max(0, position - limit), position) : ordered.slice(position + 1, position + 1 + limit);
        return json(200, { data: selected, cursor: {
          previous: selected.length ? cursor({ id: selected[0]!.id, order, direction: "previous" }) : null,
          next: selected.length ? cursor({ id: selected.at(-1)!.id, order, direction: "next" }) : null,
        } });
      }
      const prefix = `/api/session/${sessionID}/message/`;
      if (url.pathname.startsWith(prefix)) {
        const messageID = decodeURIComponent(url.pathname.slice(prefix.length));
        const message = messages.find(item => item.id === messageID);
        return message ? json(200, { data: message }) : missing(messageID);
      }
      if (["inbox", "permission", "form"].some(route => url.pathname === `/api/session/${sessionID}/${route}`)) return json(200, { data: [] });
      if (url.pathname === `/api/session/${sessionID}/interrupt` && method === "POST") return json(200, { interrupted: true });
      return missing();
    },
  };
  return fixture;
}
