import type { FormField, FormInfo, PermissionRequest } from "@opencode/client";
import { describe, expect, it, vi } from "vitest";
import { mapOpenCodeForm, mapOpenCodePermission, resolveOpenCodeInteractionResponse, OpenCodeInteractionMappingError,
  type OpenCodeInteractionAuthority, type OpenCodeInteractionMapResult } from "../../src/server/backends/opencode/opencode-interaction-mapper.js";

const authority: OpenCodeInteractionAuthority = { tenantId: "tenant", principalId: "principal", applicationThreadId: "thread",
  backendInstanceId: "opencode", sessionID: "ses_owned", generation: "runtime-binding-generation" };
const openedAt = "2026-09-27T13:00:00.000Z";
const permission: PermissionRequest = { id: "per_native", sessionID: authority.sessionID, action: "write", resources: ["/workspace/file"], message: "Needs permission" };
const form = (fields: FormField[], overrides: Partial<FormInfo> = {}): FormInfo => ({ id: "frm_native", sessionID: authority.sessionID, title: "Native form", fields: fields as FormInfo["fields"], ...overrides });
function mapped(result: OpenCodeInteractionMapResult): Extract<OpenCodeInteractionMapResult, { status: "mapped" }> {
  if (result.status !== "mapped") throw new Error(`Expected mapped result, got ${result.status}`); return result;
}
function resolve(result: Extract<OpenCodeInteractionMapResult, { status: "mapped" }>, response: Record<string, unknown>, owner = authority) {
  return resolveOpenCodeInteractionResponse({ mapping: result.mapping, authority: owner, requestFingerprint: result.requestFingerprint,
    response: { applicationOperationId: "operation", interactionId: result.interaction.backendInteractionId, ...response } });
}
const customQuestion = (key = "q"): FormField => ({ type: "string", key, title: "Choose", description: "Which option?", custom: true,
  options: [{ label: "Readable label", value: "native-value", description: "Explanation" }, { label: "Second", value: "native-second" }] });

describe("OpenCode pure permission mapping", () => {
  it("truthfully describes native reject-cascade and exposes only once/reject", () => {
    const result = mapped(mapOpenCodePermission({ request: permission, authority, openedAt }));
    expect(result.interaction).toMatchObject({ kind: "decision", destructive: true, cancellable: false, openedAt });
    if (result.interaction.kind !== "decision") throw new Error("decision");
    expect(result.interaction.message?.text).toContain("rejects every other pending permission");
    expect(result.interaction.actions.map(action => action.backendActionId)).toEqual(["allow_once", "deny_and_stop"]);
    expect(resolve(result, { kind: "decision", selectedActionId: "allow_once" })).toEqual({ kind: "permission_reply",
      input: { sessionID: "ses_owned", requestID: "per_native", decision: "once" } });
    expect(resolve(result, { kind: "decision", selectedActionId: "deny_and_stop" })).toEqual({ kind: "permission_reply",
      input: { sessionID: "ses_owned", requestID: "per_native", decision: "reject" } });
    expect(() => resolve(result, { kind: "decision", selectedActionId: "always" })).toThrow("opencode_interaction_invalid_response");
  });
  it("rejects automatic cancellation with a bounded notice and no alternate native effect", () => {
    const result = mapped(mapOpenCodePermission({ request: permission, authority, openedAt }));
    try { resolve(result, { kind: "cancel" }); throw new Error("expected unsupported"); }
    catch (error) { expect(error).toBeInstanceOf(OpenCodeInteractionMappingError); expect(error).toMatchObject({ code: "permission_cancel_unsupported",
      notice: { text: expect.stringContaining("remains pending") } }); }
  });
  it("bounds display data and keeps native request identity out of the interaction", () => {
    const result = mapped(mapOpenCodePermission({ request: { ...permission, resources: ["a".repeat(100_000)] }, authority, openedAt }));
    expect(JSON.stringify(result.interaction)).not.toContain(permission.id);
    expect(JSON.stringify(result.interaction)).not.toContain(authority.sessionID);
    expect(JSON.stringify(result.interaction).length).toBeLessThan(100_000);
    expect(Object.isFrozen(result.interaction)).toBe(true);
  });
});

