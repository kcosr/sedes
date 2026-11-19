export const standardChatWidth = 768;
export const maximumChatWidth = 1152;
export const chatWidthGutters = 96;

export function chatWidthLimit(paneWidth: number): number {
  return Math.min(maximumChatWidth, Math.max(standardChatWidth, paneWidth - chatWidthGutters));
}
