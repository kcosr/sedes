import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const outputPath = path.join(
  repositoryRoot,
  "protocol/grok-acp/1.0.4/source-route-candidates.json",
);
const mechanicsOutputPath = path.join(
  repositoryRoot,
  "protocol/grok-acp/1.0.4/source-image-mechanics.json",
);
const historyMechanicsOutputPath = path.join(
  repositoryRoot,
  "protocol/grok-acp/1.0.4/source-history-mechanics.json",
);
const sourceRepo =
  process.env.GROK_SOURCE_REPO ?? path.resolve(repositoryRoot, "../grok-build");

const revisions = [
  {
    role: "current-source-evidence",
    releaseDeclaration: "1.0.4",
    commit: "5163763e703c319e4554c2f455535c5adb6e51e8",
    sourceRevision: "84ae1223e57a5048afb570d74d45c051fa604982",
  },
  {
    role: "prior-source-evidence",
    releaseDeclaration: "1.0.4",
    commit: "d6a22a1aed70b58d30a0f82a1a2a76ce1301631e",
    sourceRevision: "7140ec21cc4ec809131b0fa774f4b81d61667084",
  },
];

const imageMechanics = [
  {
    id: "standard_acp_image_content_ingest",
    path: "crates/codegen/xai-grok-shell/src/session/prompt_parser.rs",
    needle:
      "acp::ContentBlock::Image(image_content) => image_parts.push(image_content.clone()),",
  },
  {
    id: "standard_acp_resource_link_ingest",
    path: "crates/codegen/xai-grok-shell/src/session/prompt_parser.rs",
    needle: "acp::ContentBlock::ResourceLink(link) => {",
  },
  {
    id: "meta_free_resource_link_path_projection",
    path: "crates/codegen/xai-grok-shell/src/session/prompt_parser.rs",
    needle: "if link.meta.is_none() {",
  },
  {
    id: "canonical_base64_image_bytes",
    path: "crates/codegen/xai-grok-shell/src/session/image_describe.rs",
    needle: ".decode(&img.data)",
  },
  {
    id: "model_explicit_image_boolean_precedence",
    path: "crates/codegen/xai-grok-pager/src/acp/model_state.rs",
    needle:
      'if let Some(accepts) = meta.get("acceptsImages").and_then(|v| v.as_bool()) {',
  },
  {
    id: "model_input_modalities_negative_evidence",
    path: "crates/codegen/xai-grok-pager/src/acp/model_state.rs",
    needle:
      'if let Some(modalities) = meta.get("inputModalities").and_then(|v| v.as_array()) {',
  },
];

