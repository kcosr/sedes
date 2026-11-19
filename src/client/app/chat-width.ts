export const standardChatWidth = 768;
export const chatWidthGutters = 96;

export function chatWidthLimit(paneWidth: number): number {
  return Math.max(standardChatWidth, paneWidth - chatWidthGutters);
}
