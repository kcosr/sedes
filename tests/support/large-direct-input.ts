import { MAX_DIRECT_INPUT_TEXT_BYTES } from "../../src/shared/protocol/thread-input.js";

// Include multibyte characters and significant leading/trailing whitespace so
// delivery, native history, and replay must preserve more than a character count.
const prefix = " \nRecording transcript: ";
const suffix = "\n \t";
const chunk = "é🙂\n";
const remaining = MAX_DIRECT_INPUT_TEXT_BYTES - Buffer.byteLength(prefix + suffix);
export const largeDirectInputText = prefix
  + chunk.repeat(Math.floor(remaining / Buffer.byteLength(chunk)))
  + "x".repeat(remaining % Buffer.byteLength(chunk))
  + suffix;