describe("OpenCode pure general form mapping", () => {
  it("maps expressible fields with native-value translation, defaults and required bounds", () => {
    const request = form([
      { key: "name", type: "string", title: "Name", required: true, minLength: 2, maxLength: 10, default: "Ada" },
      { key: "count", type: "integer", minimum: 1, maximum: 8, default: 2 },
      { key: "factor", type: "number", minimum: 0, maximum: 1 },
      { key: "enabled", type: "boolean", required: true, default: false },
      { key: "mode", type: "string", options: [{ value: "native-fast", label: "Fast" }], default: "native-fast" },
      { key: "features", type: "multiselect", required: true, minItems: 1, maxItems: 2,
        options: [{ value: "native-a", label: "A" }, { value: "native-b", label: "B" }], default: ["native-b"] },
    ]);
    const result = mapped(mapOpenCodeForm({ request, authority, openedAt }));
    if (result.interaction.kind !== "form") throw new Error("form");
    expect(result.interaction.fields[0]).toMatchObject({ required: true, input: { kind: "text", minLength: 2, maxLength: 10, default: "Ada" } });
    expect(result.interaction.fields[4]).toMatchObject({ input: { kind: "single_choice", default: "option_4_0" } });
    const response = resolve(result, { kind: "form", answers: [
      { fieldId: "field_0", value: "Kevin" }, { fieldId: "field_1", value: 3 }, { fieldId: "field_2", value: 0.25 },
      { fieldId: "field_3", value: false }, { fieldId: "field_4", value: "option_4_0" }, { fieldId: "field_5", value: ["option_5_1"] },
    ] });
    expect(response).toEqual({ kind: "form_reply", input: { sessionID: "ses_owned", formID: "frm_native", answer: {
      name: "Kevin", count: 3, factor: 0.25, enabled: false, mode: "native-fast", features: ["native-b"],
    } } });
    expect(Object.isFrozen(response)).toBe(true); expect(Object.isFrozen(response.input)).toBe(true);
  });
  it("cancels only the exact mapped native form", () => {
    const result = mapped(mapOpenCodeForm({ request: form([{ key: "x", type: "string" }]), authority, openedAt }));
    expect(resolve(result, { kind: "cancel" })).toEqual({ kind: "form_cancel", input: { sessionID: "ses_owned", formID: "frm_native" } });
  });
  it("revalidates native UTF-16 bounds when normalized code-point bounds accept an answer", () => {
    const result = mapped(mapOpenCodeForm({ request: form([{ key: "x", type: "string", maxLength: 1 }]), authority, openedAt }));
    expect(() => resolve(result, { kind: "form", answers: [{ fieldId: "field_0", value: "😀" }] })).toThrow("opencode_interaction_invalid_response");
    expect(resolve(result, { kind: "form", answers: [{ fieldId: "field_0", value: "a" }] })).toMatchObject({ input: { answer: { x: "a" } } });
  });
  it.each([
    { key: "x", type: "string", required: true },
    { key: "x", type: "multiselect", required: true, options: [{ value: "a", label: "A" }] },
  ] as FormField[])("rejects empty required native values", field => {
    const result = mapped(mapOpenCodeForm({ request: form([field]), authority, openedAt }));
    expect(() => resolve(result, { kind: "form", answers: [] })).toThrow("opencode_interaction_invalid_response");
    expect(() => resolve(result, { kind: "form", answers: [{ fieldId: "field_0", value: field.type === "string" ? "" : [] }] })).toThrow("opencode_interaction_invalid_response");
  });
  it.each([
    { key: "x", type: "external", url: "https://example.test" }, { key: "x", type: "string", hidden: true },
    { key: "x", type: "string", pattern: ".*" }, { key: "x", type: "string", when: [] },
    { key: "x", type: "multiselect", custom: true, options: [{ value: "a", label: "A" }] },
    { key: "x", type: "number", minimum: 4, maximum: 2 }, { key: "x", type: "integer", default: 1.5 },
    { key: "x", type: "string", options: [{ value: "a", label: "A" }, { value: "a", label: "Also A" }] },
    { key: "x", type: "string", options: [] }, { key: "x", type: "string", options: [{ value: "a", label: "A" }], default: "not-an-option" },
  ] as FormField[])("returns an exact cancellation requirement for unsupported fields: %j", field => {
    const result = mapOpenCodeForm({ request: form([field]), authority, openedAt });
    expect(result).toMatchObject({ status: "unsupported", cancel: { sessionID: "ses_owned", formID: "frm_native" }, notice: { text: expect.any(String) } });
  });
  it("supports closed options whose string constraints are redundant and rejects invalid offered values", () => {
    const valid = form([{ key: "x", type: "string", minLength: 2, options: [{ value: "ab", label: "AB" }] }]);
    expect(mapOpenCodeForm({ request: valid, authority, openedAt }).status).toBe("mapped");
    const invalid = form([{ key: "x", type: "string", minLength: 2, options: [{ value: "a", label: "A" }] }]);
    expect(mapOpenCodeForm({ request: invalid, authority, openedAt }).status).toBe("unsupported");
  });
  it("rejects unknown fields, wrong types, duplicate answers and invalid options before response mapping", () => {
    const result = mapped(mapOpenCodeForm({ request: form([{ key: "x", type: "integer", minimum: 1, maximum: 3 }]), authority, openedAt }));
    for (const answers of [[{ fieldId: "unknown", value: 1 }], [{ fieldId: "field_0", value: 1.5 }], [{ fieldId: "field_0", value: 4 }],
      [{ fieldId: "field_0", value: "1" }], [{ fieldId: "field_0", value: 1 }, { fieldId: "field_0", value: 2 }]]) {
      expect(() => resolve(result, { kind: "form", answers })).toThrow("opencode_interaction_invalid_response");
    }
  });
  it("preserves opaque native field keys safely, including prototype-looking keys", () => {
    const result = mapped(mapOpenCodeForm({ request: form([{ key: "__proto__", type: "string" }]), authority, openedAt }));
    const response = resolve(result, { kind: "form", answers: [{ fieldId: "field_0", value: "literal" }] });
    if (response.kind !== "form_reply") throw new Error("form reply");
    expect(Object.getPrototypeOf(response.input.answer)).toBeNull();
    expect(Object.hasOwn(response.input.answer, "__proto__")).toBe(true);
    expect(response.input.answer.__proto__).toBe("literal");
  });
});

