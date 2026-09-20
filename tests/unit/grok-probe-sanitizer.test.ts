import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const rootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const sanitizerPath = path.join(
  rootDirectory,
  "scripts/grok-probes/sanitize-grok-evidence.mjs",
);
const fixturesDirectory = path.join(
  rootDirectory,
  "tests/fixtures/grok-probes",
);
const SECRET = "GROK_TEST_SECRET_CANARY_6f22c9a1";

interface Invocation {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function privateTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "sedes-grok-sanitizer-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function writePrivateRaw(
  directory: string,
  name: string,
  contents: string,
): Promise<string> {
  const rawPath = path.join(directory, name);
  await writeFile(rawPath, contents, { mode: 0o600 });
  await chmod(rawPath, 0o600);
  return rawPath;
}

async function invoke(args: readonly string[]): Promise<Invocation> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [sanitizerPath, ...args],
      { cwd: rootDirectory, env: { ...process.env } },
      (error, stdout, stderr) => {
        const processError = error as { readonly code?: unknown } | null;
        resolve({
          code:
            typeof processError?.code === "number"
              ? processError.code
              : error
                ? 1
                : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

async function invokeAbortableModule(
  inputPath: string,
  outputPath: string,
  mode: "pre_aborted" | "scheduled",
): Promise<Invocation> {
  const source = `
    import { sanitizeGrokEvidence } from ${JSON.stringify(pathToFileURL(sanitizerPath).href)};
    const controller = new AbortController();
    if (process.env.SANITIZER_ABORT_MODE === "pre_aborted") controller.abort();
    else setTimeout(() => controller.abort(), 0);
    try {
      await sanitizeGrokEvidence({
        inputPath: process.env.SANITIZER_INPUT,
        outputPath: process.env.SANITIZER_OUTPUT,
        signal: controller.signal,
      });
      process.stdout.write(JSON.stringify({ status: "resolved" }) + "\\n");
    } catch (error) {
      process.stdout.write(JSON.stringify({ status: "rejected", code: error?.code }) + "\\n");
    }
  `;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--input-type=module", "--eval", source],
      {
        cwd: rootDirectory,
        env: {
          ...process.env,
          SANITIZER_ABORT_MODE: mode,
          SANITIZER_INPUT: inputPath,
          SANITIZER_OUTPUT: outputPath,
        },
      },
      (error, stdout, stderr) => {
        const processError = error as { readonly code?: unknown } | null;
        resolve({
          code:
            typeof processError?.code === "number"
              ? processError.code
              : error
                ? 1
                : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secretVariants(secret: string): readonly string[] {
  const raw = [secret, secret.slice(-8), secret.slice(-12), secret.slice(-16)];
  return [
    ...new Set(
      raw.flatMap((value) => {
        const base64 = Buffer.from(value).toString("base64");
        const base64Url = base64.replaceAll("+", "-").replaceAll("/", "_");
        const urlEncoded = encodeURIComponent(value);
        return [
          value,
          base64,
          base64Url,
          base64Url.replace(/=+$/u, ""),
          urlEncoded,
          urlEncoded.replaceAll(/%[0-9A-F]{2}/g, (escape) =>
            escape.toLowerCase(),
          ),
          JSON.stringify(value).slice(1, -1),
        ];
      }),
    ),
  ];
}

function recursivelyContains(value: unknown, marker: string): boolean {
  if (typeof value === "string") return value.includes(marker);
  if (Array.isArray(value)) {
    return value.some((entry) => recursivelyContains(entry, marker));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([key, entry]) =>
        key.includes(marker) || recursivelyContains(entry, marker),
    );
  }
  return false;
}

describe("Grok G0 evidence sanitizer", () => {
  it("joins preflight and in-progress aborts without publishing output or orphaning temporary work", async () => {
    for (const mode of ["pre_aborted", "scheduled"] as const) {
      const directory = await privateTemporaryDirectory();
      const rawPath = await writePrivateRaw(
        directory,
        `${mode}.json`,
        JSON.stringify({
          values: Array.from({ length: 10 }, (_, group) =>
            Array.from({ length: 4_000 }, (_, index) => ({ group, index })),
          ),
        }),
      );
      const outputPath = path.join(directory, `${mode}.out.json`);

      const result = await invokeAbortableModule(rawPath, outputPath, mode);

      expect(result).toEqual({
        code: 0,
        stdout: `${JSON.stringify({
          status: "rejected",
          code: "aborted",
        })}\n`,
        stderr: "",
      });
      await expect(lstat(rawPath)).resolves.toMatchObject({ mode: 0o100600 });
      await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(directory)).toEqual([`${mode}.json`]);
    }
  });

  it("emits one canonical structural JSON document and removes private raw evidence", async () => {
    const directory = await privateTemporaryDirectory();
    const rawPath = path.join(directory, "raw.json");
    const outputPath = path.join(directory, "sanitized.json");
    await copyFile(
      path.join(fixturesDirectory, "sanitization-input.json"),
      rawPath,
    );
    await chmod(rawPath, 0o600);

    const result = await invoke([
      "--input",
      rawPath,
      "--output",
      outputPath,
      "--format",
      "json",
      "--workspace",
      "/private/workspace",
      "--home",
      "/private/home",
      "--host",
      "builder.internal.example",
      "--secret-canary",
      SECRET,
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const output = await readFile(outputPath, "utf8");
    const expected = JSON.parse(
      await readFile(
        path.join(fixturesDirectory, "sanitization-expected.json"),
        "utf8",
      ),
    ) as unknown;
    expect(output).toBe(`${JSON.stringify(expected)}\n`);
    expect(JSON.parse(output)).toEqual(expected);
    expect(JSON.parse(result.stdout)).toEqual({
      format: "json",
      outputSha256: sha256(output),
      outputBytes: Buffer.byteLength(output),
    });
    await expect(lstat(rawPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(outputPath)).resolves.toMatchObject({ mode: 0o100644 });
  });

  it("preserves correlation and JSON ID types across canonical NDJSON records", async () => {
    const directory = await privateTemporaryDirectory();
    const rawPath = await writePrivateRaw(
      directory,
      "events.ndjson",
      [
        JSON.stringify({
          sessionId: "native-session",
          requestId: 7,
          toolCallId: "native-tool",
        }),
        JSON.stringify({
          requestId: 8,
          sessionId: "native-session",
          toolCallId: "native-tool",
        }),
      ].join("\n") + "\n",
    );
    const outputPath = path.join(directory, "events.sanitized.ndjson");

    const result = await invoke([
      "--input",
      rawPath,
      "--output",
      outputPath,
      "--format",
      "ndjson",
    ]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    const output = await readFile(outputPath, "utf8");
    const records = output
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line)) as Array<{
      requestId: unknown;
      sessionId: unknown;
      toolCallId: unknown;
    }>;
    expect(records).toEqual([
      {
        requestId: -1,
        sessionId: "<session-id-1>",
        toolCallId: "<tool-id-1>",
      },
      {
        requestId: -2,
        sessionId: "<session-id-1>",
        toolCallId: "<tool-id-1>",
      },
    ]);
    expect(typeof records[0]?.requestId).toBe("number");
    expect(typeof records[0]?.sessionId).toBe("string");
  });

  it("does not reinterpret ordinary lowercase words ending in id as identifiers", async () => {
    const directory = await privateTemporaryDirectory();
    const rawPath = await writePrivateRaw(
      directory,
      "non-identifiers.json",
      JSON.stringify({ grid: "layout", hybrid: "mode", valid: "yes" }),
    );
    const outputPath = path.join(directory, "non-identifiers.out.json");
    const result = await invoke(["--input", rawPath, "--output", outputPath]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual({
      grid: "layout",
      hybrid: "mode",
      valid: "yes",
    });
  });

  it("redacts plural and compound secret keys without consuming ID fields", async () => {
    const directory = await privateTemporaryDirectory();
    const rawPath = await writePrivateRaw(
      directory,
      "secret-key-backstop.json",
      JSON.stringify({
        credentials: { access: "private" },
        cachedTokens: ["private-token"],
        clientSecrets: ["private-secret"],
        databasePasswords: ["private-password"],
        sessionCookies: ["private-cookie"],
        providerApiKeys: ["private-api-key"],
        credentialId: "credential-record",
        tokenId: "token-record",
      }),
    );
    const outputPath = path.join(directory, "secret-key-backstop.out.json");
    const result = await invoke(["--input", rawPath, "--output", outputPath]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual({
      cachedTokens: "[REDACTED:secret]",
      clientSecrets: "[REDACTED:secret]",
      credentialId: "<id-1>",
      credentials: "[REDACTED:secret]",
      databasePasswords: "[REDACTED:secret]",
      providerApiKeys: "[REDACTED:secret]",
      sessionCookies: "[REDACTED:secret]",
      tokenId: "<id-2>",
    });
  });

  it("redacts full secrets and suffix, base64, URL, and JSON variants with deterministic hashes", async () => {
    const firstSecret = 'grok/secret+"alpha-91abTAIL//++';
    const secondSecret = 'grok/secret+"bravo-4ef8TAIL//++';
    const outputs: string[] = [];
    const hashes: string[] = [];

    for (const [index, secret] of [firstSecret, secondSecret].entries()) {
      const directory = await privateTemporaryDirectory();
      const variants = secretVariants(secret);
      const rawPath = await writePrivateRaw(
        directory,
        `raw-${index}.json`,
        JSON.stringify({
          sessionId: `native-session-${index}`,
          createdAt: `202${index + 5}-01-02T03:04:05.000Z`,
          workspacePath: `/private/workspace-${index}/marker.txt`,
          values: variants,
          nested: { filename: `${secret}-capture.ndjson` },
        }),
      );
      const outputPath = path.join(directory, `sanitized-${index}.json`);
      const result = await invoke([
        "--input",
        rawPath,
        "--output",
        outputPath,
        "--secret-canary",
        secret,
        "--workspace",
        `/private/workspace-${index}`,
      ]);
      expect(result).toMatchObject({ code: 0, stderr: "" });
      const output = await readFile(outputPath, "utf8");
      const parsed: unknown = JSON.parse(output);
      for (const variant of variants) {
        expect(output).not.toContain(variant);
        expect(recursivelyContains(parsed, variant)).toBe(false);
      }
      outputs.push(output);
      hashes.push(
        (JSON.parse(result.stdout) as { outputSha256: string }).outputSha256,
      );
    }

    expect(outputs[0]).toBe(outputs[1]);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).toBe(sha256(outputs[0] ?? ""));
  });

  it("normalizes embedded workspace and home paths without retaining relative filenames", async () => {
    const directory = await privateTemporaryDirectory();
    const rawPath = await writePrivateRaw(
      directory,
      "embedded.json",
      JSON.stringify({
        value:
          'opened /private/workspace/project/marker.txt and "/private/home/.grok/state file.json" via file:///private/workspace/uri/file.txt and prefix-/private/workspace/prefixed/file.txt',
      }),
    );
    const outputPath = path.join(directory, "embedded.sanitized.json");

    const result = await invoke([
      "--input",
      rawPath,
      "--output",
      outputPath,
      "--workspace",
      "/private/workspace",
      "--home",
      "/private/home",
    ]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    const output = await readFile(outputPath, "utf8");
    expect(JSON.parse(output)).toEqual({
      value:
        'opened <workspace>/<path-1>"<home>/<path-4>" via file://<workspace>/<path-2><workspace>/<path-3>',
    });
    expect(output).not.toContain("/private/workspace");
    expect(output).not.toContain("/private/home");
    expect(output).not.toContain("marker.txt");
    expect(output).not.toContain("state file.json");
    expect(output).not.toContain("uri/file.txt");
    expect(output).not.toContain("prefixed/file.txt");
  });

  it("normalizes exact configured roots before URI and log delimiters without matching sibling paths", async () => {
    const directory = await privateTemporaryDirectory();
    const rawPath = await writePrivateRaw(
      directory,
      "path-delimiters.json",
      JSON.stringify({
        value:
          "cwd=/private/workspace: file:///private/workspace?mode=probe file:///private/workspace#fragment sibling=/private/workspace-old",
      }),
    );
    const outputPath = path.join(directory, "path-delimiters.out.json");
    const result = await invoke([
      "--input",
      rawPath,
      "--output",
      outputPath,
      "--workspace",
      "/private/workspace",
    ]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual({
      value:
        "cwd=<workspace>: file://<workspace>?mode=probe file://<workspace>#fragment sibling=/private/workspace-old",
    });
  });

  it("redacts an unquoted configured path through whitespace in its tail", async () => {
    const directory = await privateTemporaryDirectory();
    const rawPath = await writePrivateRaw(
      directory,
      "path-with-whitespace.json",
      JSON.stringify({
        value: "saved to /private/home/My Documents/secret.txt",
      }),
    );
    const outputPath = path.join(directory, "path-with-whitespace.out.json");
    const result = await invoke([
      "--input",
      rawPath,
      "--output",
      outputPath,
      "--home",
      "/private/home",
    ]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    const output = await readFile(outputPath, "utf8");
    expect(JSON.parse(output)).toEqual({
      value: "saved to <home>/<path-1>",
    });
    expect(output).not.toContain("My");
    expect(output).not.toContain("Documents");
    expect(output).not.toContain("secret.txt");
  });

  it("redacts complete structured provider-message subtrees", async () => {
    const directory = await privateTemporaryDirectory();
    const rawPath = await writePrivateRaw(
      directory,
      "provider-content.json",
      JSON.stringify({
        content: [
          { type: "text", data: `private-${SECRET}` },
          { type: "image", data: "provider-image-bytes" },
        ],
        providerMessage: { nested: ["private provider text"] },
        safeKind: "tool_update",
      }),
    );
    const outputPath = path.join(directory, "provider-content.sanitized.json");
    const result = await invoke([
      "--input",
      rawPath,
      "--output",
      outputPath,
      "--secret-canary",
      SECRET,
    ]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual({
      content: "[REDACTED:provider-message]",
      providerMessage: "[REDACTED:provider-message]",
      safeKind: "tool_update",
    });
  });

  it("fails closed when private paths, hosts, accounts, or UUIDs occur in object keys", async () => {
    const privateKeys = [
      "/private/workspace/secret-file",
      "file:///private/workspace/secret-file",
      "prefix-/private/workspace/secret-file",
      "builder.internal.example",
      "account-native-a",
      "123e4567-e89b-42d3-a456-426614174000",
    ];
    for (const [index, privateKey] of privateKeys.entries()) {
      const directory = await privateTemporaryDirectory();
      const rawPath = await writePrivateRaw(
        directory,
        `private-key-${index}.json`,
        JSON.stringify({ [privateKey]: "value" }),
      );
      const outputPath = path.join(directory, `private-key-${index}.out.json`);
      const result = await invoke([
        "--input",
        rawPath,
        "--output",
        outputPath,
        "--workspace",
        "/private/workspace",
        "--host",
        "builder.internal.example",
        "--account",
        "account-native-a",
      ]);
      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr: "grok_evidence_sanitization_failed\n",
      });
      await expect(lstat(rawPath)).resolves.toBeDefined();
      await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("fails closed when session, prompt, tool, or RPC IDs are used as dynamic object keys", async () => {
    const cases = [
      { idField: "sessionId", id: "native-session", mapField: "bySession" },
      { idField: "promptId", id: "native-prompt", mapField: "byPrompt" },
      { idField: "toolCallId", id: "native-tool-call", mapField: "byTool" },
      { idField: "requestId", id: 27, mapField: "byRequest" },
    ] as const;
    for (const [index, value] of cases.entries()) {
      const directory = await privateTemporaryDirectory();
      const rawPath = await writePrivateRaw(
        directory,
        `dynamic-id-key-${index}.json`,
        JSON.stringify({
          [value.mapField]: { [String(value.id)]: true },
          [value.idField]: value.id,
        }),
      );
      const outputPath = path.join(
        directory,
        `dynamic-id-key-${index}.out.json`,
      );
      const result = await invoke(["--input", rawPath, "--output", outputPath]);
      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr: "grok_evidence_sanitization_failed\n",
      });
      await expect(lstat(rawPath)).resolves.toBeDefined();
      await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects malformed UTF-8 instead of canonicalizing replacement characters", async () => {
    const directory = await privateTemporaryDirectory();
    const rawPath = path.join(directory, "invalid-utf8.json");
    await writeFile(
      rawPath,
      Buffer.concat([
        Buffer.from('{"value":"'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('"}'),
      ]),
      { mode: 0o600 },
    );
    await chmod(rawPath, 0o600);
    const outputPath = path.join(directory, "invalid-utf8.out.json");

    const result = await invoke(["--input", rawPath, "--output", outputPath]);

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "grok_evidence_sanitization_failed\n",
    });
    await expect(lstat(rawPath)).resolves.toBeDefined();
    await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("produces the same hash when equal-length host and account options are reversed", async () => {
    const hashes: string[] = [];
    const outputs: string[] = [];
    for (const reverse of [false, true]) {
      const directory = await privateTemporaryDirectory();
      const rawPath = await writePrivateRaw(
        directory,
        "ordered-options.json",
        JSON.stringify({
          account: "account-alpha",
          host: "host-a.example",
          otherAccount: "account-bravo",
          otherHost: "host-b.example",
        }),
      );
      const outputPath = path.join(directory, "ordered-options.out.json");
      const hostArguments = ["host-a.example", "host-b.example"];
      const accountArguments = ["account-alpha", "account-bravo"];
      if (reverse) {
        hostArguments.reverse();
        accountArguments.reverse();
      }
      const result = await invoke([
        "--input",
        rawPath,
        "--output",
        outputPath,
        ...hostArguments.flatMap((host) => ["--host", host]),
        ...accountArguments.flatMap((account) => ["--account", account]),
      ]);
      expect(result).toMatchObject({ code: 0, stderr: "" });
      outputs.push(await readFile(outputPath, "utf8"));
      hashes.push(
        (JSON.parse(result.stdout) as { outputSha256: string }).outputSha256,
      );
    }
    expect(outputs[0]).toBe(outputs[1]);
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("does not accept a real secret value through a CLI argument", async () => {
    const directory = await privateTemporaryDirectory();
    const rawPath = await writePrivateRaw(
      directory,
      "raw.json",
      JSON.stringify({ safe: true }),
    );
    const outputPath = path.join(directory, "out.json");
    const result = await invoke([
      "--input",
      rawPath,
      "--output",
      outputPath,
      "--secret",
      SECRET,
    ]);
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "grok_evidence_sanitization_failed\n",
    });
    expect(result.stderr).not.toContain(SECRET);
    await expect(lstat(rawPath)).resolves.toBeDefined();
  });

  it("removes a malicious raw filename and exposes no canary through output, errors, or remaining filenames", async () => {
    const directory = await privateTemporaryDirectory();
    const rawPath = await writePrivateRaw(
      directory,
      `${SECRET}-raw.json`,
      JSON.stringify({ filename: `${SECRET}-provider.log`, value: SECRET }),
    );
    const outputPath = path.join(directory, "sanitized.json");

    const result = await invoke([
      "--input",
      rawPath,
      "--output",
      outputPath,
      "--secret-canary",
      SECRET,
    ]);

    expect(result.code).toBe(0);
    const output = await readFile(outputPath, "utf8");
    expect(`${result.stdout}${result.stderr}${output}`).not.toContain(SECRET);
    expect(await readdir(directory)).toEqual(["sanitized.json"]);
  });

  it("returns only a fixed error and retains raw input when a canary occurs in a property name or output filename", async () => {
    for (const unsafeOutputName of [false, true]) {
      const directory = await privateTemporaryDirectory();
      const rawPath = await writePrivateRaw(
        directory,
        "raw.json",
        JSON.stringify(
          unsafeOutputName
            ? { safe: true }
            : { [`field-${SECRET}`]: "malicious" },
        ),
      );
      const outputPath = path.join(
        directory,
        unsafeOutputName ? `${SECRET}-sanitized.json` : "sanitized.json",
      );

      const result = await invoke([
        "--input",
        rawPath,
        "--output",
        outputPath,
        "--secret-canary",
        SECRET,
      ]);

      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr: "grok_evidence_sanitization_failed\n",
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
      await expect(lstat(rawPath)).resolves.toMatchObject({ mode: 0o100600 });
      await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects raw-frame fields, excessive nesting, collections, and strings without partial output", async () => {
    const excessiveDepth = Array.from({ length: 34 }).reduce<unknown>(
      (value) => ({ child: value }),
      true,
    );
    const cases: readonly unknown[] = [
      { rawFrame: `wire-${SECRET}` },
      { jsonrpc: "2.0", method: "session/update", params: { safe: true } },
      excessiveDepth,
      Array.from({ length: 20_001 }, () => null),
      Array.from({ length: 11 }, () =>
        Array.from({ length: 10_000 }, () => null),
      ),
      { value: "x".repeat(512 * 1024 + 1) },
      { value: "x".repeat(8 * 1024 * 1024) },
    ];

    for (const [index, value] of cases.entries()) {
      const directory = await privateTemporaryDirectory();
      const rawPath = await writePrivateRaw(
        directory,
        `raw-${index}.json`,
        JSON.stringify(value),
      );
      const outputPath = path.join(directory, `sanitized-${index}.json`);
      const result = await invoke([
        "--input",
        rawPath,
        "--output",
        outputPath,
        "--secret-canary",
        SECRET,
      ]);

      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr: "grok_evidence_sanitization_failed\n",
      });
      await expect(lstat(rawPath)).resolves.toBeDefined();
      await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects symlinked, non-regular, and permission-unsafe raw sources", async () => {
    const directory = await privateTemporaryDirectory();
    const target = await writePrivateRaw(
      directory,
      "target.json",
      JSON.stringify({ safe: true }),
    );
    const linked = path.join(directory, "linked.json");
    await symlink(target, linked);
    const unsafeMode = await writePrivateRaw(
      directory,
      "unsafe-mode.json",
      JSON.stringify({ safe: true }),
    );
    await chmod(unsafeMode, 0o644);

    const socketPath = path.join(
      os.homedir(),
      `.grok-sanitizer-${process.pid}-${path.basename(directory).slice(-6)}.sock`,
    );
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      for (const [index, rawPath] of [
        linked,
        directory,
        unsafeMode,
        socketPath,
      ].entries()) {
        const outputPath = path.join(directory, `rejected-${index}.json`);
        const result = await invoke([
          "--input",
          rawPath,
          "--output",
          outputPath,
        ]);
        expect(result).toEqual({
          code: 1,
          stdout: "",
          stderr: "grok_evidence_sanitization_failed\n",
        });
        await expect(lstat(outputPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketPath, { force: true });
    }
  });

  it("rejects multiply-linked raw evidence so cleanup is provable", async () => {
    const directory = await privateTemporaryDirectory();
    const rawPath = await writePrivateRaw(
      directory,
      "raw.json",
      JSON.stringify({ safe: true }),
    );
    const aliasPath = path.join(directory, "raw-alias.json");
    await link(rawPath, aliasPath);
    const outputPath = path.join(directory, "sanitized.json");

    const result = await invoke(["--input", rawPath, "--output", outputPath]);

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "grok_evidence_sanitization_failed\n",
    });
    await expect(lstat(rawPath)).resolves.toBeDefined();
    await expect(lstat(aliasPath)).resolves.toBeDefined();
    await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
