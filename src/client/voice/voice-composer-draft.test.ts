import { describe, expect, it } from "vitest";
import { formatThreadReferenceText, splitThreadReferenceText } from "../../shared/thread-references.js";
import { prependVoiceToDraft } from "./voice-composer-draft.js";

describe("prependVoiceToDraft", () => {
  it("preserves structured references, attachment references and every draft field", () => {
    const references = [{ threadId: "a9e4eba8-e818-4cff-b4b8-5d99d5afbd5d", title: "Related discussion" }];
    const attachments = [{ id: "uploaded-attachment" }];
    const draft = {
      text: formatThreadReferenceText("```ts\n  const café = '你好';\n```\n", references),
      attachments,
      contextExcerpts: [{ id: "excerpt" }],
      taskReferences: [{ taskId: "task" }],
      selectedSkillId: "skill-review",
      revision: 12,
    };
    const combined = prependVoiceToDraft(draft, "Explain this");
    expect(splitThreadReferenceText(combined.text)).toEqual({
      text: "Explain this\n\n```ts\n  const café = '你好';\n```\n", references,
    });
    expect({ ...combined, text: draft.text }).toEqual(draft);
    expect(combined.attachments).toBe(attachments);
    expect(splitThreadReferenceText(draft.text).text).toBe("```ts\n  const café = '你好';\n```\n");
  });

  it("does not add a separator to an empty draft with references", () => {
    const references = [{ threadId: "a9e4eba8-e818-4cff-b4b8-5d99d5afbd5d", title: "Related discussion" }];
    const combined = prependVoiceToDraft({ text: formatThreadReferenceText("", references) }, "Send this");
    expect(splitThreadReferenceText(combined.text)).toEqual({ text: "Send this", references });
  });
});
