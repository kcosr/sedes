import process from "node:process";

function argumentsFrom(argv) {
  let threadId;
  let baseUrl = "http://127.0.0.1:4784";
  let repeats = 3;
  for (const argument of argv) {
    if (argument.startsWith("--url=")) {
      baseUrl = argument.slice("--url=".length);
    } else if (argument.startsWith("--repeats=")) {
      repeats = Number(argument.slice("--repeats=".length));
    } else if (!threadId) {
      threadId = argument;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }
  if (!threadId) {
    throw new Error(
      "Usage: npm run measure:thread -- THREAD_ID [--repeats=3] [--url=http://127.0.0.1:4784]",
    );
  }
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20) {
    throw new Error("--repeats must be an integer from 1 through 20.");
  }
  const url = new URL(baseUrl);
  if (
    url.protocol !== "http:" ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    !["127.0.0.1", "localhost"].includes(url.hostname)
  ) {
    throw new Error("--url must be a loopback HTTP origin without credentials, path, query, or fragment.");
  }
  return { threadId, baseUrl: url.origin, repeats };
}

function round(milliseconds) {
  return Math.round(milliseconds * 10) / 10;
}

async function measureSession(baseUrl) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/api/application/session`, {
    redirect: "error",
    headers: { Accept: "application/json", ...authenticationHeaders },
  });
  const body = await response.arrayBuffer();
  if (!response.ok) {
    if (response.status === 401) throw new Error("Set SEDES_AUTH_TOKEN to a valid paired device credential for this server.");
    throw new Error(
      `Application session failed with HTTP ${response.status}.`,
    );
  }
  return {
    milliseconds: round(performance.now() - startedAt),
    bytes: body.byteLength,
  };
}

function parseFrame(frame) {
  let event = "message";
  const data = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trimStart();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join("\n") };
}

async function measureThread(baseUrl, threadId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  timeout.unref();
  const startedAt = performance.now();
  try {
    const response = await fetch(
      `${baseUrl}/api/threads/${encodeURIComponent(threadId)}/events?activityDetail=full`,
      {
        redirect: "error",
        headers: { Accept: "text/event-stream", ...authenticationHeaders },
        signal: controller.signal,
      },
    );
    const headersAt = performance.now();
    if (!response.ok || !response.body) {
      throw new Error(`Thread stream failed with HTTP ${response.status}.`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let frameBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Thread stream ended before its snapshot.");
      buffered += decoder
        .decode(value, { stream: true })
        .replaceAll("\r\n", "\n");
      let boundary;
      while ((boundary = buffered.indexOf("\n\n")) >= 0) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        frameBytes += Buffer.byteLength(`${frame}\n\n`, "utf8");
        const parsed = parseFrame(frame);
        if (!parsed.data) continue;
        if (parsed.event === "thread-load-error") {
          const failure = JSON.parse(parsed.data);
          throw new Error(`Thread load failed: ${failure.error?.code ?? "unknown"}.`);
        }
        if (parsed.event !== "thread" && parsed.event !== "thread-checkpoint") continue;
        const envelope = JSON.parse(parsed.data);
        const snapshot = parsed.event === "thread-checkpoint"
          ? envelope.snapshot
          : envelope?.event?.type === "snapshot" ? envelope.event.snapshot : undefined;
        if (!snapshot) continue;
        await reader.cancel();
        return {
          headersMilliseconds: round(headersAt - startedAt),
          snapshotMilliseconds: round(performance.now() - startedAt),
          receivedBytes: frameBytes,
          turns: snapshot.orderedTurnIds?.length ?? null,
          items: snapshot.itemsById
            ? Object.keys(snapshot.itemsById).length
            : null,
        };
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

const options = argumentsFrom(process.argv.slice(2));
const credential = process.env.SEDES_AUTH_TOKEN;
if (credential !== undefined && !/^[A-Za-z0-9_-]{43}$/u.test(credential)) {
  throw new Error("SEDES_AUTH_TOKEN must be a paired device credential.");
}
const authenticationHeaders = credential ? { Authorization: `Bearer ${credential}` } : {};
const session = await measureSession(options.baseUrl);
const thread = [];
for (let attempt = 1; attempt <= options.repeats; attempt += 1) {
  thread.push(await measureThread(options.baseUrl, options.threadId));
}
process.stdout.write(
  `${JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      baseUrl: options.baseUrl,
      threadId: options.threadId,
      session,
      thread,
    },
    null,
    2,
  )}\n`,
);
