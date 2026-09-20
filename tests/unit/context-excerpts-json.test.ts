import { describe, expect, it } from "vitest";
import { parseStoredContextExcerpts } from "../../src/server/db/context-excerpts-json.js";
import { DomainError } from "../../src/server/domain/errors.js";

describe("stored context excerpts", () => {
  it.each(["not-json", "{}", '[{"id":"not-an-excerpt"}]'])(
    "maps corrupt persisted data to a bounded domain conflict: %s",
    (value) => {
      expect.assertions(3);
      try {
        parseStoredContextExcerpts(value);
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect(error).toMatchObject({
          code: "conflict",
          message: "The stored context excerpts are invalid.",
          retryable: false,
        });
        expect((error as Error & { cause?: unknown }).cause).toBeDefined();
      }
    },
  );
});
