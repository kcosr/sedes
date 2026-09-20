import { describe, expect, it } from "vitest";
import { normalizeCodexElicitationForm } from "../../src/server/backends/codex/codex-elicitation-form.js";
import { decodeCodexServerRequestParams } from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";

function normalize(properties: object, required: string[] = []) {
  const params = decodeCodexServerRequestParams(
    "mcpServer/elicitation/request",
    {
      mode: "form",
      threadId: "thread",
      turnId: null,
      serverName: "test",
      _meta: null,
      message: "Fill in",
      requestedSchema: { type: "object", properties, required },
    },
  );
  if (params.mode !== "form") throw new Error("form expected");
  return normalizeCodexElicitationForm(params.requestedSchema);
}
describe("Codex normalized MCP forms", () => {
  it("uses meaningful labels for blank native titles while preserving exact enum values", () => {
    const form = normalize({
      count: { type: "integer", title: "  " },
      choice: {
        type: "string",
        title: "",
        enum: ["alpha", "", "  "],
        enumNames: ["", " ", ""],
      },
      titled: { type: "string", oneOf: [{ const: "east", title: " " }] },
      multi: {
        type: "array",
        items: { anyOf: [{ const: "west", title: "" }] },
      },
      named: { type: "string", title: "  User name  " },
    });
    expect(form.fields.map((field) => field.label.text)).toEqual([
      "count",
      "choice",
      "titled",
      "multi",
      "User name",
    ]);
    const choice = form.fields[1]!.input;
    if (choice.kind !== "single_choice") throw new Error("choice expected");
    expect(choice.options.map((option) => option.label.text)).toEqual([
      "alpha",
      "Empty value",
      'Whitespace value: "  "',
    ]);
    expect(form.fields[2]!.input).toMatchObject({
      options: [{ label: { text: "east" } }],
    });
    expect(form.fields[3]!.input).toMatchObject({
      options: [{ label: { text: "west" } }],
    });
    expect(
      form.content([{ fieldId: "field:1", value: choice.options[1]!.id }]),
    ).toEqual({ choice: "" });
    expect(
      form.content([{ fieldId: "field:1", value: choice.options[2]!.id }]),
    ).toEqual({ choice: "  " });
    expect(() => normalize({ "": { type: "string", title: " " } })).toThrow(
      "field_label_invalid",
    );
  });

  it("normalizes every pinned property variant with defaults and preserves false, zero and omitted optional fields", () => {
    const form = normalize(
      {
        text: {
          type: "string",
          title: "Title",
          description: "Details",
          minLength: 2,
          maxLength: 10,
          default: "hello",
        },
        count: { type: "integer", minimum: 0, maximum: 5, default: 0 },
        amount: { type: "number", minimum: 0, maximum: 1 },
        enabled: { type: "boolean", default: false },
        choice: {
          type: "string",
          enum: ["native-a", "native-b"],
          enumNames: ["A", "B"],
          default: "native-b",
        },
        titled: {
          type: "string",
          oneOf: [
            { const: "one", title: "One" },
            { const: "two", title: "Two" },
          ],
        },
        multi: {
          type: "array",
          items: { type: "string", enum: ["x", "y"] },
          minItems: 1,
          maxItems: 2,
          default: ["x"],
        },
        titledMulti: {
          type: "array",
          items: {
            anyOf: [
              { const: "x", title: "Ex" },
              { const: "y", title: "Why" },
            ],
          },
        },
      },
      ["text", "count", "enabled"],
    );
    expect(form.fields.map((field) => field.input.kind)).toEqual([
      "text",
      "number",
      "number",
      "boolean",
      "single_choice",
      "single_choice",
      "multiple_choice",
      "multiple_choice",
    ]);
    expect(form.fields[4]!.input).toMatchObject({
      default: "field:4:option:1",
      options: [{ label: { text: "A" } }, { label: { text: "B" } }],
    });
    expect(
      form.content([
        { fieldId: "field:0", value: "Hi" },
        { fieldId: "field:1", value: 0 },
        { fieldId: "field:3", value: false },
        { fieldId: "field:4", value: "field:4:option:0" },
        { fieldId: "field:6", value: ["field:6:option:1"] },
      ]),
    ).toEqual({
      text: "Hi",
      count: 0,
      enabled: false,
      choice: "native-a",
      multi: ["y"],
    });
    expect(JSON.stringify(form.fields)).not.toContain("native-a");
  });
  it.each([
    [{ type: "string", minLength: 2, maxLength: 3 }, "a"],
    [{ type: "integer", minimum: 0, maximum: 2 }, 1.5],
    [{ type: "number", minimum: 0, maximum: 2 }, 3],
    [{ type: "boolean" }, "false"],
    [{ type: "string", format: "email" }, "not an email"],
    [{ type: "string", format: "date" }, "2026-02-30"],
    [{ type: "string", format: "uri" }, "not uri"],
    [{ type: "string", format: "date-time" }, "2026-01-01"],
    [{ type: "string", enum: ["one"] }, "one"],
    [
      { type: "array", items: { type: "string", enum: ["one"] }, minItems: 1 },
      [],
    ],
    [
      { type: "array", items: { type: "string", enum: ["one"] } },
      ["field:0:option:0", "field:0:option:0"],
    ],
  ])(
    "rejects invalid values against the native constraints",
    (property, value) => {
      const form = normalize({ field: property }, ["field"]);
      expect(() => form.content([{ fieldId: "field:0", value }])).toThrow(
        "response_invalid",
      );
    },
  );
  it("requires present fields, rejects unknown/repeated IDs, and permits empty required strings", () => {
    const form = normalize({ name: { type: "string" } }, ["name"]);
    expect(() => form.content([])).toThrow();
    expect(() => form.content([{ fieldId: "name", value: "x" }])).toThrow();
    expect(() =>
      form.content([
        { fieldId: "field:0", value: "x" },
        { fieldId: "field:0", value: "y" },
      ]),
    ).toThrow();
    expect(form.content([{ fieldId: "field:0", value: "" }])).toEqual({
      name: "",
    });
  });
  it.each([
    [{ field: { type: "string", minLength: 5, maxLength: 2 } }, []],
    [{ field: { type: "string", minLength: 65537 } }, ["field"]],
    [
      {
        field: {
          type: "array",
          items: { type: "string", enum: ["one"] },
          minItems: 2,
        },
      },
      ["field"],
    ],
    [{ field: { type: "integer", minimum: 0.2, maximum: 0.8 } }, ["field"]],
    [{ field: { type: "string", enum: ["x", "x"] } }, []],
    [{ field: { type: "string", enum: ["x"], default: "y" } }, []],
    [{ field: { type: "integer", default: 1.5 } }, []],
    [{ field: { type: "string" } }, ["absent"]],
    [{ field: { type: "string" } }, ["field", "field"]],
  ] as const)(
    "rejects unusable schemas before presenting a form",
    (properties, required) => {
      expect(() => normalize(properties, [...required])).toThrow();
    },
  );
  it("keeps zero-field requests empty for confirmation and rejects oversized forms", () => {
    expect(normalize({}).fields).toEqual([]);
    expect(() =>
      normalize(
        Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [String(i), { type: "string" }]),
        ),
      ),
    ).toThrow();
  });
});