describe("OpenCode native custom single-choice questionnaire mapping", () => {
  it("preserves native values separately from labels and implements note, Other and unanswered", () => {
    const result = mapped(mapOpenCodeForm({ request: form([customQuestion("first"), customQuestion("second"), customQuestion("third")]), authority, openedAt }));
    expect(result.interaction).toMatchObject({ kind: "questionnaire", cancellable: true, questions: [{ input: { allowNote: true } }, {}, {}] });
    expect(resolve(result, { kind: "questionnaire", answers: [
      { questionId: "question_0", answer: { kind: "single_choice", selectedOptionId: "option_0_0", note: "because" } },
      { questionId: "question_1", answer: { kind: "single_choice", selectedOptionId: "other_1", note: "custom response" } },
      { questionId: "question_2", answer: { kind: "unanswered" } },
    ] })).toMatchObject({ kind: "form_reply", input: { answer: { first: "native-value: because", second: "custom response" } } });
    const empty = resolve(result, { kind: "questionnaire", answers: [0, 1, 2].map(index => ({ questionId: `question_${index}`, answer: { kind: "unanswered" } })) });
    expect(empty).toMatchObject({ input: { answer: {} } });
  });
  it("requires exactly the request's question and option identities", () => {
    const result = mapped(mapOpenCodeForm({ request: form([customQuestion()]), authority, openedAt }));
    for (const answer of [{ kind: "text", value: "surrogate" }, { kind: "single_choice", selectedOptionId: "unknown" },
      { kind: "single_choice", selectedOptionId: "other_0", note: " " }]) {
      expect(() => resolve(result, { kind: "questionnaire", answers: [{ questionId: "question_0", answer }] })).toThrow("opencode_interaction_invalid_response");
    }
    expect(() => resolve(result, { kind: "questionnaire", answers: [{ questionId: "wrong", answer: { kind: "unanswered" } }] })).toThrow("opencode_interaction_invalid_response");
    expect(() => resolve(result, { kind: "questionnaire", answers: [] })).toThrow("opencode_interaction_invalid_response");
  });
  it("rejects custom required/default/constrained questions and forms beyond questionnaire limits", () => {
    for (const change of [{ required: true }, { default: "native-value" }, { maxLength: 30 }, { format: "email" }]) {
      expect(mapOpenCodeForm({ request: form([{ ...customQuestion(), ...change } as FormField]), authority, openedAt }).status).toBe("unsupported");
    }
    expect(mapOpenCodeForm({ request: form(Array.from({ length: 4 }, (_, index) => customQuestion(`q${index}`))), authority, openedAt }).status).toBe("unsupported");
    const options = Array.from({ length: 9 }, (_, index) => ({ value: `${index}`, label: `${index}` }));
    expect(mapOpenCodeForm({ request: form([{ ...customQuestion(), options } as FormField]), authority, openedAt }).status).toBe("unsupported");
  });
});

