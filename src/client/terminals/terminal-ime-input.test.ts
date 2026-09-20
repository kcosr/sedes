import { describe, expect, it } from "vitest";
import {
  idleTerminalImeState,
  reduceTerminalImeState,
  shouldDeferBeforeInputToIme,
  textareaDelta,
} from "./terminal-ime-input.js";

describe("terminal IME input", () => {
  it("keeps preedit local and commits a composition exactly once", () => {
    let state = idleTerminalImeState();
    state = reduceTerminalImeState(state, {
      type: "compositionstart", data: "", textareaValue: "",
    }).state;
    state = reduceTerminalImeState(state, {
      type: "compositionupdate", data: "ni", textareaValue: "ni",
    }).state;
    const preedit = reduceTerminalImeState(state, {
      type: "input", data: "ni", inputType: "insertCompositionText",
      isComposing: true, textareaValue: "ni",
    });
    expect(preedit).toMatchObject({ output: null, suppressInput: true });
    expect(preedit.state).toMatchObject({ phase: "composing", preedit: "ni" });

    const committed = reduceTerminalImeState(preedit.state, {
      type: "compositionend", data: "你好", textareaValue: "你好",
    });
    expect(committed).toMatchObject({ output: "你好", clearTextarea: true });
    expect(shouldDeferBeforeInputToIme(committed.state, {
      data: "你好", inputType: "insertText", isComposing: false,
    })).toBe(true);
    expect(reduceTerminalImeState(committed.state, {
      type: "input", data: "你好", inputType: "insertText",
      isComposing: false, textareaValue: "你好",
    })).toMatchObject({ output: null, suppressInput: true });
  });

  it("suppresses canceled preedit replay without swallowing later text", () => {
    let state = reduceTerminalImeState(idleTerminalImeState(), {
      type: "compositionstart", data: "", textareaValue: "",
    }).state;
    state = reduceTerminalImeState(state, {
      type: "compositionupdate", data: "ni", textareaValue: "ni",
    }).state;
    state = reduceTerminalImeState(state, {
      type: "compositionend", data: "", textareaValue: "ni",
    }).state;
    const replay = reduceTerminalImeState(state, {
      type: "input", data: "ni", inputType: "insertText",
      isComposing: false, textareaValue: "ni",
    });
    expect(replay.suppressInput).toBe(true);
    const later = reduceTerminalImeState(replay.state, {
      type: "input", data: "x", inputType: "insertText",
      isComposing: false, textareaValue: "x",
    });
    expect(later.suppressInput).toBe(false);
  });

  it("derives Unicode-safe delete/insert deltas", () => {
    expect(textareaDelta("🙂a", "🙂b")).toBe("\x7fb");
    expect(textareaDelta("", "one\ntwo")).toBe("one\rtwo");
  });
});
