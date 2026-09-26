import type { BoundedDisplayText } from "../../shared/protocol/payload.js";
import { boundDisplayText, DEFAULT_PAYLOAD_LIMITS } from "../conversations/payload-policy.js";
import { pathForRemoteRoot } from "../execution/remote-path.js";

const MAXIMUM_DISPLAY_FILE_NAME_BYTES = 255;
// Controls and bidirectional formatting characters can disguise a name.
const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/gu;

/** Only a native path's final component reaches the browser, never its directory. */
export function displayFileName(nativePath: string): BoundedDisplayText | undefined {
  const name = pathForRemoteRoot(nativePath).basename(nativePath)
    .replace(UNSAFE_DISPLAY_CHARACTERS, "")
    .trim();
  return name
    ? boundDisplayText(name, { ...DEFAULT_PAYLOAD_LIMITS, maximumDisplayTextBytes: MAXIMUM_DISPLAY_FILE_NAME_BYTES })
    : undefined;
}