describe("OpenCode interaction authority and immutable input", () => {
  it("never assigns or cancels another session's or global form", () => {
    for (const sessionID of ["global", "ses_foreign"]) {
      const result = mapOpenCodeForm({ request: form([{ key: "x", type: "external", url: "https://example.test" }], { sessionID }), authority, openedAt });
      expect(result.status).toBe("unowned"); expect(result).not.toHaveProperty("cancel");
    }
    expect(mapOpenCodePermission({ request: { ...permission, sessionID: "ses_foreign" }, authority, openedAt }).status).toBe("unowned");
  });
  it("fences every scope coordinate, generation, request fingerprint and interaction identity", () => {
    const result = mapped(mapOpenCodePermission({ request: permission, authority, openedAt }));
    for (const key of Object.keys(authority) as Array<keyof OpenCodeInteractionAuthority>) {
      const changed = { ...authority, [key]: key === "sessionID" ? "ses_other" : "other" };
      expect(() => resolve(result, { kind: "decision", selectedActionId: "allow_once" }, changed)).toThrow("opencode_interaction_stale");
    }
    expect(() => resolve(result, { kind: "decision", interactionId: "wrong", selectedActionId: "allow_once" })).toThrow("opencode_interaction_stale");
    expect(() => resolveOpenCodeInteractionResponse({ mapping: result.mapping, authority, requestFingerprint: "changed", response: {} })).toThrow("opencode_interaction_stale");
    const changed = mapped(mapOpenCodePermission({ request: { ...permission, resources: ["/different"] }, authority, openedAt }));
    expect(changed.requestFingerprint).not.toBe(result.requestFingerprint);
    expect(changed.interaction.backendInteractionId).not.toBe(result.interaction.backendInteractionId);
  });
  it("retains native value mapping after the caller mutates the original request", () => {
    const request = form([{ key: "original", type: "string", options: [{ value: "native-original", label: "Original" }] }]);
    const result = mapped(mapOpenCodeForm({ request, authority, openedAt }));
    request.fields[0]!.key = "changed";
    expect(resolve(result, { kind: "form", answers: [{ fieldId: "field_0", value: "option_0_0" }] })).toMatchObject({ input: { answer: { original: "native-original" } } });
  });
  it("rejects getters and wrong response kinds without invoking input code", () => {
    const result = mapped(mapOpenCodePermission({ request: permission, authority, openedAt }));
    const getter = vi.fn(); const response = { kind: "decision" };
    Object.defineProperty(response, "selectedActionId", { enumerable: true, get: getter });
    expect(() => resolveOpenCodeInteractionResponse({ mapping: result.mapping, authority, requestFingerprint: result.requestFingerprint, response })).toThrow("opencode_interaction_invalid_response");
    expect(getter).not.toHaveBeenCalled();
    expect(() => resolve(result, { kind: "confirmation", confirmed: true })).toThrow("opencode_interaction_invalid_response");
  });
  it("rejects request identities that the exact native mutation facade cannot address", () => {
    expect(() => mapOpenCodePermission({ request: { ...permission, id: "per_wrong/path" }, authority, openedAt })).toThrow("opencode_interaction_invalid_request");
    expect(() => mapOpenCodeForm({ request: form([{ key: "x", type: "string" }], { id: `frm_${"x".repeat(300)}` }), authority, openedAt })).toThrow("opencode_interaction_invalid_request");
  });
});
