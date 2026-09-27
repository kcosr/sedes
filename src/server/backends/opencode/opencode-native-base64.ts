import { Schema, SchemaAST } from "effect";
import { Base64 } from "@opencode/schema/prompt";
import { isDeepStrictEqual } from "node:util";

const expectedPattern = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";
const officialBase64Check = Base64.ast.checks?.[0];
if (Base64.ast._tag !== "String" || Base64.ast.checks?.length !== 1 || officialBase64Check?._tag !== "Filter" ||
    !isDeepStrictEqual(officialBase64Check.annotations?.representation,
      { id: "effect/schema/isPattern", payload: { source: expectedPattern, flags: "" } })) {
  throw new Error("opencode_base64_schema_changed");
}

/** Same lexical language as the pinned Prompt.Base64 refinement, without its
 * nested-regexp V8 stack overflow on multi-megabyte provider image payloads. */
export function validOpenCodeBase64(value: string): boolean {
  if (value.length % 4) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  for (let index = 0; index < value.length - padding; index++) {
    const code = value.charCodeAt(index);
    if (!(code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 || code === 43 || code === 47)) return false;
  }
  return true;
}
const base64Check = Schema.makeFilter<string>(validOpenCodeBase64);

/** Derive the wire validator from official schemas, replacing only their
 * identified Base64 predicate. All shapes, excess-property handling, optional
 * fields, discriminators, annotations and other constraints remain official.
 */
export function openCodeStackSafeEncodedSchema(schema: Schema.Constraint, json: boolean): Schema.Codec<unknown> {
  const encoded = Schema.toEncoded(json ? Schema.toCodecJson(schema) : schema);
  const seen = new WeakMap<SchemaAST.AST, SchemaAST.AST>();
  const visit = (ast: SchemaAST.AST): SchemaAST.AST => {
    const previous = seen.get(ast); if (previous) return previous;
    let result: SchemaAST.AST = ast;
    if (ast._tag === "String" && SchemaAST.resolveIdentifier(ast) === "Prompt.Base64") {
      // The encoded official nodes retain this exact filter reference. An
      // added, replaced or ambiguous constraint is a protocol incompatibility,
      // never permission to erase it while avoiding the regexp stack issue.
      if (ast.checks?.length !== 1 || ast.checks[0] !== officialBase64Check) throw new Error("opencode_base64_schema_changed");
      result = new SchemaAST.String(ast.annotations, [base64Check], ast.encoding, ast.context);
    } else if (ast._tag === "Objects") {
      result = new SchemaAST.Objects(ast.propertySignatures.map(property => new SchemaAST.PropertySignature(property.name, visit(property.type))),
        ast.indexSignatures.map(index => new SchemaAST.IndexSignature(index.parameter, visit(index.type))),
        ast.annotations, ast.checks, ast.encoding, ast.context, ast.encodingChecks);
    } else if (ast._tag === "Arrays") {
      result = new SchemaAST.Arrays(ast.isMutable, ast.elements.map(visit), ast.rest.map(visit),
        ast.annotations, ast.checks, ast.encoding, ast.context, ast.encodingChecks);
    } else if (ast._tag === "Union") {
      result = new SchemaAST.Union(ast.types.map(visit), ast.mode, ast.annotations, ast.checks, ast.encoding, ast.context, ast.encodingChecks);
    } else if (ast._tag === "Suspend") {
      result = new SchemaAST.Suspend(() => visit(ast.thunk()), ast.annotations, ast.checks, ast.encoding, ast.context);
    }
    seen.set(ast, result); return result;
  };
  return Schema.make<Schema.Codec<unknown>>(visit(encoded.ast));
}