const historyMechanics = [
  {
    id: "session_updates_stream_request",
    path: "crates/codegen/xai-grok-shell/src/extensions/session_updates.rs",
    needle: "stream: bool,",
  },
  {
    id: "session_updates_chunk_size_request",
    path: "crates/codegen/xai-grok-shell/src/extensions/session_updates.rs",
    needle: "chunk_size: Option<usize>,",
  },
  {
    id: "session_updates_chunks_before_response",
    path: "crates/codegen/xai-grok-shell/src/extensions/session_updates.rs",
    needle:
      "send_streamed_chunks(\n                gateway,\n                &request.session_id,\n                &tail_page.lines,\n                chunk_size,\n                &target_client_id,\n            );\n            return streamed_metadata_response(",
  },
  {
    id: "session_update_timestamp_default",
    path: "crates/codegen/xai-grok-shell/src/session/storage/mod.rs",
    needle: "#[serde(default)]\n    pub timestamp: u64,",
  },
  {
    id: "session_load_no_replay_meta",
    path: "crates/codegen/xai-grok-shell/src/agent/mvp_agent/mod.rs",
    needle:
      'meta.and_then(|m| m.get("noReplay")).and_then(|v| v.as_bool()).unwrap_or(false)',
  },
  {
    id: "session_load_no_replay_policy",
    path: "crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs",
    needle: "no_replay: parse_no_replay(meta),",
  },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(args, options = {}) {
  return execFileSync("git", ["-C", sourceRepo, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

function extractRevision(revision) {
  const sourceRevision = git(["show", `${revision.commit}:SOURCE_REV`]).trim();
  if (sourceRevision !== revision.sourceRevision) {
    throw new Error(`Unexpected SOURCE_REV for ${revision.commit}.`);
  }
  const versionToml = git([
    "show",
    `${revision.commit}:crates/codegen/xai-grok-version/Cargo.toml`,
  ]);
  if (!versionToml.includes(`version = "${revision.releaseDeclaration}"`)) {
    throw new Error(`Unexpected release declaration for ${revision.commit}.`);
  }
  const lines = git([
    "grep",
    "-n",
    "-I",
    "-E",
    "_?x\\.ai/",
    revision.commit,
    "--",
    "*.rs",
    "*.toml",
    "*.json",
  ]).split("\n");
  const routes = new Map();
  for (const line of lines) {
    const match = /^.*?:([^:]+):(\d+):(.*)$/u.exec(line);
    if (!match) continue;
    const [, sourcePath, lineNumber, content] = match;
    for (const routeMatch of content.matchAll(/_?x\.ai\/[A-Za-z0-9_.\/-]+/gu)) {
      const route = routeMatch[0].replace(/[./-]+$/u, "");
      if (!route.includes("/")) continue;
      const entry = routes.get(route) ?? {
        route,
        occurrenceCount: 0,
        locations: [],
      };
      entry.occurrenceCount += 1;
      if (entry.locations.length < 8) {
        entry.locations.push(`${sourcePath}:${lineNumber}`);
      }
      routes.set(route, entry);
    }
  }
  return {
    ...revision,
    claim:
      "source-observed candidate only; not exact-binary or runtime support evidence",
    routeCount: routes.size,
    routes: [...routes.values()].sort((left, right) =>
      left.route.localeCompare(right.route),
    ),
  };
}

export function buildSourceRouteCandidates() {
  git(["rev-parse", "--is-inside-work-tree"]);
  return {
    schemaVersion: 1,
    extraction: {
      command: "npm run extract:grok-source-routes",
      extractor: "scripts/grok-probes/extract-grok-source-routes.mjs",
      sourceLocator: "GROK_SOURCE_REPO or sibling ../grok-build checkout",
      match: "literal _?x.ai/* candidates in tracked Rust/TOML/JSON source",
      limitations: [
        "candidate strings can include comments, tests, UI clients, URLs, or inactive routes",
        "direction, schema, capability negotiation, and runtime availability are not inferred",
        "neither public source revision is asserted to match candidate binary d846eb93d9",
      ],
    },
    revisions: revisions.map(extractRevision),
  };
}

export function buildSourceImageMechanics() {
  const revision = revisions[0];
  const sourceRevision = git(["show", `${revision.commit}:SOURCE_REV`]).trim();
  if (sourceRevision !== revision.sourceRevision) {
    throw new Error(`Unexpected SOURCE_REV for ${revision.commit}.`);
  }
  return {
    schemaVersion: 1,
    extraction: {
      command: "npm run extract:grok-source-routes",
      extractor: "scripts/grok-probes/extract-grok-source-routes.mjs",
      sourceLocator: "GROK_SOURCE_REPO or sibling ../grok-build checkout",
      claim:
        "reviewed stable-1.x profile evidence from the 1.0.4-declaring source; not exact-binary proof",
    },
    revision: {
      releaseDeclaration: revision.releaseDeclaration,
      commit: revision.commit,
      sourceRevision,
    },
    mechanics: imageMechanics.map((mechanic) => {
      const source = git(["show", `${revision.commit}:${mechanic.path}`]);
      if (!source.includes(mechanic.needle)) {
        throw new Error(
          `Missing ${mechanic.id} source evidence at ${mechanic.path}.`,
        );
      }
      const line = source
        .slice(0, source.indexOf(mechanic.needle))
        .split("\n").length;
      return {
        id: mechanic.id,
        path: mechanic.path,
        line,
        evidenceSha256: sha256(mechanic.needle),
      };
    }),
  };
}

export function buildSourceHistoryMechanics() {
  const revision = revisions[0];
  const sourceRevision = git(["show", `${revision.commit}:SOURCE_REV`]).trim();
  if (sourceRevision !== revision.sourceRevision) {
    throw new Error(`Unexpected SOURCE_REV for ${revision.commit}.`);
  }
  return {
    schemaVersion: 1,
    extraction: {
      command: "npm run extract:grok-source-routes",
      extractor: "scripts/grok-probes/extract-grok-source-routes.mjs",
      sourceLocator: "GROK_SOURCE_REPO or sibling ../grok-build checkout",
      claim:
        "reviewed stable-1.x profile evidence from the 1.0.4-declaring source; not exact-binary proof",
    },
    revision: {
      releaseDeclaration: revision.releaseDeclaration,
      commit: revision.commit,
      sourceRevision,
    },
    mechanics: historyMechanics.map((mechanic) => {
      const source = git(["show", `${revision.commit}:${mechanic.path}`]);
      if (!source.includes(mechanic.needle)) {
        throw new Error(
          `Missing ${mechanic.id} source evidence at ${mechanic.path}.`,
        );
      }
      const line = source
        .slice(0, source.indexOf(mechanic.needle))
        .split("\n").length;
      return {
        id: mechanic.id,
        path: mechanic.path,
        line,
        evidenceSha256: sha256(mechanic.needle),
      };
    }),
  };
}

const result = buildSourceRouteCandidates();
const canonical = `${JSON.stringify(result, null, 2)}\n`;
const mechanics = `${JSON.stringify(buildSourceImageMechanics(), null, 2)}\n`;
const historyMechanicsCanonical = `${JSON.stringify(buildSourceHistoryMechanics(), null, 2)}\n`;
if (process.argv.includes("--print-mechanics")) {
  process.stdout.write(mechanics);
  process.exit(0);
}
if (process.argv.includes("--check")) {
  if (readFileSync(outputPath, "utf8") !== canonical) {
    throw new Error("Grok source route candidates have drifted.");
  }
  if (readFileSync(mechanicsOutputPath, "utf8") !== mechanics) {
    throw new Error("Grok source image mechanics have drifted.");
  }
  if (
    readFileSync(historyMechanicsOutputPath, "utf8") !==
    historyMechanicsCanonical
  ) {
    throw new Error("Grok source history mechanics have drifted.");
  }
} else {
  writeFileSync(outputPath, canonical);
  writeFileSync(mechanicsOutputPath, mechanics);
  writeFileSync(historyMechanicsOutputPath, historyMechanicsCanonical);
}
