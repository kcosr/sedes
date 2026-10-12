/** Initial subframe loads must come from the trusted packaged renderer. A
 * generated document cannot navigate itself, another frame, or a new window. */
export function allowsPageFrameNavigation(input: {
  readonly isMainFrame: boolean;
  readonly url: string;
  readonly initiatorUrl?: string;
}): boolean {
  if (input.isMainFrame) return true; // Existing runtime main-frame guard owns this case.
  try {
    const initiator = new URL(input.initiatorUrl ?? "");
    const destination = new URL(input.url);
    if (input.url === "about:srcdoc") {
      return (initiator.protocol === "http:" || initiator.protocol === "https:") &&
        initiator.username === "" && initiator.password === "" && initiator.search === "" &&
        /^\/page-render\/[A-Za-z0-9_-]{43}$/u.test(initiator.pathname);
    }
    return (
      initiator.protocol === "capacitor-electron:" &&
      initiator.hostname === "localhost" &&
      initiator.port === "" &&
      initiator.username === "" &&
      initiator.password === "" &&
      (destination.protocol === "http:" || destination.protocol === "https:") &&
      destination.username === "" &&
      destination.password === "" &&
      destination.search === "" &&
      /^\/page-render\/[A-Za-z0-9_-]{43}$/u.test(destination.pathname)
    );
  } catch {
    return false;
  }
}
